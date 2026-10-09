//! Tauri commands the webviews call. Thin: parse arguments, hand the
//! input to the [`Agent`], return the new [`StateView`] or a
//! rejection code. All validation that matters (transition legality,
//! prompt options, note rules) lives in the core, never in the UI.
//!
//! Commands are synchronous, and none of them can open a window: the
//! prompt window is only created from the tick thread (see `agent`).
//! The exception is `sign_in`, which is async and runs the browser
//! round trip on a blocking worker, off the UI thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, WebviewWindow};

use crate::active_device::{self, Action, BlockedView, CheckError};
use crate::admin;
use crate::agent::{
    parse_away_tag, parse_break_kind, parse_planned_minutes, rejection_code, Agent, StateView,
};
use crate::auth::{open_system_browser, AuthError, AuthManager, AuthStatus};
use crate::backend_http;
use crate::days::{self, DayCache, DayError};
use crate::enroll::{self, EnrollError, Enroller, Enrollment, EnrollmentStatus};
use crate::keystore::{OsStore, Secrets};
use crate::machine::{CoreState, IdleExplanation, Input, PromptResponse};
use crate::policy::{self, FetchError, FetchOutcome, PolicyDoc};
use crate::recorder::{Recorder, Target};
use crate::strip::{self, Pin};
use crate::sync::live::LiveSync;
use crate::sync::reqwest_client::TokenSource;
use crate::sync::{Notify, SyncNotice};

/// The app's sign-in manager (ADR-0002 §5).
pub type Auth = AuthManager<OsStore>;

/// Event carrying an [`AuthStatus`] after sign-in, sign-out, or the
/// silent start-up restore.
pub const AUTH_EVENT: &str = "cp://auth";

/// Event carrying an [`EnrollmentStatus`] whenever it changes.
pub const ENROLLMENT_EVENT: &str = "cp://enrollment";

/// How long the browser round trip may take.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

/// `AuthStatus.notice` after an admin signed this computer out
/// (ADR-0028 §4).
pub const SIGNED_OUT_BY_ADMIN: &str = "signed_out_by_admin";

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

/// Pure: the tallest the full window may grow on a work area this
/// tall — about 70% of it, never under 560 px (small screens), never
/// past the work area. Beyond it the details scroll.
pub fn max_height(work_area: f64) -> f64 {
    (work_area * 0.7).max(560.0).min(work_area - 40.0)
}

/// Resize the main window to fit its content. The webview measures
/// its own height and asks; the page gets no window permissions of its
/// own (least privilege). Pinned, the strip's width and limits apply.
#[tauri::command]
pub fn fit_window(window: WebviewWindow, pin: State<'_, Pin>, height: f64) -> Result<(), String> {
    if window.label() != "main" {
        return Err("invalid_argument".to_string());
    }
    let size = if pin.is_pinned() {
        LogicalSize::new(strip::STRIP_WIDTH, strip::clamp_strip_height(height))
    } else {
        let max = window
            .current_monitor()
            .ok()
            .flatten()
            .map(|m| max_height(f64::from(m.work_area().size.height) / m.scale_factor()))
            .unwrap_or(900.0);
        LogicalSize::new(MAIN_WIDTH, clamp_height(height, max))
    };
    window.set_size(size).map_err(|e| e.to_string())
}

/// Pin the main window as the mini strip (ADR-0017). Needs a signed-in
/// user: signed out there is nothing to show on it.
#[tauri::command]
pub fn pin_window(
    window: WebviewWindow,
    pin: State<'_, Pin>,
    auth: State<'_, Arc<Auth>>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("invalid_argument".to_string());
    }
    if auth.oid().is_none() {
        return Err("not_signed_in".to_string());
    }
    pin.pin(&window).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Back to the full window.
#[tauri::command]
pub fn unpin_window(window: WebviewWindow, pin: State<'_, Pin>) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("invalid_argument".to_string());
    }
    pin.unpin(&window).map_err(|e| e.to_string())?;
    Ok(false)
}

