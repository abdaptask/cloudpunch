//! Tauri glue for the auto-update (ADR-0022). [`crate::app_update`]
//! decides *when*; this checks, downloads and installs.
//!
//! - Checks our API a minute after start and every 4 hours, with the
//!   app's normal bearer token (the plugin sends it on the download
//!   too). Signed out, or a build with no backend: no check.
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

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::agent::Agent;
use crate::backend_http;
use crate::commands::Auth;

const FIRST_CHECK: Duration = Duration::from_secs(60);
const LOG_FILE: &str = "update.log";
/// Past this the log starts again (the old one is kept as `.old`).
const LOG_MAX_BYTES: u64 = 256 * 1024;

/// Append a timestamped line to `update.log`; never fails the caller.
pub fn log<R: tauri::Runtime>(app: &AppHandle<R>, line: &str) {
    eprintln!("[cloudpunch] {line}");
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let _ = append_log(&dir, line, SystemTime::now());
}

fn append_log(dir: &std::path::Path, line: &str, now: SystemTime) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    let path = dir.join(LOG_FILE);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_MAX_BYTES) {
        let _ = std::fs::rename(&path, dir.join(format!("{LOG_FILE}.old")));
    }
    let at = chrono::DateTime::<chrono::Utc>::from(now).format("%Y-%m-%dT%H:%M:%SZ");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(f, "{at} {} {line}", env!("CARGO_PKG_VERSION"))
}

/// The server's name for this platform's updates (ADR-0026 §4).
#[cfg(target_os = "macos")]
const UPDATE_PLATFORM: &str = "darwin";
#[cfg(not(target_os = "macos"))]
const UPDATE_PLATFORM: &str = "windows";
const EVERY: Duration = Duration::from_secs(4 * 3600);

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
                std::thread::sleep(EVERY);
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
    update.install(bytes).map_err(|e| {
        log(
            app,
            &format!("update {} failed to install: {e}", update.version),
        );
        "install_failed".to_string()
    })
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
    if let Err(e) = update.install(bytes) {
        log(app, &format!("update {version} failed to install: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_appends_timestamped_lines_and_rolls_over() {
        let dir = std::env::temp_dir().join(format!("cp-update-log-{}", uuid::Uuid::new_v4()));
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_790_000_000);
        append_log(&dir, "update 0.1.8 downloaded", t).unwrap();
        append_log(&dir, "installing update 0.1.8", t).unwrap();
        let text = std::fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("2026-09-21T"), "{}", lines[0]);
        assert!(lines[0].ends_with(" update 0.1.8 downloaded"));

        std::fs::write(dir.join(LOG_FILE), vec![b'x'; LOG_MAX_BYTES as usize + 1]).unwrap();
        append_log(&dir, "after roll", t).unwrap();
        assert!(dir.join(format!("{LOG_FILE}.old")).exists());
        let fresh = std::fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert_eq!(fresh.lines().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
