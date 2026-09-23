//! OS state watchers per ADR-0003.
//!
//! Watchers report machine-level lifecycle signals (idle timers,
//! session lock, power transitions, mic/cam usage boolean, network
//! reachability) and nothing else. **No app names, window titles,
//! device identifiers, or per-app usage** — enforced by the
//! no-content-capture invariant (see `CLAUDE.md`, invariant 1).
//!
//! Structure: each watcher runs on its own thread, produces
//! [`OsSignal`] values on a channel owned by the [`supervisor`]. The
//! state machine (later slice) consumes from that channel.
//!
//! Cross-platform seam: [`OsSignal`] and [`Watcher`] are defined here
//! (unconditionally). Concrete watcher impls are `#[cfg]`-gated per
//! OS. macOS parity lands in slice 2b.8.

use std::time::SystemTime;

pub mod supervisor;

#[cfg(target_os = "windows")]
pub mod idle;

#[cfg(target_os = "windows")]
pub mod power;

#[cfg(target_os = "windows")]
pub mod session;

/// Every signal the state machine will consume from any OS.
///
/// Deliberately narrow: no strings identifying apps, files, or
/// devices. Timestamps are wall-clock (`SystemTime`); monotonic
/// counters are added by the event pipeline at ingest, not here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OsSignal {
    /// User input has been quiet for at least the configured
    /// threshold. `since` is when the last input landed.
    IdleSince { since: SystemTime },
    /// Input resumed after an idle period.
    IdleEnded { at: SystemTime },
    /// Desktop session was locked (Windows: `WTS_SESSION_LOCK`).
    SessionLocked { at: SystemTime },
    /// Desktop session was unlocked.
    SessionUnlocked { at: SystemTime },
    /// System is entering sleep / suspend.
    Suspending { at: SystemTime },
    /// System resumed from sleep.
    Resumed { at: SystemTime },
    /// Mic or camera state changed. Boolean-only per invariant 1 —
    /// no indication of which app is using either device.
    MediaInUseChanged {
        mic: bool,
        cam: bool,
        at: SystemTime,
    },
    /// Network reachability flipped (up / down). No SSID, no address.
    NetworkReachabilityChanged { reachable: bool, at: SystemTime },
}

/// Handle returned by [`Watcher::start`]. Dropping the handle should
/// request the watcher's thread to stop; `shutdown` blocks until it
/// has.
pub trait WatcherHandle: Send {
    /// Signal the watcher to stop and block until it exits.
    fn shutdown(self: Box<Self>);
}

/// A running OS watcher.
///
/// Watchers are one-shot: `start` consumes the config and hands back
/// a handle that owns the thread. Callers wire the `tx` end of a
/// [`supervisor::Supervisor`]'s channel through so all signals fan
/// into one place.
pub trait Watcher {
    fn start(
        self,
        tx: std::sync::mpsc::Sender<OsSignal>,
    ) -> Box<dyn WatcherHandle>;
}
