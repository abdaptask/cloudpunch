//! Idle detection via Win32 `GetLastInputInfo`.
//!
//! Reports [`OsSignal::IdleSince`] when the user has been quiet for
//! at least [`IdleConfig::threshold`], and [`OsSignal::IdleEnded`]
//! when input resumes. The threshold-transition logic is factored
//! into pure functions so it can be unit-tested without touching the
//! OS API.
//!
//! Poll cadence is 1 Hz by default — GetLastInputInfo is cheap but
//! this is idle detection, not a jitter-critical signal.
//!
//! Note on wraparound: both `GetLastInputInfo`'s `dwTime` and
//! `GetTickCount()` are `DWORD` (u32) that roll over roughly every
//! 49.7 days. Using `wrapping_sub` gives the correct elapsed time as
//! long as the actual gap fits in that window — a fair assumption
//! for idle thresholds measured in minutes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};

use super::{OsSignal, Watcher, WatcherHandle};

#[derive(Debug, Clone, Copy)]
pub struct IdleConfig {
    /// How long input must have been quiet before we emit
    /// `IdleSince`.
    pub threshold: Duration,
    /// How often to poll `GetLastInputInfo`.
    pub poll_interval: Duration,
}

impl Default for IdleConfig {
    /// Placeholder defaults — real values come from
    /// `docs/policy/idle-policy-defaults.md` and are wired in a
    /// later slice. Kept conservative so tests and manual smoke
    /// checks don't need to wait forever.
    fn default() -> Self {
        Self {
            threshold: Duration::from_secs(120),
            poll_interval: Duration::from_secs(1),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Active,
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Transition {
    None,
    BecameIdle,
    BecameActive,
}

/// Pure state-transition step. `now` and `last_input_at` let tests
/// drive this without a real clock or `GetLastInputInfo`.
fn step(
    current: State,
    now: SystemTime,
    last_input_at: SystemTime,
    threshold: Duration,
) -> Transition {
    let elapsed = now.duration_since(last_input_at).unwrap_or(Duration::ZERO);
    match (current, elapsed >= threshold) {
        (State::Active, true) => Transition::BecameIdle,
        (State::Idle, false) => Transition::BecameActive,
        _ => Transition::None,
    }
}

/// Abstract "how long since the last user input?" so the poll loop
/// can be tested against a synthetic source.
pub trait LastInputSource: Send {
    /// Milliseconds since the user last touched keyboard or mouse.
    fn ms_since_last_input(&self) -> u32;
}

#[cfg(target_os = "windows")]
pub struct WindowsLastInput;

#[cfg(target_os = "windows")]
impl LastInputSource for WindowsLastInput {
    fn ms_since_last_input(&self) -> u32 {
        use windows::Win32::System::SystemInformation::GetTickCount;
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            GetLastInputInfo, LASTINPUTINFO,
        };

        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // SAFETY: `info.cbSize` is initialised to the correct value
        // per Win32 contract; failure is silently reported as
        // "very stale input" so the caller decides how to react.
        let ok = unsafe { GetLastInputInfo(&mut info) };
        if !ok.as_bool() {
            return u32::MAX;
        }
        // SAFETY: no-arg function; always safe.
        let now = unsafe { GetTickCount() };
        now.wrapping_sub(info.dwTime)
    }
}

pub struct IdleWatcher<S: LastInputSource + 'static> {
    pub config: IdleConfig,
    pub source: S,
}

impl<S: LastInputSource + 'static> IdleWatcher<S> {
    pub fn new(config: IdleConfig, source: S) -> Self {
        Self { config, source }
    }
}

pub struct IdleHandle {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl WatcherHandle for IdleHandle {
    fn shutdown(mut self: Box<Self>) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl<S: LastInputSource + 'static> Watcher for IdleWatcher<S> {
    fn start(self, tx: Sender<OsSignal>) -> Box<dyn WatcherHandle> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let config = self.config;
        let source = self.source;