/// Whether the main window is the strip (after a webview reload).
#[tauri::command]
pub fn pin_status(pin: State<'_, Pin>) -> bool {
    pin.is_pinned()
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

/// Clock in from when the person signed in to the computer
/// (ADR-0018 §4). Same gates as `clock_in`.
#[tauri::command]
pub fn clock_in_from_sign_in(
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
    agent
        .clock_in_from_sign_in()
        .map_err(|r| rejection_code(&r).to_string())
}

/// "Not now" on the daily clock-in popup.
#[tauri::command]
pub fn dismiss_clock_in_prompt(agent: State<'_, Arc<Agent>>) -> StateView {
    agent.dismiss_clock_in_prompt()
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

/// Today's history from the server when there's none on screen (after
/// a sign-out, or on another computer), or only the session running now
/// (clocked in before this ran, e.g. right after an update). Fetches yesterday's and today's
/// day views (a night shift may be dated yesterday); the agent keeps
/// only the current working day. Offline or refused: the day starts
/// empty, as before.
fn restore_today_from_server(app: &AppHandle, auth: &Arc<Auth>, base_url: &str) {
    let agent = app.state::<Arc<Agent>>();
    if !agent.lacks_history() {
        return;
    }
    let Ok(token) = auth.access_token(SystemTime::now()) else {
        return;
    };
    let Ok(http) = backend_http::client_builder()
        .timeout(Duration::from_secs(15))
        .build()
    else {
        return;
    };
    let today = chrono::Local::now().date_naive();
    let mut fetched = Vec::new();
    for date in [today - chrono::Duration::days(1), today] {
        let date = date.format("%Y-%m-%d").to_string();
        match days::fetch(&http, base_url, &token, &date) {
            Ok(day) => fetched.push(day),
            Err(e) => eprintln!("[cloudpunch] today's history not fetched ({date}): {e:?}"),
        }
    }
    if let Some(json) = days::journal_from_days(&fetched) {
        agent.restore_today_from_server(&json);
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
    let notice_app = app.clone();
    let notice_oid = oid.to_string();
    let notify: Notify = Box::new(move |n| on_sync_notice(&notice_app, &notice_oid, n));
    let live = app.state::<LiveSync>();
    match live.start(
        oid,
        &Target::outbox_path(&dir, oid),
        &key,
        base_url,
        token,
        recorder.online_flag(),
        notify,
    ) {
        Ok(()) => eprintln!("[cloudpunch] sync loop running"),
        Err(e) => eprintln!("[cloudpunch] sync not started: {e}"),
    }
}

/// A batch's answer the app must act on (ADR-0028). Runs on the sync
/// thread, so anything that stops the sync loop (sign-out) or waits on
/// the network moves to a thread of its own.
fn on_sync_notice(app: &AppHandle, oid: &str, notice: SyncNotice) {
    match notice {
        SyncNotice::DeviceSignedOut => {
            eprintln!("[cloudpunch] an admin signed this computer out");
            spawn_admin_sign_out(app, oid);
        }
        SyncNotice::MultiDeviceConflict {
            session_id,
            opened_at,
        } => {
            let (app, oid) = (app.clone(), oid.to_string());
            let spawned = std::thread::Builder::new()
                .name("cp-conflict".into())
                .spawn(move || refused_elsewhere(&app, &oid, &session_id, opened_at.as_deref()));
            if let Err(e) = spawned {
                eprintln!("[cloudpunch] conflict thread failed to start: {e}");
            }
        }
    }
}

/// The server refused this computer's session: the person is clocked in
/// on another one (ADR-0028 §3). Back to clocked out without a clock-out
/// event (the rows are already set aside), show the blocked screen, and
/// ask the server for the details (the other computer's OS), which may
/// also find it has clocked out since.
fn refused_elsewhere(app: &AppHandle, oid: &str, session_id: &str, opened_at: Option<&str>) {
    let auth = app.state::<Arc<Auth>>().inner().clone();
    if auth.oid().as_deref() != Some(oid) {
        return;
    }
    let agent = app.state::<Arc<Agent>>().inner().clone();
    if agent.abandon_session(Some(session_id)) {
        eprintln!("[cloudpunch] clock-in refused: clocked in on another computer");
    }
    if !agent.is_blocked() {
        agent.set_blocked(Some(BlockedView::from_conflict(opened_at)), true);
    }
    let device_id = app.state::<Recorder>().device_id();
    if let (Some(base_url), Some(device_id)) = (backend_http::base_url(), device_id) {
        let _ = active_device_check(app, &auth, &base_url, oid, &device_id, true);
    }
}

/// Ask the server whether this person is clocked in elsewhere, or this
/// computer was signed out by an admin, and act on it (ADR-0028). Any
/// failure changes nothing (fail open); the caller decides what to say.
fn active_device_check(
    app: &AppHandle,
    auth: &Arc<Auth>,
    base_url: &str,
    oid: &str,
    device_id: &str,
    show: bool,
) -> Result<Action, CheckError> {
    let token = auth.access_token(SystemTime::now()).map_err(|e| match e {
        AuthError::NotSignedIn => CheckError::Refused("not_signed_in".into()),
        e => CheckError::Unavailable(format!("token {}", e.code())),
    })?;
    if auth.oid().as_deref() != Some(oid) {
        return Ok(Action::Keep);
    }
    let http = backend_http::client_builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| CheckError::Unavailable(e.to_string()))?;
    let answer = active_device::check(&http, base_url, &token, device_id);
    if let Err(e) = &answer {
        eprintln!("[cloudpunch] active-device check not answered ({e:?}); not blocking");
    }
    let agent = app.state::<Arc<Agent>>().inner().clone();
    let action = active_device::decide(&answer, device_id, agent.clocked_out());
    match &action {
        Action::Keep => {}
        Action::Block(b) => {
            eprintln!("[cloudpunch] clocked in on another computer: clock-in blocked");
            agent.set_blocked(Some(b.clone()), show);
        }
        Action::Unblock => agent.set_blocked(None, false),
        Action::SignOut => {
            eprintln!("[cloudpunch] an admin signed this computer out");
            spawn_admin_sign_out(app, oid);
        }
    }
    answer.map(|_| action)
}

/// One admin sign-out at a time (the sync loop and the poll may both
/// hear about it).
static ADMIN_SIGN_OUT: AtomicBool = AtomicBool::new(false);

/// Sign out locally because an admin signed this computer out
/// (ADR-0028 §4), off the calling thread: it stops the sync loop, which
/// may be the caller.
fn spawn_admin_sign_out(app: &AppHandle, oid: &str) {
    if ADMIN_SIGN_OUT.swap(true, Ordering::AcqRel) {
        return;
    }
    let (app, oid) = (app.clone(), oid.to_string());
    let spawned = std::thread::Builder::new()
        .name("cp-signed-out".into())
        .spawn(move || {
            signed_out_by_admin(&app, &oid);
            ADMIN_SIGN_OUT.store(false, Ordering::Release);
        });
    if let Err(e) = spawned {
        ADMIN_SIGN_OUT.store(false, Ordering::Release);
        eprintln!("[cloudpunch] sign-out thread failed to start: {e}");
    }
}

/// Works while clocked in: the server already closed the session, so no
/// clock-out is recorded (it would be refused). Unsent events are kept
/// for the next sign-in here, as at any sign-out.
fn signed_out_by_admin(app: &AppHandle, oid: &str) {
    let auth = app.state::<Arc<Auth>>().inner().clone();
    if auth.oid().as_deref() != Some(oid) {
        return;
    }
    let agent = app.state::<Arc<Agent>>().inner().clone();
    let enrollment = app.state::<Arc<Enrollment>>().inner().clone();
    let recorder = app.state::<Recorder>().inner().clone();
    agent.abandon_session(None);
    match sign_out_blocking(app, &agent, &auth, &enrollment, &recorder, false) {
        Ok(mut status) => {
            status.notice = Some(SIGNED_OUT_BY_ADMIN);
            let _ = app.emit(AUTH_EVENT, &status);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        Err(e) => eprintln!("[cloudpunch] sign-out after an admin's request failed: {e}"),
    }
}

/// "Check again" on the blocked screen (ADR-0028 §2). Unlike the
/// automatic checks, an unanswered one keeps the block and says so.
#[tauri::command]
pub async fn check_active_device(
    app: AppHandle,
    auth: State<'_, Arc<Auth>>,
    enrollment: State<'_, Arc<Enrollment>>,
    recorder: State<'_, Recorder>,
) -> CommandResult {
    let base_url = backend_http::base_url().ok_or_else(|| "not_configured".to_string())?;
    let oid = auth.oid().ok_or_else(|| "not_signed_in".to_string())?;
    let device_id = enrollment
        .identity()
        .map(|i| i.device_id)
        .or_else(|| recorder.device_id())
        .ok_or_else(|| "not_enrolled".to_string())?;
    let auth = auth.inner().clone();
    let worker = app.clone();
    let checked = tauri::async_runtime::spawn_blocking(move || {
        active_device_check(&worker, &auth, &base_url, &oid, &device_id, false)
    })
    .await
    .map_err(|_| "internal".to_string())?;
    match checked {
        Ok(_) => Ok(app.state::<Arc<Agent>>().view()),
        Err(CheckError::Unavailable(_)) => Err("offline".to_string()),
        Err(CheckError::Refused(code)) => Err(code),
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
    let enrollment = app.state::<Arc<Enrollment>>().inner().clone();
    let check_app = app.clone();
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
            let http = backend_http::client_builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest Client::builder is infallible for this config");
            while auth.oid().as_deref() == Some(oid.as_str()) {
                let mut wait = policy::REFRESH_EVERY;
                // The shift rides along (ADR-0031); a failure keeps the
                // one we have.
                if let Ok(token) = auth.access_token(SystemTime::now()) {
                    match crate::shift::fetch(&http, &base_url, &token) {
                        Ok(info) => agent.apply_shift(info),
                        Err(e) => crate::applog::write(
                            &check_app,
                            crate::agent::POPUP_LOG,
                            &format!("shift not fetched: {e:?}"),
                        ),
                    }
                }
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
                // Same cadence (ADR-0028 §4): signed out by an admin, or
                // clocked in elsewhere meanwhile? Only once enrolled in
                // this sign-in, so a flag the enrolment clears can't sign
                // out someone who just signed in.
                if let Some(identity) = enrollment.identity() {
                    let _ = active_device_check(
                        &check_app,
                        &auth,
                        &base_url,
                        &oid,
                        &identity.device_id,
                        true,
                    );
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
///
/// ADR-0028: once enrolled, asks whether the person is clocked in on
/// another computer. `silent` (the start-up sign-in from the stored
/// session) first asks whether an admin signed this computer out while
/// it was off, before enrolling again.
pub fn start_enrollment(
    app: &AppHandle,
    auth: Arc<Auth>,
    enrollment: Arc<Enrollment>,
    recorder: Recorder,
    silent: bool,
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
    let Some(base_url) = backend_http::base_url() else {
        eprintln!(
            "[cloudpunch] enrollment skipped: {} unset",
            backend_http::BACKEND_URL_ENV
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
            // Switched off when an admin signed it out: it signs out
            // now, when it's next switched on (ADR-0028 §4).
            if let (true, Some(oid), Some(device_id)) = (silent, auth.oid(), recorder.device_id()) {
                let checked =
                    active_device_check(&sync_app, &auth, &base_url, &oid, &device_id, true);
                if checked == Ok(Action::SignOut) {
                    return;
                }
            }
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
                        let identity_device_id = identity.device_id.clone();
                        let Some(dir) = &dir else { return };
                        match Target::open(dir, identity, &Secrets::new(OsStore)) {
                            Ok(target) => {
                                recorder.arm(target);
                                sync_app.state::<Arc<Agent>>().restore_today();
                                // Signed in again today: the journal went
                                // at sign-out, the server still has the day.
                                restore_today_from_server(&sync_app, &auth, &base_url);
                                // Clocked in on another computer (ADR-0028 §2)?
                                let checked = active_device_check(
                                    &sync_app,
                                    &auth,
                                    &base_url,
                                    &oid,
                                    &identity_device_id,
                                    true,
                                );
                                if checked == Ok(Action::SignOut) {
                                    return;
                                }
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
        false,
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

/// Sign out: only while clocked out, so no session is left open, unless
/// `clock_out` asks to clock out first ("Clock out and sign out", owner
/// request 2026-09-30): a normal USER_CLOCK_OUT, then the usual wait for
/// the sync loop to send it. Never
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
    clock_out: Option<bool>,
) -> Result<AuthStatus, String> {
    if agent.state() != CoreState::ClockedOut {
        if clock_out != Some(true) {
            return Err("clock_out_first".to_string());
        }
        run(&agent, Input::ClockOut)?;
    }
    let (agent, auth, enrollment) = (
        agent.inner().clone(),
        auth.inner().clone(),
        enrollment.inner().clone(),
    );
    let recorder = recorder.inner().clone();
    let worker_app = app.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        sign_out_blocking(&worker_app, &agent, &auth, &enrollment, &recorder, true)
    })
    .await
    .map_err(|_| "internal".to_string())??;
    let _ = app.emit(AUTH_EVENT, &status);
    Ok(status)
}

/// `flush`: first give the sync loop a moment to send what's left
/// (not after an admin's sign-out: the server refuses it all now).
fn sign_out_blocking(
    app: &AppHandle,
    agent: &Arc<Agent>,
    auth: &Arc<Auth>,
    enrollment: &Arc<Enrollment>,
    recorder: &Recorder,
    flush: bool,
) -> Result<AuthStatus, String> {
    // Give the sync loop a moment to send what's left (it keeps running
    // while online).
    let deadline = std::time::Instant::now() + SIGN_OUT_FLUSH;
    let mut unsent = recorder.unsent().unwrap_or(0);
    while flush && unsent > 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        unsent = recorder.unsent().unwrap_or(unsent);
    }

    let oid = auth.oid();
    app.state::<LiveSync>().stop();
    app.state::<DayCache>().clear();
    // The strip is for a signed-in user: back to the full window.
    if let Some(w) = app.get_webview_window("main") {
        if let Err(e) = app.state::<Pin>().unpin(&w) {
            eprintln!("[cloudpunch] could not unpin at sign-out: {e}");
        }
    }
    recorder.disarm();
    // The next user starts from the defaults until their policy arrives,
    // with an empty day on screen.
    agent.apply_policy(&PolicyDoc::default(), None);
    agent.clear_timeline();
    // The next sign-in asks the server again (ADR-0028).
    agent.set_blocked(None, false);

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

/// One past working day for the home screen (ADR-0016).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayResult {
    /// The backend's `GET /v1/me/days/{date}` body, unchanged.
    day: serde_json::Value,
    /// This computer's device id, to label sessions recorded elsewhere.
    this_device: Option<String>,
    /// The backend couldn't be reached; this is the copy fetched earlier.
    stale: bool,
}

/// Fetch the signed-in user's working day `date` (`YYYY-MM-DD`). Falls
/// back to the copy fetched earlier this run when offline; with none,
/// fails with `offline`.
#[tauri::command]
pub async fn get_day(
    auth: State<'_, Arc<Auth>>,
    recorder: State<'_, Recorder>,
    cache: State<'_, DayCache>,
    date: String,
) -> Result<DayResult, String> {
    if !days::valid_date(&date) {
        return Err("invalid_argument".to_string());
    }
    let this_device = recorder.device_id();
    let fetch_date = date.clone();
    let (oid, fetched) = fetch_as_user(&auth, move |http, base_url, token| {
        days::fetch(http, base_url, token, &fetch_date)
    })
    .await?;
    match fetched {
        Ok(day) => {
            cache.put(&oid, &date, day.clone());
            Ok(DayResult {
                day,
                this_device,
                stale: false,
            })
        }
        Err(DayError::Unavailable(e)) => {
            eprintln!("[cloudpunch] day {date} not fetched: {e}");
            cache
                .get(&oid, &date)
                .map(|day| DayResult {
                    day,
                    this_device,
                    stale: true,
                })
                .ok_or_else(|| "offline".to_string())
        }
        Err(DayError::Refused(code)) => Err(code),
    }
}

/// The day picker's totals (ADR-0016).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaysResult {
    /// The backend's `GET /v1/me/days?from&to` body, unchanged.
    days: serde_json::Value,
    /// The backend couldn't be reached; this is the copy fetched earlier.
    stale: bool,
}

/// Totals per working day from `from` to `to` (`YYYY-MM-DD`, at most
/// 31 days) for the day picker. Offline, the same range fetched earlier
/// this run; with none, fails with `offline`.
#[tauri::command]
pub async fn get_days(
    auth: State<'_, Arc<Auth>>,
    cache: State<'_, DayCache>,
    from: String,
    to: String,
) -> Result<DaysResult, String> {
    if !days::valid_date(&from) || !days::valid_date(&to) || to < from {
        return Err("invalid_argument".to_string());
    }
    let key = days::range_key(&from, &to);
    let (oid, fetched) = fetch_as_user(&auth, move |http, base_url, token| {
        days::fetch_range(http, base_url, token, &from, &to)
    })
    .await?;
    match fetched {
        Ok(days) => {
            cache.put(&oid, &key, days.clone());
            Ok(DaysResult { days, stale: false })
        }
        Err(DayError::Unavailable(e)) => {
            eprintln!("[cloudpunch] days {key} not fetched: {e}");
            cache
                .get(&oid, &key)
                .map(|days| DaysResult { days, stale: true })
                .ok_or_else(|| "offline".to_string())
        }
        Err(DayError::Refused(code)) => Err(code),
    }
}

/// A backend answer as a command result: `offline`, or the server's code.
fn answer(fetched: Result<serde_json::Value, DayError>) -> Result<serde_json::Value, String> {
    fetched.map_err(|e| match e {
        DayError::Unavailable(why) => {
            eprintln!("[cloudpunch] admin call not answered: {why}");
            "offline".to_string()
        }
        DayError::Refused(code) => code,
    })
}

/// The signed-in user's capabilities (`GET /v1/me`), to decide whether
/// to offer Settings. The server re-checks every admin call.
#[tauri::command]
pub async fn my_capabilities(auth: State<'_, Arc<Auth>>) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, admin::capabilities).await?;
    answer(fetched)
}

/// Departments for the HR settings picker.
#[tauri::command]
pub async fn admin_departments(auth: State<'_, Arc<Auth>>) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, admin::departments).await?;
    answer(fetched)
}

/// A scope's override and what it resolves to (ADR-0018 §5).
#[tauri::command]
pub async fn admin_policy_get(
    auth: State<'_, Arc<Auth>>,
    scope: String,
    id: Option<String>,
) -> Result<serde_json::Value, String> {
    let scope =
        admin::Scope::parse(&scope, id.as_deref()).ok_or_else(|| "invalid_argument".to_string())?;
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::get_policy(http, base, token, &scope)
    })
    .await?;
    answer(fetched)
}

/// People (ADR-0020): everyone with a CloudPunch role.
#[tauri::command]
pub async fn admin_people(auth: State<'_, Arc<Auth>>) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, admin::people).await?;
    answer(fetched)
}

/// Team today (ADR-0025).
#[tauri::command]
pub async fn team_now(auth: State<'_, Arc<Auth>>) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, admin::team_now).await?;
    answer(fetched)
}

/// One team member's day (audited server-side).
#[tauri::command]
pub async fn team_day(
    auth: State<'_, Arc<Auth>>,
    employee_id: String,
    date: String,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::team_day(http, base, token, &employee_id, &date)
    })
    .await?;
    answer(fetched)
}

/// One person's day totals over `[from, to]` (the person screen's
/// Earlier list). Audited server-side.
#[tauri::command]
pub async fn team_days(
    auth: State<'_, Arc<Auth>>,
    employee_id: String,
    from: String,
    to: String,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::team_days(http, base, token, &employee_id, &from, &to)
    })
    .await?;
    answer(fetched)
}

/// Ask to correct your own time (`employeeId` absent), or, as their
/// manager, correct a report's (ADR-0030 §3).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn request_correction(
    auth: State<'_, Arc<Auth>>,
    employee_id: Option<String>,
    from: String,
    to: String,
    tz_iana: String,
    kind: String,
    reason: String,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        let c = admin::CorrectionRequest {
            from: &from,
            to: &to,
            tz_iana: &tz_iana,
            kind: &kind,
            reason: &reason,
        };
        admin::request_correction(http, base, token, employee_id.as_deref(), &c)
    })
    .await?;
    answer(fetched)
}

