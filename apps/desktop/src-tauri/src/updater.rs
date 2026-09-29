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

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::agent::Agent;
use crate::backend_http;
use crate::commands::Auth;

const FIRST_CHECK: Duration = Duration::from_secs(60);
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
                    eprintln!("[cloudpunch] update check failed: {e}");
                }
                std::thread::sleep(EVERY);
            }
        });
    if let Err(e) = spawned {
        eprintln!("[cloudpunch] updater thread failed to start: {e}");
    }
}

async fn check_once(app: &AppHandle) -> Result<(), String> {
    let Some(base) = backend_http::base_url() else {
        return Ok(());
    };
    let auth = app.state::<Arc<Auth>>().inner().clone();
    // On the updater's own thread, so a blocking refresh is fine.
    let Ok(token) = auth.access_token(SystemTime::now()) else {
        return Ok(()); // Signed out: nothing to ask with.
    };
    let endpoint = format!(
        "{}/v1/desktop/update/windows/{{{{current_version}}}}",
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
        return Ok(());
    };
    let pending = app.state::<Pending>();
    let have = pending
        .0
        .lock()
        .ok()
        .and_then(|p| p.as_ref().map(|(u, _)| u.version.clone()));
    if have.as_deref() == Some(update.version.as_str()) {
        return Ok(());
    }
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    let version = update.version.clone();
    if let Ok(mut p) = pending.0.lock() {
        *p = Some((update, bytes));
    }
    eprintln!("[cloudpunch] update {version} downloaded; installs at the next sign-in");
    app.state::<Arc<Agent>>().update_ready(version);
    Ok(())
}

/// Install `version` now if it's the one downloaded and a restart still
/// loses nothing. On Windows this exits the app on success.
pub fn install(app: &AppHandle, version: &str) {
    if !app.state::<Arc<Agent>>().safe_to_restart() {
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
    eprintln!("[cloudpunch] installing update {version}");
    if let Err(e) = update.install(bytes) {
        eprintln!("[cloudpunch] update {version} failed to install: {e}");
    }
}
