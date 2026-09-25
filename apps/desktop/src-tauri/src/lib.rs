//! CloudPunch desktop agent — Tauri 2 backend.
//!
//! This crate hosts the Rust side of the desktop app. Responsibilities
//! grow phase-by-phase:

//!   - Phase 2b.1: a window opens and the frontend can round-trip via
//!     `@tauri-apps/api`.
//!   - Phase 2b.2: byte-canonicalisation matching
//!     `packages/event-schema/src/canonicalize.ts` (conformance suite).
//!   - Phase 2b.3: SQLCipher-encrypted local outbox for offline events.
//!   - Phase 2b.4: MSAL loopback PKCE auth via system browser.
//!   - Phase 2b.5: OS watchers (idle, session, power, mic/cam, network)
//!     for Windows. macOS parity in 2b.8.
//!   - Phase 2b.5.6: supervisor wired into `run()`; drain thread
//!     eprintln!s signals in debug builds.
//!   - Phase 2b.6.1: sync loop core + outbox poison migration.
//!   - Phase 2b.6.2: reqwest-based BackendClient.
//!   - Phase 2b.6.3 (this slice): drain thread updates `is_online`
//!     from `NetworkReachabilityChanged`; sync loop opts in via env
//!     vars until 2b.4 supplies real keys + tokens.
//!   - Phase 2b.7: tray menu + idle prompt window.
//!   - Phase 2b.7.2b PR B: pure desktop state machine (`machine`).
//!   - Phase 2b.7.2b PR D: `agent` runs the machine — mic/cam from
//!     the watcher drain, 1 Hz idle tick, Tauri `commands`, tray, and
//!     the idle prompt window. Events go to a debug log sink until
//!     2b.4 supplies the signed outbox sink.
//!   - Phase 2b.8: macOS parity for OS watchers + menu bar.
//!   - Phase 2b.9: signed Windows installer + notarised macOS DMG +
//!     Tauri updater signature verification.

pub mod agent;
pub mod auth;
pub mod call_type;
pub mod commands;
pub mod enroll;
pub mod event;
pub mod keystore;
pub mod machine;
pub mod outbox;
pub mod recorder;
pub mod reminders;
pub mod sync;
pub mod timeline;
pub mod tray;
pub mod watchers;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use agent::Agent;
use machine::{CallType, CoreConfig, Input};
use tauri::Emitter;
use watchers::supervisor::Supervisor;

/// RAII guard around a running [`Supervisor`] and its drain thread.
///
/// `Drop` shuts every watcher down (blocks on join in registration
/// order), drops the Supervisor (which drops its `Sender`), and joins
/// the drain thread — which exits as soon as every `Sender` clone is
/// gone. Correct-by-construction ordering; no thread outlives the
/// guard.
pub struct WatchersGuard {
    inner: Option<(Supervisor, std::thread::JoinHandle<()>)>,
    is_online: Arc<AtomicBool>,
}

impl WatchersGuard {
    /// Shared "is the network reachable?" flag updated by the drain
    /// thread whenever a [`watchers::OsSignal::NetworkReachabilityChanged`]
    /// arrives. Used by [`SyncLoop`] to pause draining when offline.
    pub fn is_online(&self) -> Arc<AtomicBool> {
        self.is_online.clone()
    }
}

impl Drop for WatchersGuard {
    fn drop(&mut self) {
        if let Some((sup, drain)) = self.inner.take() {
            sup.shutdown();
            let _ = drain.join();
        }
    }
}

/// Boot every OS watcher and hand back a guard that owns their
/// shutdown. Mic/camera changes are forwarded to `agent`. On
/// non-Windows platforms this is currently a no-op — macOS parity
/// lands in slice 2b.8.
#[cfg(target_os = "windows")]
pub fn start_watchers(agent: Arc<Agent>) -> WatchersGuard {
    use watchers::{idle, mic_cam, network, power, session, OsSignal, Watcher};

    let mut sup = Supervisor::new();
    let rx = sup
        .take_receiver()
        .expect("fresh Supervisor has a Receiver");

    // Assume online at boot; the first NetworkReachabilityChanged
    // signal from the watcher will correct if we're actually offline.
    let is_online = Arc::new(AtomicBool::new(true));
    let is_online_drain = is_online.clone();

    let drain = std::thread::Builder::new()
        .name("cp-watcher-drain".into())
        .spawn(move || {
            while let Ok(signal) = rx.recv() {
                match &signal {
                    OsSignal::NetworkReachabilityChanged { reachable, .. } => {
                        is_online_drain.store(*reachable, Ordering::Release);
                    }
                    OsSignal::MediaInUseChanged {
                        mic,
                        cam,
                        call_type,
                        ..
                    } => {
                        // Mic OR camera, with the kind of call (ADR-0012).
                        let raw = (*mic || *cam).then_some(call_type.unwrap_or(CallType::Other));
                        let _ = agent.handle(Input::MediaInUse(raw));
                    }
                    _ => {}
                }
                #[cfg(debug_assertions)]
                eprintln!("[cloudpunch] os signal: {signal:?}");
                #[cfg(not(debug_assertions))]
                let _ = signal;
            }
        })
        .expect("failed to spawn cp-watcher-drain thread");

    let idle_h = idle::IdleWatcher::new(idle::IdleConfig::default(), idle::WindowsLastInput)
        .start(sup.sender());
    let session_h = session::SessionWatcher::new().start(sup.sender());
    let power_h = power::PowerWatcher::new().start(sup.sender());
    let miccam_h =
        mic_cam::MicCamWatcher::new(mic_cam::MicCamConfig::default(), mic_cam::WindowsMediaState)
            .start(sup.sender());
    let network_h = network::NetworkWatcher::new(
        network::NetworkConfig::default(),
        network::WindowsConnectivityProbe,
    )
    .start(sup.sender());

    sup.attach(idle_h);
    sup.attach(session_h);
    sup.attach(power_h);
    sup.attach(miccam_h);
    sup.attach(network_h);

    WatchersGuard {
        inner: Some((sup, drain)),
        is_online,
    }
}

