//! Tauri commands the webviews call. Thin: parse arguments, hand the
//! input to the [`Agent`], return the new [`StateView`] or a
//! rejection code. All validation that matters (transition legality,
//! prompt options, note rules) lives in the core, never in the UI.
//!
//! Commands are synchronous, and none of them can open a window: the
//! prompt window is only created from the tick thread (see `agent`).
//! The exception is `sign_in`, which is async and runs the browser
//! round trip on a blocking worker, off the UI thread.

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, WebviewWindow};

use crate::agent::{parse_away_tag, parse_break_kind, rejection_code, Agent, StateView};
use crate::auth::{open_system_browser, AuthError, AuthManager, AuthStatus};
use crate::enroll::{self, EnrollError, Enroller, Enrollment, EnrollmentStatus};
use crate::keystore::{OsStore, Secrets};
use crate::machine::{CoreState, Input, PromptResponse};
use crate::policy::{self, FetchError, FetchOutcome, PolicyDoc};
use crate::recorder::{Recorder, Target};
use crate::sync::live::LiveSync;
use crate::sync::reqwest_client::TokenSource;

/// The app's sign-in manager (ADR-0002 §5).
pub type Auth = AuthManager<OsStore>;

/// Event carrying an [`AuthStatus`] after sign-in, sign-out, or the
/// silent start-up restore.
pub const AUTH_EVENT: &str = "cp://auth";

/// Event carrying an [`EnrollmentStatus`] whenever it changes.
pub const ENROLLMENT_EVENT: &str = "cp://enrollment";

/// How long the browser round trip may take.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

type CommandResult = Result<StateView, String>;

fn run(agent: &Agent, input: Input) -> CommandResult {
    agent
        .handle(input)
        .map_err(|r| rejection_code(&r).to_string())
}

/// Fixed width of the main window (logical px), from `tauri.conf.json`.
pub const MAIN_WIDTH: f64 = 420.0;
/// Never shrink below this, so the window stays usable.
pub const MIN_HEIGHT: f64 = 360.0;

/// Pure: clamp a requested content height to [MIN_HEIGHT, max].
/// `max` comes from the monitor's work area; non-finite input
/// (a broken measurement) falls back to MIN_HEIGHT.
pub fn clamp_height(requested: f64, max: f64) -> f64 {
    let max = if max.is_finite() {
        max.max(MIN_HEIGHT)
    } else {
        MIN_HEIGHT
    };
    if !requested.is_finite() {
        return MIN_HEIGHT;
    }
    requested.clamp(MIN_HEIGHT, max)
}

/// Resize the main window to fit its content. The webview measures
/// its own height and asks; the page gets no window permissions of its
/// own (least privilege).
#[tauri::command]
pub fn fit_window(window: WebviewWindow, height: f64) -> Result<(), String> {
    if window.label() != "main" {
        return Err("invalid_argument".to_string());
    }
    let max = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let scale = m.scale_factor();
            f64::from(m.work_area().size.height) / scale - 40.0
        })
        .unwrap_or(900.0);
    window
        .set_size(LogicalSize::new(MAIN_WIDTH, clamp_height(height, max)))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_state(agent: State<'_, Arc<Agent>>) -> StateView {
    agent.view()
}

/// Clocking in needs a signed-in user: every event is attributed to
/// one (2b.4). A definite "no" from enrollment (no employee, revoked
/// device, ...) blocks it too. So does a device that has never
/// enrolled here, because events can't be signed without the employee
/// id (F3c); once enrolled, the cached identity lets offline
/// clock-ins through and events wait in the outbox.
#[tauri::command]
pub fn clock_in(
    agent: State<'_, Arc<Agent>>,
    auth: State<'_, Arc<Auth>>,
    enrollment: State<'_, Arc<Enrollment>>,
    recorder: State<'_, Recorder>,
) -> CommandResult {
    if auth.oid().is_none() {
        return Err("not_signed_in".to_string());
    }
    if let Some(code) = enrollment.blocked() {
        return Err(code.to_string());
    }
    if !recorder.can_record() {
        return Err("not_enrolled".to_string());
    }
    run(&agent, Input::ClockIn)
}

#[tauri::command]
pub fn enrollment_status(enrollment: State<'_, Arc<Enrollment>>) -> EnrollmentStatus {
    enrollment.status()
}

