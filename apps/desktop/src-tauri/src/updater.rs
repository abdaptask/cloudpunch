//! Tauri glue for the auto-update (ADR-0022). [`crate::app_update`]
//! decides *when*; this checks, downloads and installs.
//!
//! - Checks our API a minute after start and every 30 minutes, and
//!   within a minute of a pushed update (ADR-0046 §3), with the app's
//!   normal bearer token (the plugin sends it on the download too).
//!   Signed out, or a build with no backend: no check.
//! - A new version is downloaded straight away; its signature is checked
//!   against the key built into the app before it can install.
//! - The agent's tick calls [`install`] at the safe moment; it checks
//!   again that a restart loses nothing, then runs the installer (which
//!   exits the app and starts the new one).
//! - Only in builds whose config has `plugins.updater` (the pilot
//!   config): the plugin needs its public key.
//! - Every check, download, install attempt and reason to wait goes to
//!   `update.log` in the app's log folder (versions and reasons only),
//!   so a missed update can be explained afterwards.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::agent::Agent;
use crate::backend_http;
use crate::commands::Auth;
use crate::machine::{CoreState, Input};

const FIRST_CHECK: Duration = Duration::from_secs(60);
const LOG_FILE: &str = "update.log";

/// Append a timestamped line to `update.log`; never fails the caller.
pub fn log<R: tauri::Runtime>(app: &AppHandle<R>, line: &str) {
    crate::applog::write(app, LOG_FILE, line);
}

/// Left just before an update installs. On Windows the updater restarts
/// the app with the arguments it was started with, `--autostart`
/// included, so without this a copy started at sign-in would come back
/// hidden in the tray (owner report, 2026-10-12). The restart finds it
/// and shows the window like any other start.
const RESTART_MARKER: &str = "restart-after-update";
/// Older than this, a marker is from an install that never restarted.
const MARKER_FRESH: Duration = Duration::from_secs(10 * 60);

/// What the new version does once it starts (ADR-0046 §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterUpdate {
    /// Nothing more: the window shows as after any start.
    Nothing,
    /// "Update and clock in": clock in on the new version.
    ClockIn,
    /// "Update and shut down": ask the computer to shut down.
    ShutDown,
}

impl AfterUpdate {
    fn as_str(self) -> &'static str {
        match self {
            AfterUpdate::Nothing => "",
            AfterUpdate::ClockIn => "clock-in",
            AfterUpdate::ShutDown => "shutdown",
        }
    }

    fn parse(s: &str) -> Self {
        match s.trim() {
            "clock-in" => AfterUpdate::ClockIn,
            "shutdown" => AfterUpdate::ShutDown,
            _ => AfterUpdate::Nothing,
        }
    }

    /// From the window's choice: `clock_in`, `shutdown` or anything else.
    pub fn from_choice(s: &str) -> Self {
        Self::parse(&s.replace('_', "-").replace("shut-down", "shutdown"))
    }
}

fn mark_restart(app: &AppHandle, then: AfterUpdate) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    if let Err(e) = std::fs::write(dir.join(RESTART_MARKER), then.as_str()) {
        log(app, &format!("restart marker not written: {e}"));
    }
}

/// `Some(what next)`, once, when this start is the restart after an update.
pub fn restarted_after_update<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<AfterUpdate> {
    let dir = app.path().app_data_dir().ok()?;
    take_marker(&dir.join(RESTART_MARKER), SystemTime::now())
}

/// The marker's intent if `path` was left within `MARKER_FRESH` of
/// `now`; removes it either way.
pub(crate) fn take_marker(path: &std::path::Path, now: SystemTime) -> Option<AfterUpdate> {
    let fresh = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .is_ok_and(|at| now.duration_since(at).map_or(true, |d| d < MARKER_FRESH));
    let what = std::fs::read_to_string(path).unwrap_or_default();
    let _ = std::fs::remove_file(path);
    fresh.then(|| AfterUpdate::parse(&what))
}

/// Ask the computer to shut down ("Update and shut down", ADR-0046 §4).
/// Windows gives a minute, cancellable with `shutdown /a`.
pub fn shut_down_computer<R: tauri::Runtime>(app: &AppHandle<R>) {
    #[cfg(windows)]
    let result = std::process::Command::new("shutdown")
        .args([
            "/s",
            "/t",
            "60",
            "/c",
            "CloudPunch is up to date. The computer shuts down in a minute (shutdown /a cancels).",
        ])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to shut down"])
        .spawn();
    #[cfg(not(any(windows, target_os = "macos")))]
    let result: std::io::Result<std::process::Child> = Err(std::io::Error::other("not supported"));
    match result {
        Ok(_) => crate::applog::write(app, LOG_FILE, "shutdown requested after the update"),
        Err(e) => crate::applog::write(app, LOG_FILE, &format!("shutdown failed: {e}")),
    }
}