/// Non-Windows stub. Returns an inert guard so callers can hold it
/// without conditionally-typed variables. `is_online` defaults to
/// true so a sync loop wired on a non-Windows dev host still runs.
#[cfg(not(target_os = "windows"))]
pub fn start_watchers(_agent: Arc<Agent>) -> WatchersGuard {
    WatchersGuard {
        inner: None,
        is_online: Arc::new(AtomicBool::new(true)),
    }
}

/// Entry point invoked from `main.rs`. Kept separate so the same
/// initialisation can be reused by future mobile targets (if we ever
/// build for them).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Guards are held for the lifetime of tauri::Builder::run. The
    // sync loop is started per user after sign-in (sync::live) and
    // shares the watchers' is_online flag through the recorder.
    let recorder = recorder::Recorder::new();
    // Crash-recovery heartbeat for the session in progress (ADR-0003
    // §10): a crashed session closes at the last beat.
    let beat = recorder.clone();
    let heartbeat = std::thread::Builder::new()
        .name("cp-heartbeat".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            beat.heartbeat(std::time::SystemTime::now());
        });
    if let Err(e) = heartbeat {
        eprintln!("[cloudpunch] heartbeat thread failed to start: {e}");
    }
    let agent = Agent::with_recorder(CoreConfig::default(), &recorder);
    let auth = Arc::new(commands::Auth::new(
        auth::EntraConfig::APTASK,
        keystore::OsStore,
    ));
    let restore_auth = auth.clone();
    let enrollment = Arc::new(enroll::Enrollment::new());
    let restore_enrollment = enrollment.clone();
    let watchers = start_watchers(agent.clone());
    recorder.set_online_flag(watchers.is_online());
    let restore_recorder = recorder.clone();
    let _ticker = agent.start_ticker();

    let setup_agent = agent.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(agent)
        .manage(auth)
        .manage(enrollment)
        .manage(recorder)
        .manage(sync::live::LiveSync::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::hide_to_tray,
            commands::quit_app,
            commands::clock_out_and_quit,
            commands::ack_long_shift,
            commands::auth_status,
            commands::sign_in,
            commands::cancel_sign_in,
            commands::sign_out,
            commands::enrollment_status,
            commands::fit_window,
            commands::clock_in,
            commands::clock_out,
            commands::start_break,
            commands::end_break,
            commands::mark_away,
            commands::mark_back,
            commands::respond_to_prompt,
        ])
        .setup(move |app| {
            setup_agent.attach(agent::TauriUi::new(app.handle().clone()));
            let snapshot = agent::tray_snapshot(setup_agent.state(), None);
            tray::install(app.handle(), snapshot)?;
            // Silent sign-in from the stored refresh token, off the
            // UI thread; the webview hears the result on cp://auth.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("cp-auth-restore".into())
                .spawn(move || {
                    match restore_auth.restore() {
                        Ok(true) => commands::start_enrollment(
                            &handle,
                            restore_auth.clone(),
                            restore_enrollment,
                            restore_recorder,
                        ),
                        Ok(false) => eprintln!(
                            "[cloudpunch] silent sign-in: no saved session (none stored, or it was rejected)"
                        ),
                        Err(e) => eprintln!("[cloudpunch] silent sign-in failed: {}", e.code()),
                    }
                    let _ = handle.emit(commands::AUTH_EVENT, restore_auth.status());
                })?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    // Never close silently: the window asks "keep
                    // running in tray / quit" (ADR-0013 §1). The
                    // webview answers through hide_to_tray, quit_app,
                    // or clock_out_and_quit.
                    "main" => {
                        api.prevent_close();
                        let _ = window.emit(tray::CLOSE_REQUESTED_EVENT, ());
                    }
                    // The prompt must be answered or time out
                    // (ADR-0008); the agent destroys it itself.
                    agent::PROMPT_WINDOW => api.prevent_close(),
                    _ => {}
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("cloudpunch-desktop: error while running tauri application");
}