/// Where outbox files live.
fn data_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    match app.path().app_data_dir() {
        Ok(dir) => Some(dir),
        Err(e) => {
            eprintln!("[cloudpunch] no app data folder: {e}");
            None
        }
    }
}

/// Arm the recorder with the identity an earlier enrollment cached, so
/// an offline launch can still record (F3c).
fn arm_from_cache(app: &AppHandle, oid: &str, recorder: &Recorder) {
    if recorder.is_armed() {
        return;
    }
    let Some(dir) = data_dir(app) else { return };
    match Target::from_cache(&dir, oid, &Secrets::new(OsStore)) {
        Ok(Some(target)) => {
            recorder.arm(target);
            eprintln!("[cloudpunch] recorder armed from cached identity");
            app.state::<Arc<Agent>>().restore_today();
        }
        Ok(None) => {}
        Err(e) => eprintln!("[cloudpunch] cached identity unavailable: {e}"),
    }
}

/// Start (or keep) the sync loop for `oid`'s outbox, sending with the
/// signed-in user's access token, refreshed as needed (F3c).
fn start_live_sync(
    app: &AppHandle,
    auth: &Arc<Auth>,
    base_url: &str,
    oid: &str,
    recorder: &Recorder,
) {
    let Some(dir) = data_dir(app) else { return };
    let key = match Secrets::new(OsStore).outbox_key(oid) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("[cloudpunch] sync not started: {e}");
            return;
        }
    };
    let token_auth = auth.clone();
    let token: TokenSource = Box::new(move || {
        token_auth
            .access_token(SystemTime::now())
            .map_err(|e| e.code().to_string())
    });
    let live = app.state::<LiveSync>();
    match live.start(
        oid,
        &Target::outbox_path(&dir, oid),
        &key,
        base_url,
        token,
        recorder.online_flag(),
    ) {
        Ok(()) => eprintln!("[cloudpunch] sync loop running"),
        Err(e) => eprintln!("[cloudpunch] sync not started: {e}"),
    }
}

/// The user whose policy loop is running, if any (one loop at a time).
static POLICY_LOOP: Mutex<Option<String>> = Mutex::new(None);