        let thread = thread::spawn(move || {
            let mut state = State::Active;
            while !stop_clone.load(Ordering::Acquire) {
                let ms = source.ms_since_last_input();
                let now = SystemTime::now();
                let last_input_at = now
                    .checked_sub(Duration::from_millis(ms as u64))
                    .unwrap_or(now);
                match step(state, now, last_input_at, config.threshold) {
                    Transition::BecameIdle => {
                        state = State::Idle;
                        let _ = tx.send(OsSignal::IdleSince {
                            since: last_input_at,
                        });
                    }
                    Transition::BecameActive => {
                        state = State::Active;
                        let _ = tx.send(OsSignal::IdleEnded { at: now });
                    }
                    Transition::None => {}
                }
                thread::sleep(config.poll_interval);
            }
        });

        Box::new(IdleHandle {
            stop,
            thread: Some(thread),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;
    use std::sync::mpsc::channel;
    use std::time::{Duration, SystemTime};

    // ---- pure `step` tests ----

    fn t(ms: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_millis(ms)
    }

    #[test]
    fn active_stays_active_below_threshold() {
        let now = t(10_000);
        let last = t(9_500); // 500ms ago
        assert_eq!(
            step(State::Active, now, last, Duration::from_secs(2)),
            Transition::None
        );
    }

    #[test]
    fn active_becomes_idle_at_or_above_threshold() {
        let now = t(10_000);
        let last = t(8_000); // 2000ms ago
        assert_eq!(
            step(State::Active, now, last, Duration::from_secs(2)),
            Transition::BecameIdle
        );
    }

    #[test]
    fn idle_stays_idle_above_threshold() {
        let now = t(10_000);
        let last = t(5_000); // 5000ms ago
        assert_eq!(
            step(State::Idle, now, last, Duration::from_secs(2)),
            Transition::None
        );
    }

    #[test]
    fn idle_becomes_active_when_input_returns() {
        let now = t(10_000);
        let last = t(9_900); // 100ms ago
        assert_eq!(
            step(State::Idle, now, last, Duration::from_secs(2)),
            Transition::BecameActive
        );
    }

    #[test]
    fn clock_skew_last_input_in_future_is_treated_as_zero_elapsed() {
        let now = t(10_000);
        let last = t(11_000); // "in the future"
        assert_eq!(
            step(State::Active, now, last, Duration::from_secs(2)),
            Transition::None
        );
    }

    // ---- watcher integration with a mockable source ----

    struct MockSource {
        ms: Arc<AtomicU32>,
    }

    impl LastInputSource for MockSource {
        fn ms_since_last_input(&self) -> u32 {
            self.ms.load(Ordering::Acquire)
        }
    }

    #[test]
    fn watcher_emits_idle_and_then_active_transitions() {
        let ms = Arc::new(AtomicU32::new(0));
        let watcher = IdleWatcher::new(
            IdleConfig {
                threshold: Duration::from_millis(50),
                poll_interval: Duration::from_millis(5),
            },
            MockSource { ms: ms.clone() },
        );

        let (tx, rx) = channel();
        let handle = watcher.start(tx);

        // Push above threshold — expect IdleSince.
        ms.store(200, Ordering::Release);
        let sig = rx
            .recv_timeout(Duration::from_millis(200))
            .expect("IdleSince within 200ms");
        assert!(matches!(sig, OsSignal::IdleSince { .. }));

        // Push back below threshold — expect IdleEnded.
        ms.store(0, Ordering::Release);
        let sig = rx
            .recv_timeout(Duration::from_millis(200))
            .expect("IdleEnded within 200ms");
        assert!(matches!(sig, OsSignal::IdleEnded { .. }));

        handle.shutdown();
    }

    #[test]
    fn watcher_does_not_flap_when_state_is_stable() {
        let ms = Arc::new(AtomicU32::new(0));
        let watcher = IdleWatcher::new(
            IdleConfig {
                threshold: Duration::from_millis(50),
                poll_interval: Duration::from_millis(5),
            },
            MockSource { ms: ms.clone() },
        );

        let (tx, rx) = channel();
        let handle = watcher.start(tx);

        // Stay well below threshold for a few polls.
        thread::sleep(Duration::from_millis(40));

        // No transition should have fired.
        assert!(matches!(
            rx.recv_timeout(Duration::from_millis(20)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));

        handle.shutdown();
    }
}