/// Everyone's current shift (Administrators, ADR-0031 §1).
#[tauri::command]
pub async fn admin_shifts(auth: State<'_, Arc<Auth>>) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, admin::shifts).await?;
    answer(fetched)
}

/// Set or clear someone's shift. `days`: ISO weekdays, empty clears.
#[tauri::command]
pub async fn admin_set_shift(
    auth: State<'_, Arc<Auth>>,
    employee_id: String,
    days: Vec<u8>,
    start: Option<String>,
    end: Option<String>,
    tz_iana: String,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "days": days,
        "start": start,
        "end": end,
        "tz_iana": tz_iana,
    });
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::set_shift(http, base, token, &employee_id, &body)
    })
    .await?;
    answer(fetched)
}

/// Corrections waiting on the signed-in user.
#[tauri::command]
pub async fn corrections_queue(auth: State<'_, Arc<Auth>>) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, admin::corrections_queue).await?;
    answer(fetched)
}

/// Endorse, approve, reject or withdraw a correction.
#[tauri::command]
pub async fn decide_correction(
    auth: State<'_, Arc<Auth>>,
    id: String,
    decision: String,
    note: Option<String>,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::decide_correction(http, base, token, &id, &decision, note.as_deref())
    })
    .await?;
    answer(fetched)
}

