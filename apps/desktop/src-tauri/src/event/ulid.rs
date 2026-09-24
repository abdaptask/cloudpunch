//! Monotonic ULIDs (ADR-0004 §3).
//!
//! 48-bit millisecond timestamp + 80 random bits, Crockford base32, 26
//! characters. Within one generator, IDs are strictly increasing: a
//! second ID in the same millisecond (or after the wall clock stepped
//! back) keeps the previous timestamp and increments the random part,
//! so sort order always matches emission order within a session.

use std::time::{SystemTime, UNIX_EPOCH};

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_BITS: u32 = 80;
const RANDOM_MASK: u128 = (1u128 << RANDOM_BITS) - 1;
const MAX_TIMESTAMP_MS: u64 = (1u64 << 48) - 1;

/// Encode 128 bits as 26 Crockford base32 characters.
pub fn encode(value: u128) -> String {
    let mut out = [0u8; 26];
    let mut v = value;
    for slot in out.iter_mut().rev() {
        *slot = ALPHABET[(v & 0x1f) as usize];
        v >>= 5;
    }
    String::from_utf8(out.to_vec()).expect("alphabet is ASCII")
}

/// Per-session generator.
#[derive(Debug, Default)]
pub struct UlidGenerator {
    last_ms: u64,
    last_random: u128,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum UlidError {
    #[error("random number generator failed: {0}")]
    Rng(String),
    #[error("system clock is before 1970 or after 10889")]
    Clock,
}

impl UlidGenerator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Next ULID at wall-clock time `now`.
    pub fn next(&mut self, now: SystemTime) -> Result<String, UlidError> {
        let ms = now
            .duration_since(UNIX_EPOCH)
            .map_err(|_| UlidError::Clock)?
            .as_millis();
        let ms = u64::try_from(ms)
            .ok()
            .filter(|m| *m <= MAX_TIMESTAMP_MS)
            .ok_or(UlidError::Clock)?;
        self.next_at_ms(ms, random_80)
    }

    /// Testable core: `fresh` supplies 80 random bits.
    fn next_at_ms(
        &mut self,
        ms: u64,
        fresh: impl Fn() -> Result<u128, UlidError>,
    ) -> Result<String, UlidError> {
        if ms > self.last_ms {
            self.last_ms = ms;
            self.last_random = fresh()? & RANDOM_MASK;
        } else if self.last_random == RANDOM_MASK {
            // Random part exhausted within one millisecond: borrow the
            // next millisecond rather than repeat or go backwards.
            self.last_ms += 1;
            self.last_random = 0;
        } else {
            self.last_random += 1;
        }
        Ok(encode(
            (u128::from(self.last_ms) << RANDOM_BITS) | self.last_random,
        ))
    }
}

fn random_80() -> Result<u128, UlidError> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b[6..]).map_err(|e| UlidError::Rng(e.to_string()))?;
    Ok(u128::from_be_bytes(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn is_ulid(s: &str) -> bool {
        s.len() == 26 && s.bytes().all(|c| ALPHABET.contains(&c))
    }

    #[test]
    fn spec_timestamp_prefix() {
        // ULID spec README: 01ARZ3NDEK encodes 1469922850259 ms.
        let mut g = UlidGenerator::new();
        let id = g.next_at_ms(1_469_922_850_259, || Ok(0)).unwrap();
        assert_eq!(&id[..10], "01ARZ3NDEK");
        assert_eq!(&id[10..], "0000000000000000");
    }

    #[test]
    fn encodes_max_value() {
        // ULID spec: the largest valid ULID.
        assert_eq!(encode(u128::MAX), "7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
        assert_eq!(encode(0), "00000000000000000000000000");
    }

    #[test]
    fn same_millisecond_increments_and_sorts() {
        let mut g = UlidGenerator::new();
        let a = g.next_at_ms(1000, || Ok(41)).unwrap();
        let b = g.next_at_ms(1000, || Ok(7)).unwrap();
        let c = g.next_at_ms(1000, || Ok(7)).unwrap();
        assert!(a < b && b < c, "{a} {b} {c}");
        assert_eq!(&a[..10], &b[..10]);
    }

    #[test]
    fn clock_stepping_back_never_goes_backwards() {
        let mut g = UlidGenerator::new();
        let a = g.next_at_ms(5000, || Ok(1)).unwrap();
        let b = g.next_at_ms(4000, || Ok(1)).unwrap();
        assert!(b > a);
    }

    #[test]
    fn exhausted_random_part_rolls_into_next_millisecond() {
        let mut g = UlidGenerator::new();
        let a = g.next_at_ms(9000, || Ok(RANDOM_MASK)).unwrap();
        let b = g.next_at_ms(9000, || Ok(0)).unwrap();
        assert!(b > a);
        assert_ne!(&a[..10], &b[..10]);
    }

    #[test]
    fn real_ids_match_the_backend_pattern_and_increase() {
        let mut g = UlidGenerator::new();
        let now = SystemTime::now();
        let ids: Vec<_> = (0..200)
            .map(|i| g.next(now + Duration::from_micros(i)).unwrap())
            .collect();
        assert!(ids.iter().all(|id| is_ulid(id)));
        assert!(ids.windows(2).all(|w| w[0] < w[1]));
    }
}
