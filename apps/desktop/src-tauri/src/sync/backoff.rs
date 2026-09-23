//! Exponential backoff calculator for the sync loop.
//!
//! Pure function of `retry_count` → `Duration`. No randomness / jitter
//! yet — will add if we see thundering-herd behaviour once the fleet
//! grows. Overflow is capped by `max`, so extreme `retry_count` values
//! are safe.

use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub struct BackoffPolicy {
    /// Delay on the first failure (`retry_count == 0` → this).
    pub base: Duration,
    /// Multiplier applied per subsequent failure.
    pub factor: u32,
    /// Cap on the returned delay.
    pub max: Duration,
}

impl Default for BackoffPolicy {
    /// 5s → 15s → 45s → 135s → 300s (cap). Roughly aligned with the
    /// backend's own retry policy for downstream failures.
    fn default() -> Self {
        Self {
            base: Duration::from_secs(5),
            factor: 3,
            max: Duration::from_secs(300),
        }
    }
}

impl BackoffPolicy {
    /// Delay before the next retry given the failure count so far.
    /// `retry_count == 0` returns `base`.
    pub fn delay(&self, retry_count: u32) -> Duration {
        let base = self.base.as_secs();
        let factor = self.factor.max(1) as u64;
        let raw = base.saturating_mul(factor.saturating_pow(retry_count));
        let capped = raw.min(self.max.as_secs());
        Duration::from_secs(capped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_produce_the_expected_ladder() {
        let p = BackoffPolicy::default();
        assert_eq!(p.delay(0), Duration::from_secs(5));
        assert_eq!(p.delay(1), Duration::from_secs(15));
        assert_eq!(p.delay(2), Duration::from_secs(45));
        assert_eq!(p.delay(3), Duration::from_secs(135));
    }

    #[test]
    fn ladder_caps_at_max() {
        let p = BackoffPolicy::default();
        assert_eq!(p.delay(4), Duration::from_secs(300));
        assert_eq!(p.delay(100), Duration::from_secs(300));
        assert_eq!(p.delay(u32::MAX), Duration::from_secs(300));
    }

    #[test]
    fn custom_policy_is_honoured() {
        let p = BackoffPolicy {
            base: Duration::from_secs(1),
            factor: 2,
            max: Duration::from_secs(60),
        };
        assert_eq!(p.delay(0), Duration::from_secs(1));
        assert_eq!(p.delay(1), Duration::from_secs(2));
        assert_eq!(p.delay(5), Duration::from_secs(32));
        assert_eq!(p.delay(10), Duration::from_secs(60));
    }

    #[test]
    fn factor_zero_is_treated_as_one() {
        let p = BackoffPolicy {
            base: Duration::from_secs(7),
            factor: 0,
            max: Duration::from_secs(60),
        };
        assert_eq!(p.delay(0), Duration::from_secs(7));
        assert_eq!(p.delay(5), Duration::from_secs(7));
    }
}