/// Exceptions for the team, or one person.
#[tauri::command]
pub async fn team_exceptions(
    auth: State<'_, Arc<Auth>>,
    from: String,
    to: String,
    employee_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::team_exceptions(http, base, token, &from, &to, employee_id.as_deref())
    })
    .await?;
    answer(fetched)
}

/// People: everyone with their reporting manager.
#[tauri::command]
pub async fn admin_employees(auth: State<'_, Arc<Auth>>) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, admin::employees).await?;
    answer(fetched)
}

/// People: set or clear someone's manager (audited server-side).
#[tauri::command]
pub async fn admin_set_manager(
    auth: State<'_, Arc<Auth>>,
    employee_id: String,
    manager_id: Option<String>,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::set_manager(
            http,
            base,
            token,
            &employee_id,
            manager_id.as_deref(),
            reason.as_deref(),
        )
    })
    .await?;
    answer(fetched)
}

/// Your own connection history (ADR-0029 §5).
#[tauri::command]
pub async fn my_connections(auth: State<'_, Arc<Auth>>) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, admin::my_connections).await?;
    answer(fetched)
}

/// Each person's latest connection (audited server-side).
#[tauri::command]
pub async fn team_connections(auth: State<'_, Arc<Auth>>) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, admin::team_connections).await?;
    answer(fetched)
}

