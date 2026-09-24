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
pub mod commands;
pub mod event;
pub mod machine;
pub mod outbox;
pub mod sync;
pub mod tray;
pub mod watchers;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use agent::Agent;
use machine::{CoreConfig, Input};
use outbox::Outbox;
use sync::{ReqwestBackendClient, SyncBootstrap, SyncConfig, SyncLoop};
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
                    OsSignal::MediaInUseChanged { mic, cam, .. } => {
                        // Boolean only (ADR-0009): mic OR camera.
                        let _ = agent.handle(Input::MediaInUse(*mic || *cam));
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
    let miccam_h = mic_cam::MicCamWatcher::new(
        mic_cam::MicCamConfig::default(),
        mic_cam::WindowsConsentStore,
    )
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

/// RAII guard around a running [`SyncLoop`]. `Drop` calls
/// `SyncLoop::shutdown` which joins the sync thread; the returned
/// [`Outbox`] is dropped here.
pub struct SyncLoopGuard {
    inner: Option<SyncLoop>,
}

impl Drop for SyncLoopGuard {
    fn drop(&mut self) {
        if let Some(loop_) = self.inner.take() {
            let _outbox = loop_.shutdown();
        }
    }
}

/// Start the sync loop iff `SyncBootstrap::from_env()` succeeds.
/// Returns `None` (and logs why in debug builds) when any required
/// env var is missing — the whole boot path is opt-in until slice
/// 2b.4 supplies keys/tokens from the OS keystore.
pub fn start_sync_loop_if_configured(is_online: Arc<AtomicBool>) -> Option<SyncLoopGuard> {
    let bootstrap = match SyncBootstrap::from_env() {
        Ok(b) => b,
        Err(reason) => {
            #[cfg(debug_assertions)]
            eprintln!(
                "[cloudpunch] sync loop not started ({reason}); \
                set all six CLOUDPUNCH_* env vars to opt in"
            );
            #[cfg(not(debug_assertions))]
            let _ = reason;
            return None;
        }
    };

    let outbox = match Outbox::open(&bootstrap.outbox_path, &bootstrap.outbox_key) {
        Ok(o) => o,
        Err(e) => {
            eprintln!(
                "[cloudpunch] sync loop not started: outbox open failed at {}: {e}",
                bootstrap.outbox_path.display()
            );
            return None;
        }
    };

    let client = ReqwestBackendClient::new(bootstrap.backend_url, bootstrap.bearer_token);
    let config = SyncConfig::new(bootstrap.device_id, bootstrap.employee_id);
    let loop_ = SyncLoop::start(outbox, Box::new(client), config, is_online);

    #[cfg(debug_assertions)]
    eprintln!("[cloudpunch] sync loop started");

    Some(SyncLoopGuard { inner: Some(loop_) })
}

/// Entry point invoked from `main.rs`. Kept separate so the same
/// initialisation can be reused by future mobile targets (if we ever
/// build for them).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Guards are held for the lifetime of tauri::Builder::run. Drop
    // order (Rust: reverse of declaration): sync first (drains its
    // thread), then watchers (which frees the is_online Arc it
    // shares with sync).
    let agent = Agent::new(CoreConfig::default());
    let watchers = start_watchers(agent.clone());
    let _sync = start_sync_loop_if_configured(watchers.is_online());
    let _ticker = agent.start_ticker();

    let setup_agent = agent.clone();
    tauri::Builder::default()
        .manage(agent)
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::clock_in,
            commands::clock_out,
            commands::start_break,
            commands::end_break,
            commands::mark_back,
            commands::respond_to_prompt,
        ])
        .setup(move |app| {
            setup_agent.attach(agent::TauriUi::new(app.handle().clone()));
            let snapshot = agent::tray_snapshot(setup_agent.state());
            tray::install(app.handle(), snapshot)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    // Close-to-tray: the agent keeps running in the
                    // background. Tray menu's "Quit" is the intended
                    // exit.
                    "main" => {
                        let _ = window.hide();
                        api.prevent_close();
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
