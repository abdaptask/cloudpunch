//! Turning polled OS state into [`OsSignal`]s (ADR-0026 §2). Where an
//! OS offers no notification the app can use without extra frameworks
//! (macOS), a 1 Hz poller samples the state and this pure step says
//! what changed. Tested on every platform.
//!
//! - **Lock / unlock:** the locked flag flipping.
//! - **Sleep / wake:** the wall clock jumping far past the poll interval
//!   (the process was suspended), dated at the last sample and now.
//! - **Network:** reachability flipping.

use std::time::{Duration, SystemTime};

use super::OsSignal;

/// A wall-clock jump longer than this between samples was a sleep.
pub const SLEEP_GAP: Duration = Duration::from_secs(20);

/// One sample of polled state. `None` means the OS couldn't say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    pub at: SystemTime,
    pub locked: Option<bool>,
    pub reachable: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct PollState {
    last_at: Option<SystemTime>,
    locked: Option<bool>,
    reachable: Option<bool>,
}

impl PollState {
    /// The signals `s` implies, given the previous samples.
    pub fn step(&mut self, s: Sample) -> Vec<OsSignal> {
        let mut out = Vec::new();
        if let Some(prev) = self.last_at {
            if s.at.duration_since(prev).is_ok_and(|gap| gap > SLEEP_GAP) {
                out.push(OsSignal::Suspending { at: prev });
                out.push(OsSignal::Resumed { at: s.at });
            }
        }
        self.last_at = Some(s.at);

        if let Some(locked) = s.locked {
            // The first sample only sets the baseline.
            if self.locked.is_some_and(|was| was != locked) {
                out.push(if locked {
                    OsSignal::SessionLocked { at: s.at }
                } else {
                    OsSignal::SessionUnlocked { at: s.at }
                });
            }
            self.locked = Some(locked);
        }
        if let Some(reachable) = s.reachable {
            if self.reachable != Some(reachable) {
                out.push(OsSignal::NetworkReachabilityChanged {
                    reachable,
                    at: s.at,
                });
            }
            self.reachable = Some(reachable);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn t(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_790_000_000 + secs)
    }

    fn sample(secs: u64, locked: Option<bool>, reachable: Option<bool>) -> Sample {
        Sample {
            at: t(secs),
            locked,
            reachable,
        }
    }

    #[test]
    fn lock_and_unlock_are_edges_after_the_baseline() {
        let mut p = PollState::default();
        assert!(p.step(sample(0, Some(false), None)).is_empty(), "baseline");
        assert!(p.step(sample(1, Some(false), None)).is_empty());
        assert_eq!(
            p.step(sample(2, Some(true), None)),
            [OsSignal::SessionLocked { at: t(2) }]
        );
        assert_eq!(
            p.step(sample(3, Some(false), None)),
            [OsSignal::SessionUnlocked { at: t(3) }]
        );
        // Unknown keeps the last known state.
        assert!(p.step(sample(4, None, None)).is_empty());
        assert!(p.step(sample(5, Some(false), None)).is_empty());
    }

    #[test]
    fn a_long_gap_between_samples_is_a_sleep_and_wake() {
        let mut p = PollState::default();
        p.step(sample(0, None, None));
        assert!(p.step(sample(1, None, None)).is_empty());
        assert_eq!(
            p.step(sample(3_600, None, None)),
            [
                OsSignal::Suspending { at: t(1) },
                OsSignal::Resumed { at: t(3_600) }
            ]
        );
        // A slow sample (under the gap) is not a sleep.
        assert!(p.step(sample(3_615, None, None)).is_empty());
    }

    #[test]
    fn network_reports_the_first_state_then_changes() {
        let mut p = PollState::default();
        assert_eq!(
            p.step(sample(0, None, Some(true))),
            [OsSignal::NetworkReachabilityChanged {
                reachable: true,
                at: t(0)
            }]
        );
        assert!(p.step(sample(5, None, Some(true))).is_empty());
        assert_eq!(
            p.step(sample(10, None, Some(false))),
            [OsSignal::NetworkReachabilityChanged {
                reachable: false,
                at: t(10)
            }]
        );
    }
}
