//! Propped keys and mouse jigglers (ADR-0024), from input *timing*
//! only: the last-input time Windows reports, sampled once a second.
//! Nothing about keys, devices or the pointer is read (invariant 1).
//!
//! - **Continuous:** no gap of at least `min_gap` between inputs for
//!   `continuous` (a held or weighted key auto-repeats without pause).
//! - **Periodic:** over `periodic`, ten or more inputs, every gap 2 s or
//!   more and all within 1 s of each other (a jiggler's fixed rhythm).
//!
//! The last-input time is exact to the millisecond, so a gap between
//! two distinct values is the real pause, even at 1 Hz sampling.

use std::collections::VecDeque;
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputPattern {
    Continuous,
    Periodic,
}

impl InputPattern {
    /// `INPUT_IDLE_5M.payload.pattern`.
    pub fn as_str(self) -> &'static str {
        match self {
            InputPattern::Continuous => "continuous",
            InputPattern::Periodic => "periodic",
        }
    }
}

/// `idle.input_pattern_check` (ADR-0024 §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PatternConfig {
    pub continuous: Duration,
    pub periodic: Duration,
    pub min_gap: Duration,
}

impl Default for PatternConfig {
    fn default() -> Self {
        Self {
            continuous: Duration::from_secs(20 * 60),
            periodic: Duration::from_secs(10 * 60),
            min_gap: Duration::from_secs(3),
        }
    }
}

/// Inputs this regular are a machine's rhythm.
const PERIODIC_SPREAD: Duration = Duration::from_secs(1);
/// A rhythm faster than this is people typing, not a jiggler.
const PERIODIC_MIN_GAP: Duration = Duration::from_secs(2);
/// Inputs needed in the window before a rhythm counts.
const PERIODIC_MIN_INPUTS: usize = 10;

#[derive(Debug, Clone, Default)]
pub struct PatternDetector {
    /// The last distinct last-input time seen.
    last: Option<SystemTime>,
    /// Start of the current run with no pause of `min_gap`.
    run_since: Option<SystemTime>,
    /// Distinct input times inside the periodic window.
    inputs: VecDeque<SystemTime>,
}

fn gap(a: SystemTime, b: SystemTime) -> Duration {
    b.duration_since(a).unwrap_or(Duration::ZERO)
}

impl PatternDetector {
    /// Forget everything: a break, a call or a prompt starts afresh.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// One sample. A pattern found now, and when it began.
    pub fn observe(
        &mut self,
        cfg: &PatternConfig,
        last_input_at: SystemTime,
        now: SystemTime,
    ) -> Option<(InputPattern, SystemTime)> {
        let new_input = self.last != Some(last_input_at);
        if new_input {
            // A pause between two inputs ends the continuous run.
            let paused = self
                .last
                .is_some_and(|prev| gap(prev, last_input_at) >= cfg.min_gap);
            if paused || self.run_since.is_none() {
                self.run_since = Some(last_input_at);
            }
            self.last = Some(last_input_at);
            self.inputs.push_back(last_input_at);
        }
        // Quiet right now is a pause too.
        if gap(last_input_at, now) >= cfg.min_gap {
            self.run_since = None;
        }
        while self
            .inputs
            .front()
            .is_some_and(|t| gap(*t, now) > cfg.periodic)
        {
            self.inputs.pop_front();
        }

        if let Some(since) = self.run_since {
            if gap(since, now) >= cfg.continuous {
                return Some((InputPattern::Continuous, since));
            }
        }
        self.periodic(cfg, now)
    }

    fn periodic(&self, cfg: &PatternConfig, now: SystemTime) -> Option<(InputPattern, SystemTime)> {
        if self.inputs.len() < PERIODIC_MIN_INPUTS {
            return None;
        }
        let first = *self.inputs.front()?;
        // The rhythm must fill (most of) the window.
        if gap(first, now) < cfg.periodic.mul_f32(0.9) {
            return None;
        }
        let gaps: Vec<Duration> = self
            .inputs
            .iter()
            .zip(self.inputs.iter().skip(1))
            .map(|(a, b)| gap(*a, *b))
            .collect();
        let min = *gaps.iter().min()?;
        let max = *gaps.iter().max()?;
        (min >= PERIODIC_MIN_GAP && max - min <= PERIODIC_SPREAD)
            .then_some((InputPattern::Periodic, first))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn t(ms: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(1_790_000_000_000 + ms)
    }

    /// Feed a sampler at 1 Hz for `secs`, with inputs from `input_at(ms)`
    /// (the last input at or before each sample). The first detection.
    fn run(
        cfg: &PatternConfig,
        secs: u64,
        inputs: impl Fn(u64) -> u64,
    ) -> Option<(InputPattern, SystemTime, u64)> {
        let mut d = PatternDetector::default();
        for s in 0..secs {
            let now = s * 1000;
            if let Some((p, since)) = d.observe(cfg, t(inputs(now)), t(now)) {
                return Some((p, since, s));
            }
        }
        None
    }

    #[test]
    fn a_held_key_is_continuous_after_the_window() {
        let cfg = PatternConfig::default();
        // Auto-repeat: the last input is always a few ms before the sample.
        let found = run(&cfg, 25 * 60, |now| now.saturating_sub(7));
        let (p, since, at) = found.expect("detected");
        assert_eq!(p, InputPattern::Continuous);
        assert_eq!(since, t(0));
        assert_eq!(at, 20 * 60);
    }

    #[test]
    fn a_person_who_pauses_is_never_continuous() {
        let cfg = PatternConfig::default();
        // Types for 40 s, then a 4 s pause, over and over.
        let typing = |now: u64| {
            let cycle = now % 44_000;
            if cycle < 40_000 {
                now.saturating_sub(30)
            } else {
                now - cycle + 40_000
            }
        };
        assert_eq!(run(&cfg, 60 * 60, typing), None);
    }

    #[test]
    fn a_jiggler_every_30_seconds_is_periodic() {
        let cfg = PatternConfig::default();
        let found = run(&cfg, 15 * 60, |now| now / 30_000 * 30_000);
        let (p, _, at) = found.expect("detected");
        assert_eq!(p, InputPattern::Periodic);
        assert!(
            (9 * 60..=10 * 60).contains(&at),
            "after about the window: {at}"
        );
    }

    #[test]
    fn irregular_mouse_use_is_not_periodic() {
        let cfg = PatternConfig::default();
        // Moves at uneven times: 5 s, 17 s, 9 s, 31 s … apart.
        let marks: Vec<u64> = (0..200u64)
            .scan(0u64, |acc, i| {
                *acc += [5_000, 17_000, 9_000, 31_000, 12_000][(i % 5) as usize];
                Some(*acc)
            })
            .collect();
        let at = |now: u64| {
            marks
                .iter()
                .rev()
                .find(|m| **m <= now)
                .copied()
                .unwrap_or(0)
        };
        assert_eq!(run(&cfg, 20 * 60, at), None);
    }

    #[test]
    fn a_long_quiet_spell_is_idle_not_a_pattern() {
        let cfg = PatternConfig::default();
        assert_eq!(run(&cfg, 30 * 60, |_| 0), None);
    }

    #[test]
    fn reset_starts_again() {
        let cfg = PatternConfig {
            continuous: Duration::from_secs(10),
            ..PatternConfig::default()
        };
        let mut d = PatternDetector::default();
        for s in 1..10 {
            assert_eq!(d.observe(&cfg, t(s * 1000 - 5), t(s * 1000)), None);
        }
        d.reset();
        assert_eq!(d.observe(&cfg, t(10_995), t(11_000)), None, "run restarted");
    }
}