/// Keep `oid`'s policy current (ADR-0015 §5): apply the cached policy
/// at once, then fetch now and every 15 minutes with `If-None-Match`.
/// Ends when that user is no longer signed in.
fn start_policy_sync(
    app: &AppHandle,
    auth: &Arc<Auth>,
    base_url: &str,
    oid: &str,
    recorder: &Recorder,
) {
    {
        let mut running = POLICY_LOOP.lock().unwrap_or_else(|p| p.into_inner());
        if running.as_deref() == Some(oid) {
            return;
        }
        *running = Some(oid.to_string());
    }
    let agent = app.state::<Arc<Agent>>().inner().clone();
    let (auth, recorder) = (auth.clone(), recorder.clone());
    let (base_url, oid) = (base_url.to_string(), oid.to_string());
    let spawned = std::thread::Builder::new()
        .name("cp-policy".into())
        .spawn(move || {
            let mut known = None;
            match recorder.load_policy() {
                Ok(Some((version, text))) => match serde_json::from_str(&text) {
                    Ok(doc) => {
                        agent.apply_policy(&PolicyDoc::from_value(&doc), Some(version.clone()));
                        eprintln!("[cloudpunch] policy {version} applied from cache");
                        known = Some(version);
                    }
                    Err(e) => eprintln!("[cloudpunch] cached policy unreadable: {e}"),
                },
                Ok(None) => {}
                Err(e) => eprintln!("[cloudpunch] policy cache unavailable: {e}"),
            }
            let http = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest Client::builder is infallible for this config");
            while auth.oid().as_deref() == Some(oid.as_str()) {
                let mut wait = policy::REFRESH_EVERY;
                match auth.access_token(SystemTime::now()) {
                    Ok(token) => match policy::fetch(&http, &base_url, &token, known.as_deref()) {
                        Ok(FetchOutcome::NotModified) => {}
                        Ok(FetchOutcome::Updated(f)) => {
                            if let Err(e) =
                                recorder.save_policy(&f.version, &f.document.to_string())
                            {
                                eprintln!("[cloudpunch] policy not cached: {e}");
                            }
                            agent.apply_policy(
                                &PolicyDoc::from_value(&f.document),
                                Some(f.version.clone()),
                            );
                            eprintln!("[cloudpunch] policy {} applied", f.version);
                            known = Some(f.version);
                        }
                        Err(FetchError::Refused(e)) => {
                            eprintln!("[cloudpunch] policy refused ({e}); keeping the current one")
                        }
                        Err(FetchError::Unavailable(e)) => {
                            eprintln!("[cloudpunch] policy fetch will retry: {e}");
                            wait = Duration::from_secs(60);
                        }
                    },
                    Err(AuthError::NotSignedIn) => break,
                    Err(e) => {
                        eprintln!("[cloudpunch] policy fetch will retry: token {}", e.code());
                        wait = Duration::from_secs(60);
                    }
                }
                // Sleep in slices so a sign-out ends the loop promptly.
                let until = std::time::Instant::now() + wait;
                while std::time::Instant::now() < until
                    && auth.oid().as_deref() == Some(oid.as_str())
                {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            let mut running = POLICY_LOOP.lock().unwrap_or_else(|p| p.into_inner());
            if running.as_deref() == Some(oid.as_str()) {
                *running = None;
            }
        });
    if let Err(e) = spawned {
        eprintln!("[cloudpunch] policy thread failed to start: {e}");
        *POLICY_LOOP.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

/// Enrol this device for the signed-in user on a background thread,
/// retrying with backoff while the backend is unreachable. A newer
/// sign-in or a sign-out makes this attempt stop (generation check).
/// Arms the recorder from the cached identity first, then with the
/// fresh one once enrolled.
pub fn start_enrollment(
    app: &AppHandle,
    auth: Arc<Auth>,
    enrollment: Arc<Enrollment>,
    recorder: Recorder,
) {
    if let Some(oid) = auth.oid() {
        arm_from_cache(app, &oid, &recorder);
    }
    let generation = enrollment.reset();
    let emit = {
        let app = app.clone();
        let enrollment = enrollment.clone();
        move || {
            let _ = app.emit(ENROLLMENT_EVENT, enrollment.status());
        }
    };
    let Ok(base_url) = std::env::var(enroll::BACKEND_URL_ENV) else {
        eprintln!(
            "[cloudpunch] enrollment skipped: {} unset",
            enroll::BACKEND_URL_ENV
        );
        enrollment.set_not_configured(generation);
        // Local development without a backend: log events only.
        recorder.set_log_only();
        emit();
        return;
    };
    let dir = data_dir(app);
    // A cached identity can sync right away (offline launches catch up).
    if recorder.is_armed() {
        if let Some(oid) = auth.oid() {
            start_live_sync(app, &auth, &base_url, &oid, &recorder);
            start_policy_sync(app, &auth, &base_url, &oid, &recorder);
        }
    }
    let sync_app = app.clone();
    emit();
    let spawned = std::thread::Builder::new()
        .name("cp-enroll".into())
        .spawn(move || {
            let Some(hostname) = enroll::hostname() else {
                eprintln!("[cloudpunch] enrollment blocked: hostname");
                enrollment.record(generation, &Err(EnrollError::Hostname));
                emit();
                return;
            };
            let enroller = Enroller::new(OsStore, &base_url, hostname);
            for attempt in 0u32.. {
                let Some(oid) = auth.oid() else { return };
                let outcome = match auth.access_token(SystemTime::now()) {
                    Ok(token) => enroller.enroll(&oid, &token),
                    Err(AuthError::NotSignedIn) => return,
                    Err(e) => Err(EnrollError::Unavailable(format!("token: {}", e.code()))),
                };
                if !enrollment.record(generation, &outcome) {
                    return;
                }
                emit();
                match outcome {
                    Ok(identity) => {
                        eprintln!("[cloudpunch] device enrolled");
                        let Some(dir) = &dir else { return };
                        match Target::open(dir, identity, &Secrets::new(OsStore)) {
                            Ok(target) => {
                                recorder.arm(target);
                                sync_app.state::<Arc<Agent>>().restore_today();
                                start_live_sync(&sync_app, &auth, &base_url, &oid, &recorder);
                                start_policy_sync(&sync_app, &auth, &base_url, &oid, &recorder);
                            }
                            Err(e) => eprintln!("[cloudpunch] recorder not armed: {e}"),
                        }
                        return;
                    }
                    Err(e) if !e.is_transient() => {
                        eprintln!("[cloudpunch] enrollment blocked: {}", e.code());
                        return;
                    }
                    Err(e) => eprintln!("[cloudpunch] enrollment will retry: {e}"),
                }
                std::thread::sleep(enroll::retry_delay(attempt));
                if !enrollment.is_current(generation) {
                    return;
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("[cloudpunch] enrollment thread failed to start: {e}");
    }
}

#[tauri::command]
pub fn auth_status(auth: State<'_, Arc<Auth>>) -> AuthStatus {
    auth.status()
}

/// Interactive sign-in through the system browser.
#[tauri::command]
pub async fn sign_in(
    app: AppHandle,
    auth: State<'_, Arc<Auth>>,
    enrollment: State<'_, Arc<Enrollment>>,
    recorder: State<'_, Recorder>,
) -> Result<AuthStatus, String> {
    let auth = auth.inner().clone();
    let signing_in = auth.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        signing_in.sign_in(&open_system_browser, SIGN_IN_TIMEOUT)
    })
    .await
    .map_err(|_| "internal".to_string())?
    .map_err(|e| e.code().to_string())?;
    let _ = app.emit(AUTH_EVENT, &status);
    start_enrollment(
        &app,
        auth,
        enrollment.inner().clone(),
        recorder.inner().clone(),
    );
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(status)
}

/// Stop a sign-in waiting on the browser (e.g. the tab was closed).
#[tauri::command]
pub fn cancel_sign_in(auth: State<'_, Arc<Auth>>) {
    auth.cancel_sign_in();
}

/// How long sign-out waits for unsent events to go (the sync loop
/// sends every 5 s).
const SIGN_OUT_FLUSH: Duration = Duration::from_secs(6);

/// Sign out: only while clocked out, so no session is left open. Never
/// blocked by unsent time: if the outbox still holds events after a
/// short wait for the sync loop, they are **kept** with this user's
/// keys and sent the next time the same user signs in here (the
/// sign-in itself is removed). With nothing unsent, the outbox and its
/// key are deleted (ADR-0007 §5).
#[tauri::command]
pub async fn sign_out(
    app: AppHandle,
    agent: State<'_, Arc<Agent>>,
    auth: State<'_, Arc<Auth>>,
    enrollment: State<'_, Arc<Enrollment>>,
    recorder: State<'_, Recorder>,
) -> Result<AuthStatus, String> {
    if agent.state() != CoreState::ClockedOut {
        return Err("clock_out_first".to_string());
    }
    let (agent, auth, enrollment) = (
        agent.inner().clone(),
        auth.inner().clone(),
        enrollment.inner().clone(),
    );
    let recorder = recorder.inner().clone();
    let worker_app = app.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        sign_out_blocking(&worker_app, &agent, &auth, &enrollment, &recorder)
    })
    .await
    .map_err(|_| "internal".to_string())??;
    let _ = app.emit(AUTH_EVENT, &status);
    Ok(status)
}

fn sign_out_blocking(
    app: &AppHandle,
    agent: &Arc<Agent>,
    auth: &Arc<Auth>,
    enrollment: &Arc<Enrollment>,
    recorder: &Recorder,
) -> Result<AuthStatus, String> {
    // Give the sync loop a moment to send what's left (it keeps running
    // while online).
    let deadline = std::time::Instant::now() + SIGN_OUT_FLUSH;
    let mut unsent = recorder.unsent().unwrap_or(0);
    while unsent > 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        unsent = recorder.unsent().unwrap_or(unsent);
    }

    let oid = auth.oid();
    app.state::<LiveSync>().stop();
    recorder.disarm();
    // The next user starts from the defaults until their policy arrives,
    // with an empty day on screen.
    agent.apply_policy(&PolicyDoc::default(), None);
    agent.clear_timeline();

    if unsent > 0 {
        auth.sign_out_keeping_device()
            .map_err(|e| e.code().to_string())?;
        eprintln!("[cloudpunch] signed out; {unsent} unsent event(s) kept for the next sign-in");
    } else {
        auth.sign_out().map_err(|e| e.code().to_string())?;
        if let (Some(oid), Some(dir)) = (oid, data_dir(app)) {
            let path = Target::outbox_path(&dir, &oid);
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("[cloudpunch] could not delete the outbox: {e}");
                }
            }
        }
        eprintln!("[cloudpunch] signed out");
    }
    enrollment.reset();
    let _ = app.emit(ENROLLMENT_EVENT, enrollment.status());
    let mut status = auth.status();
    status.unsent_kept = (unsent > 0).then_some(unsent);
    Ok(status)
}