/// One person's connection history (audited server-side).
#[tauri::command]
pub async fn person_connections(
    auth: State<'_, Arc<Auth>>,
    employee_id: String,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::person_connections(http, base, token, &employee_id)
    })
    .await?;
    answer(fetched)
}

/// Versions: every device and the app version it runs.
#[tauri::command]
pub async fn admin_devices(auth: State<'_, Arc<Auth>>) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, admin::devices).await?;
    answer(fetched)
}

/// People: search the company directory (2+ characters).
#[tauri::command]
pub async fn admin_people_search(
    auth: State<'_, Arc<Auth>>,
    q: String,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::people_search(http, base, token, &q)
    })
    .await?;
    answer(fetched)
}

/// People: set exactly these roles for one person. Audited server-side.
#[tauri::command]
pub async fn admin_people_set_roles(
    auth: State<'_, Arc<Auth>>,
    oid: String,
    roles: Vec<String>,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::people_set_roles(http, base, token, &oid, &roles, reason.as_deref())
    })
    .await?;
    answer(fetched)
}

/// Welcome email (ADR-0021): preview for one person.
#[tauri::command]
pub async fn admin_welcome_preview(
    auth: State<'_, Arc<Auth>>,
    oid: String,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::welcome_preview(http, base, token, &oid)
    })
    .await?;
    answer(fetched)
}

