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
//!   - Phase 2b.5.6 (this slice): supervisor wired into `run()` so
//!     watchers actually start on boot; `eprintln!` drain thread for
//!     smoke-test visibility in debug builds.
//!   - Phase 2b.6: sync loop against `POST /v1/events`.
//!   - Phase 2b.7: tray menu + idle prompt window.
//!   - Phase 2b.8: macOS parity for OS watchers + menu bar.
//!   - Phase 2b.9: signed Windows installer + notarised macOS DMG +
//!     Tauri updater signature verification.

pub mod event;
pub mod outbox;
pub mod sync;
pub mod watchers;

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
/// shutdown. On non-Windows platforms this is currently a no-op —
/// macOS parity lands in slice 2b.8.
#[cfg(target_os = "windows")]
pub fn start_watchers() -> WatchersGuard {
    use watchers::{idle, mic_cam, network, power, session, Watcher};

    let mut sup = Supervisor::new();
    let rx = sup
        .take_receiver()
        .expect("fresh Supervisor has a Receiver");

    let drain = std::thread::Builder::new()
        .name("cp-watcher-drain".into())
        .spawn(move || {
            while let Ok(signal) = rx.recv() {
                // Debug-only smoke print. Silenced in release builds
                // until a real consumer (state machine) lands.
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
    }
}

/// Non-Windows stub. Returns an inert guard so callers can hold it
/// without conditionally-typed variables.
#[cfg(not(target_os = "windows"))]
pub fn start_watchers() -> WatchersGuard {
    WatchersGuard { inner: None }
}

/// Entry point invoked from `main.rs`. Kept separate so the same
/// initialisation can be reused by future mobile targets (if we ever
/// build for them).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Guard is held for the lifetime of tauri::Builder::run. It drops
    // when run returns (normal window-close on desktop), stopping all
    // watcher threads cleanly.
    let _guard = start_watchers();

    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("cloudpunch-desktop: error while running tauri application");
}