/// Close dialog: "Keep running in tray" (ADR-0013 §1).
#[tauri::command]
pub fn hide_to_tray(window: WebviewWindow, agent: State<'_, Arc<Agent>>) -> Result<(), String> {
    if window.label() != "main" {
        return Err("invalid_argument".to_string());
    }
    window.hide().map_err(|e| e.to_string())?;
    agent.notice_hidden_to_tray();
    Ok(())
}

/// Close dialog: "Quit" — only while clocked out; clocked in must use
/// "Clock out & quit" so no session is left open.
#[tauri::command]
pub fn quit_app(app: AppHandle, agent: State<'_, Arc<Agent>>) -> Result<(), String> {
    if agent.state() != CoreState::ClockedOut {
        return Err("clock_out_first".to_string());
    }
    app.exit(0);
    Ok(())
}

/// Close dialog: "Clock out & quit".
#[tauri::command]
pub fn clock_out_and_quit(app: AppHandle, agent: State<'_, Arc<Agent>>) -> Result<(), String> {
    if agent.state() != CoreState::ClockedOut {
        run(&agent, Input::ClockOut)?;
    }
    app.exit(0);
    Ok(())
}

/// Long-shift banner: "Still working" (ADR-0013 §5).
#[tauri::command]
pub fn ack_long_shift(agent: State<'_, Arc<Agent>>) -> StateView {
    agent.ack_long_shift()
}