/// Welcome email: send it. Audited server-side.
#[tauri::command]
pub async fn admin_welcome_send(
    auth: State<'_, Arc<Auth>>,
    oid: String,
    note: Option<String>,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::welcome_send(http, base, token, &oid, note.as_deref())
    })
    .await?;
    answer(fetched)
}

/// People → Active machine (ADR-0028 §4, Administrators): the computer
/// this person is clocked in on, or `null`.
#[tauri::command]
pub async fn admin_active_device(
    auth: State<'_, Arc<Auth>>,
    employee_id: String,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::active_device(http, base, token, &employee_id)
    })
    .await?;
    answer(fetched)
}

/// "Sign out of this machine": closes the session at its last activity
/// and signs that computer out. Audited server-side.
#[tauri::command]
pub async fn admin_active_device_sign_out(
    auth: State<'_, Arc<Auth>>,
    employee_id: String,
    device_id: String,
) -> Result<serde_json::Value, String> {
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::sign_out_device(http, base, token, &employee_id, &device_id)
    })
    .await?;
    answer(fetched)
}

/// Replace a scope's override document. Audited server-side.
#[tauri::command]
pub async fn admin_policy_put(
    auth: State<'_, Arc<Auth>>,
    scope: String,
    id: Option<String>,
    document: serde_json::Value,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    let scope =
        admin::Scope::parse(&scope, id.as_deref()).ok_or_else(|| "invalid_argument".to_string())?;
    if !document.is_object() {
        return Err("invalid_argument".to_string());
    }
    let (_, fetched) = fetch_as_user(&auth, move |http, base, token| {
        admin::put_policy(http, base, token, &scope, &document, reason.as_deref())
    })
    .await?;
    answer(fetched)
}