/// The server's name for this platform's updates (ADR-0026 §4).
#[cfg(target_os = "macos")]
const UPDATE_PLATFORM: &str = "darwin";
#[cfg(not(target_os = "macos"))]
const UPDATE_PLATFORM: &str = "windows";
const EVERY: Duration = Duration::from_secs(30 * 60);
/// How often the loop looks for a "check soon" from a push.
const POLL: Duration = Duration::from_secs(60);
static CHECK_SOON: AtomicBool = AtomicBool::new(false);

/// A pushed update arrived (ADR-0046 §3): check within a minute.
pub fn check_soon() {
    CHECK_SOON.store(true, Ordering::Release);
}

/// A downloaded, verified update waiting for its moment.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

/// Whether this build carries the updater's config (and so its key).
pub fn configured(config: &tauri::Config) -> bool {
    config.plugins.0.contains_key("updater")
}

/// Start the check loop (call once, from setup), on its own thread.
pub fn start(app: AppHandle) {
    app.manage(Pending::default());
    let spawned = std::thread::Builder::new()
        .name("cp-updater".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            loop {
                if let Err(e) = tauri::async_runtime::block_on(check_once(&app)) {
                    log(&app, &format!("update check failed: {e}"));
                }
                let mut waited = Duration::ZERO;
                while waited < EVERY && !CHECK_SOON.swap(false, Ordering::AcqRel) {
                    std::thread::sleep(POLL);
                    waited += POLL;
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("[cloudpunch] updater thread failed to start: {e}");
    }
}

/// What a check found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checked {
    /// No backend in this build: nothing to check against.
    NoBackend,
    /// No usable sign-in (also a sign-in that can't refresh).
    SignedOut,
    UpToDate,
    /// This version is downloaded and verified, waiting to install.
    Ready(String),
}

/// "Check for updates" from the account menu: the same check as the
/// 4-hourly one, now. Fails with `not_configured` in a build without the
/// updater, `signed_out`, or `offline` when the check itself failed.
pub async fn check_now(app: &AppHandle) -> Result<Checked, String> {
    if app.try_state::<Pending>().is_none() {
        return Err("not_configured".into());
    }
    log(app, "update check requested from the menu");
    match check_once(app).await {
        Ok(Checked::NoBackend) => Err("not_configured".into()),
        Ok(Checked::SignedOut) => Err("signed_out".into()),
        Ok(found) => Ok(found),
        Err(e) => {
            log(app, &format!("update check failed: {e}"));
            Err("offline".into())
        }
    }
}

async fn check_once(app: &AppHandle) -> Result<Checked, String> {
    let Some(base) = backend_http::base_url() else {
        return Ok(Checked::NoBackend);
    };
    let auth = app.state::<Arc<Auth>>().inner().clone();
    // A refresh blocks; keep it off the async runtime (the menu's check
    // runs there, not on the updater's own thread).
    let token = tauri::async_runtime::spawn_blocking(move || auth.access_token(SystemTime::now()))
        .await
        .map_err(|e| e.to_string())?;
    let Ok(token) = token else {
        log(app, "update check skipped: signed out");
        return Ok(Checked::SignedOut);
    };
    let endpoint = format!(
        "{}/v1/desktop/update/{UPDATE_PLATFORM}/{{{{current_version}}}}",
        base.trim_end_matches('/')
    );
    let url = endpoint.parse().map_err(|e| format!("endpoint: {e}"))?;
    let Some(update) = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .header("Authorization", format!("Bearer {token}"))
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
    else {
        log(app, "update check: up to date");
        return Ok(Checked::UpToDate);
    };
    let pending = app.state::<Pending>();
    let have = pending
        .0
        .lock()
        .ok()
        .and_then(|p| p.as_ref().map(|(u, _)| u.version.clone()));
    if have.as_deref() == Some(update.version.as_str()) {
        return Ok(Checked::Ready(update.version));
    }
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    let version = update.version.clone();
    if let Ok(mut p) = pending.0.lock() {
        *p = Some((update, bytes));
    }
    log(app, &format!("update {version} downloaded"));
    app.state::<Arc<Agent>>().update_ready(version.clone());
    Ok(Checked::Ready(version))
}

/// "Restart to update" (owner request, ADR-0022 amendment): install the
/// downloaded update now, while clocked out. Unlike the automatic
/// install it doesn't wait for the next morning: the person chose it,
/// and clocked out a restart loses nothing. Exits the app on success.
pub fn install_now(app: &AppHandle) -> Result<(), String> {
    if !app.state::<Arc<Agent>>().clocked_out() {
        return Err("not_clocked_out".into());
    }
    let pending = app
        .try_state::<Pending>()
        .ok_or_else(|| "no_update".to_string())?;
    let guard = pending.0.lock().map_err(|_| "no_update".to_string())?;
    let (update, bytes) = guard.as_ref().ok_or_else(|| "no_update".to_string())?;
    log(
        app,
        &format!("installing update {} (Restart to update)", update.version),
    );
    mark_restart(app, AfterUpdate::Nothing);
    update.install(bytes).map_err(|e| {
        log(
            app,
            &format!("update {} failed to install: {e}", update.version),
        );
        "install_failed".to_string()
    })?;
    restart_on_mac(app);
    Ok(())
}

/// macOS replaces the app in place; nothing restarts it (ADR-0046 §5).
/// Windows' installer restarts it itself.
fn restart_on_mac(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    app.restart();
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// The person's choice (ADR-0046 §2): clock out if clocked in, install
/// the downloaded update, and do `then` on the new version.
pub fn update_with(app: &AppHandle, then: AfterUpdate) -> Result<(), String> {
    let agent = app.state::<Arc<Agent>>().inner().clone();
    let pending = app
        .try_state::<Pending>()
        .ok_or_else(|| "no_update".to_string())?;
    let guard = pending.0.lock().map_err(|_| "no_update".to_string())?;
    let (update, bytes) = guard.as_ref().ok_or_else(|| "no_update".to_string())?;
    if agent.state() != CoreState::ClockedOut {
        agent
            .handle(Input::ClockOut)
            .map_err(|_| "clock_out_failed".to_string())?;
    }
    agent.update_started();
    log(
        app,
        &format!(
            "installing update {} (then: {})",
            update.version,
            match then {
                AfterUpdate::Nothing => "nothing",
                AfterUpdate::ClockIn => "clock in",
                AfterUpdate::ShutDown => "shut down",
            }
        ),
    );
    mark_restart(app, then);
    update.install(bytes).map_err(|e| {
        log(
            app,
            &format!("update {} failed to install: {e}", update.version),
        );
        "install_failed".to_string()
    })?;
    restart_on_mac(app);
    Ok(())
}

/// A pushed update's notice ran out (ADR-0046 §3): clock out, update,
/// clock back in.
pub fn update_and_clock_back_in(app: &AppHandle, version: &str) {
    log(app, &format!("update {version}: notice over, updating"));
    if let Err(e) = update_with(app, AfterUpdate::ClockIn) {
        log(app, &format!("update {version} not installed: {e}"));
    }
}

/// Install `version` now if it's the one downloaded and a restart still
/// loses nothing. On Windows this exits the app on success.
pub fn install(app: &AppHandle, version: &str) {
    if !app.state::<Arc<Agent>>().safe_to_restart() {
        log(
            app,
            &format!("update {version} not installed: restart not safe"),
        );
        return;
    }
    let Some(pending) = app.try_state::<Pending>() else {
        return;
    };
    let Ok(guard) = pending.0.lock() else {
        return;
    };
    let Some((update, bytes)) = guard.as_ref() else {
        return;
    };
    if update.version != version {
        return;
    }
    log(app, &format!("installing update {version}"));
    mark_restart(app, AfterUpdate::Nothing);
    match update.install(bytes) {
        Ok(()) => restart_on_mac(app),
        Err(e) => log(app, &format!("update {version} failed to install: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_restart_marker_is_taken_once_and_a_stale_one_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RESTART_MARKER);
        // None left: an ordinary start.
        assert_eq!(take_marker(&path, SystemTime::now()), None);

        std::fs::write(&path, b"").unwrap();
        assert_eq!(
            take_marker(&path, SystemTime::now()),
            Some(AfterUpdate::Nothing)
        );
        // Taken: the next start is ordinary again.
        assert!(!path.exists());
        assert_eq!(take_marker(&path, SystemTime::now()), None);

        // What to do next comes back with it (ADR-0046 §6).
        std::fs::write(&path, b"clock-in").unwrap();
        assert_eq!(
            take_marker(&path, SystemTime::now()),
            Some(AfterUpdate::ClockIn)
        );
        std::fs::write(&path, b"shutdown").unwrap();
        assert_eq!(
            take_marker(&path, SystemTime::now()),
            Some(AfterUpdate::ShutDown)
        );

        // An install that never restarted: too old to count, still removed.
        std::fs::write(&path, b"clock-in").unwrap();
        let later = SystemTime::now() + MARKER_FRESH + Duration::from_secs(1);
        assert_eq!(take_marker(&path, later), None);
        assert!(!path.exists());
    }

    #[test]
    fn the_window_choice_names_what_comes_after() {
        assert_eq!(AfterUpdate::from_choice("clock_in"), AfterUpdate::ClockIn);
        assert_eq!(AfterUpdate::from_choice("shutdown"), AfterUpdate::ShutDown);
        assert_eq!(AfterUpdate::from_choice("shut_down"), AfterUpdate::ShutDown);
        assert_eq!(AfterUpdate::from_choice("none"), AfterUpdate::Nothing);
    }
}