#[tauri::command]
pub fn clock_out(agent: State<'_, Arc<Agent>>) -> CommandResult {
    run(&agent, Input::ClockOut)
}

#[tauri::command]
pub fn start_break(agent: State<'_, Arc<Agent>>, kind: String) -> CommandResult {
    let kind = parse_break_kind(&kind).ok_or_else(|| "invalid_argument".to_string())?;
    run(&agent, Input::StartBreak(kind))
}

#[tauri::command]
pub fn end_break(agent: State<'_, Arc<Agent>>) -> CommandResult {
    run(&agent, Input::EndBreak)
}

/// Voluntary away tag: `meeting` (ADR-0011 §2).
#[tauri::command]
pub fn mark_away(
    agent: State<'_, Arc<Agent>>,
    reason: String,
    note: Option<String>,
) -> CommandResult {
    let reason = parse_away_tag(&reason).ok_or_else(|| "invalid_argument".to_string())?;
    run(&agent, Input::MarkAway { reason, note })
}

#[tauri::command]
pub fn mark_back(agent: State<'_, Arc<Agent>>) -> CommandResult {
    run(&agent, Input::MarkBack)
}

#[tauri::command]
pub fn respond_to_prompt(
    agent: State<'_, Arc<Agent>>,
    response: String,
    note: Option<String>,
) -> CommandResult {
    let response =
        PromptResponse::from_wire(&response).ok_or_else(|| "invalid_argument".to_string())?;
    run(&agent, Input::RespondToPrompt { response, note })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_height_bounds() {
        assert_eq!(clamp_height(500.0, 900.0), 500.0);
        assert_eq!(clamp_height(100.0, 900.0), MIN_HEIGHT);
        assert_eq!(clamp_height(2_000.0, 900.0), 900.0);
    }

    #[test]
    fn clamp_height_survives_bad_input() {
        assert_eq!(clamp_height(f64::NAN, 900.0), MIN_HEIGHT);
        assert_eq!(clamp_height(f64::INFINITY, 900.0), MIN_HEIGHT);
        assert_eq!(clamp_height(500.0, f64::NAN), MIN_HEIGHT);
        // A tiny screen never pushes max below the minimum.
        assert_eq!(clamp_height(500.0, 200.0), MIN_HEIGHT);
    }
}