/// Run a backend GET off the UI thread with the signed-in user's access
/// token. Returns that user's oid with the result, so the caller caches
/// it under the right user.
async fn fetch_as_user(
    auth: &State<'_, Arc<Auth>>,
    get: impl FnOnce(&reqwest::blocking::Client, &str, &str) -> Result<serde_json::Value, DayError>
        + Send
        + 'static,
) -> Result<(String, Result<serde_json::Value, DayError>), String> {
    let base_url = backend_http::base_url().ok_or_else(|| "not_configured".to_string())?;
    let oid = auth.oid().ok_or_else(|| "not_signed_in".to_string())?;
    let auth = auth.inner().clone();
    let fetch_oid = oid.clone();
    let fetched = tauri::async_runtime::spawn_blocking(move || {
        let token = match auth.access_token(SystemTime::now()) {
            Ok(t) => t,
            Err(AuthError::NotSignedIn) => return Err(DayError::Refused("not_signed_in".into())),
            // Microsoft refused to renew the sign-in: not "offline".
            Err(AuthError::Rejected(_)) => return Err(DayError::Refused("sign_in_again".into())),
            Err(e) => return Err(DayError::Unavailable(format!("token {}", e.code()))),
        };
        // Signed out or switched user while waiting: don't answer for them.
        if auth.oid().as_deref() != Some(fetch_oid.as_str()) {
            return Err(DayError::Refused("not_signed_in".into()));
        }
        let http = backend_http::client_builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| DayError::Unavailable(e.to_string()))?;
        get(&http, &base_url, &token)
    })
    .await
    .map_err(|_| "internal".to_string())?;
    Ok((oid, fetched))
}

