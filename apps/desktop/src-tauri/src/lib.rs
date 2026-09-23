//! CloudPunch desktop agent — Tauri 2 backend.
//!
//! This crate hosts the Rust side of the desktop app. Responsibilities
//! grow phase-by-phase:

//!   - Phase 2b.1 (this slice): a window opens and the frontend can
//!     round-trip via `@tauri-apps/api`.
//!   - Phase 2b.2: byte-canonicalisation matching
//!     `packages/event-schema/src/canonicalize.ts` (conformance suite).
//!   - Phase 2b.3: SQLCipher-encrypted local outbox for offline events.
//!   - Phase 2b.4: MSAL loopback PKCE auth via system browser.
//!   - Phase 2b.5: Windows OS watchers (idle, lock, sleep, mic/cam,
//!     network reachability).
//!   - Phase 2b.6: sync loop against `POST /v1/events`.
//!   - Phase 2b.7: tray menu + idle prompt window.
//!   - Phase 2b.8: macOS parity for OS watchers + menu bar.
//!   - Phase 2b.9: signed Windows installer + notarised macOS DMG +
//!     Tauri updater signature verification.

pub mod event;
pub mod outbox;
pub mod watchers;

/// Entry point invoked from `main.rs`. Kept separate so the same
/// initialisation can be reused by future mobile targets (if we ever
/// build for them).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("cloudpunch-desktop: error while running tauri application");
}