/// "What were you doing?" after an idle stretch (ADR-0018 §2).
/// `explanation`: working_away | meeting | phone_call | break | idle.
#[tauri::command]
pub fn explain_idle(
    agent: State<'_, Arc<Agent>>,
    explanation: String,
    note: Option<String>,
) -> CommandResult {
    let explanation =
        IdleExplanation::parse(&explanation).ok_or_else(|| "invalid_argument".to_string())?;
    run(&agent, Input::ExplainIdle { explanation, note })
}

/// Skip that question; the stretch stays unexplained idle.
#[tauri::command]
pub fn dismiss_idle_return(agent: State<'_, Arc<Agent>>) -> CommandResult {
    run(&agent, Input::DismissIdleReturn)
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

/// "Not working today" for the shift showing (ADR-0031 §2): recorded on
/// the server, then the popup stops until the next shift.
#[tauri::command]
pub async fn not_working_today(
    auth: State<'_, Arc<Auth>>,
    agent: State<'_, Arc<Agent>>,
) -> Result<StateView, String> {
    let (_, fetched) = fetch_as_user(&auth, |http, base, token| {
        crate::shift::declare_not_working(http, base, token)
            .map(|d| serde_json::Value::String(d.format("%Y-%m-%d").to_string()))
    })
    .await?;
    let date = answer(fetched)?;
    let date = date
        .as_str()
        .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .ok_or_else(|| "internal".to_string())?;
    Ok(agent.mark_not_working(date))
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

/// "Restart to update": only while clocked out (ADR-0022 amendment).
#[tauri::command]
pub fn install_update_now(app: AppHandle) -> Result<(), String> {
    crate::updater::install_now(&app)
}

/// "Check for updates" (owner request, 2026-10-07): `{ status:
/// "up_to_date" }` or `{ status: "ready", version }` (downloaded; it
/// installs as any other update). Fails with `not_configured`,
/// `signed_out` or `offline`.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<serde_json::Value, String> {
    use crate::updater::Checked;
    Ok(match crate::updater::check_now(&app).await? {
        Checked::Ready(version) => serde_json::json!({ "status": "ready", "version": version }),
        _ => serde_json::json!({ "status": "up_to_date" }),
    })
}

/// "5 more min" / "10 more min" on a break that ran over (ADR-0031 §3).
#[tauri::command]
pub fn extend_break(agent: State<'_, Arc<Agent>>, minutes: u8) -> CommandResult {
    agent
        .extend_break(minutes)
        .map_err(|r| rejection_code(&r).to_string())
}

#[tauri::command]
pub fn clock_out(agent: State<'_, Arc<Agent>>) -> CommandResult {
    run(&agent, Input::ClockOut)
}

/// `kind`: a break id the policy offers; `planned_minutes`: the "Back
/// in?" answer, or none for "Not sure" (ADR-0023).
#[tauri::command]
pub fn start_break(
    agent: State<'_, Arc<Agent>>,
    kind: String,
    planned_minutes: Option<u32>,
) -> CommandResult {
    let kind = parse_break_kind(&kind).ok_or_else(|| "invalid_argument".to_string())?;
    let planned_minutes = parse_planned_minutes(planned_minutes).map_err(str::to_string)?;
    if !agent.break_offered(kind) {
        return Err("option_not_offered".into());
    }
    run(
        &agent,
        Input::StartBreak {
            kind,
            planned_minutes,
        },
    )
}

/// The answer to "Welcome back?" while Away (ADR-0027).
#[tauri::command]
pub fn answer_away_check(agent: State<'_, Arc<Agent>>, back: bool) -> CommandResult {
    run(&agent, Input::AnswerAwayCheck { back })
}

/// "I'm back" after an unanswered presence check (ADR-0024).
#[tauri::command]
pub fn confirm_presence(agent: State<'_, Arc<Agent>>) -> CommandResult {
    run(&agent, Input::ConfirmPresence)
}

#[tauri::command]
pub fn end_break(agent: State<'_, Arc<Agent>>) -> CommandResult {
    run(&agent, Input::EndBreak)
}

/// Voluntary away tag: `meeting` (ADR-0011 §2) or `training`
/// (ADR-0023, when offered).
#[tauri::command]
pub fn mark_away(
    agent: State<'_, Arc<Agent>>,
    reason: String,
    note: Option<String>,
) -> CommandResult {
    let reason = parse_away_tag(&reason).ok_or_else(|| "invalid_argument".to_string())?;
    if !agent.away_offered(reason) {
        return Err("option_not_offered".into());
    }
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
    fn max_height_is_about_70_percent_of_the_screen() {
        assert_eq!(max_height(1040.0), 728.0);
        // Small screens still get 560, but never past the work area.
        assert_eq!(max_height(700.0), 560.0);
        assert_eq!(max_height(560.0), 520.0);
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
