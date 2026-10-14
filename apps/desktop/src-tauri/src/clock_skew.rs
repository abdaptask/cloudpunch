//! Is this computer's clock right? (owner, 2026-10-14)
//!
//! The server refuses events stamped more than 10 s ahead of it, and a
//! clock far behind dates the day wrongly. The app asks the server for
//! the time (the HTTP `Date` header of `/readyz`, no sign-in needed)
//! now and then and, when the clock is off, says so on screen with how
//! to fix it. Nothing about the clock is sent anywhere.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Ahead by more than this: the server may refuse events.
pub const AHEAD_LIMIT_MS: i64 = 5_000;
/// Behind by more than this: times are noticeably early.
pub const BEHIND_LIMIT_MS: i64 = 120_000;
/// How often to look again.
pub const EVERY: Duration = Duration::from_secs(10 * 60);

/// The computer's clock is off by `seconds`, ahead (fast) or behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockSkew {
    pub ahead: bool,
    pub seconds: u64,
}

fn ms(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Pure: how far this clock is ahead of the server's (ms; negative:
/// behind), from a response's `Date` header and when the request went
/// out and came back. The header has whole seconds, so the server's
/// time is taken as the middle of that second.
pub fn skew_ms(date_header: &str, sent: SystemTime, received: SystemTime) -> Option<i64> {
    let server = chrono::DateTime::parse_from_rfc2822(date_header.trim()).ok()?;
    let server_ms = server.timestamp_millis() + 500;
    let local_ms = (ms(sent) + ms(received)) / 2;
    Some(local_ms - server_ms)
}

/// Pure: whether to warn, and about what.
pub fn verdict(skew_ms: i64) -> Option<ClockSkew> {
    if skew_ms > AHEAD_LIMIT_MS {
        Some(ClockSkew {
            ahead: true,
            seconds: (skew_ms / 1000) as u64,
        })
    } else if skew_ms < -BEHIND_LIMIT_MS {
        Some(ClockSkew {
            ahead: false,
            seconds: (-skew_ms / 1000) as u64,
        })
    } else {
        None
    }
}

/// Ask the server once. `None` when it can't be reached (no verdict
/// then: keep what was known).
pub fn measure(base: &str) -> Option<i64> {
    let client = crate::backend_http::client_builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let sent = SystemTime::now();
    let res = client
        .get(format!("{}/readyz", base.trim_end_matches('/')))
        .send()
        .ok()?;
    let received = SystemTime::now();
    // A slow answer can't tell seconds apart.
    if received.duration_since(sent).unwrap_or_default() > Duration::from_secs(3) {
        return None;
    }
    let date = res.headers().get(reqwest::header::DATE)?.to_str().ok()?;
    skew_ms(date, sent, received)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: u64, millis: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs) + Duration::from_millis(millis)
    }

    // Tue, 14 Oct 2026 09:30:00 GMT
    const SERVER: u64 = 1_791_970_200;

    #[test]
    fn reads_the_date_header_against_the_middle_of_the_request() {
        let date = "Wed, 14 Oct 2026 09:30:00 GMT";
        // Our clock reads 150.5 s later than the server's (+0.5 s middle).
        let sent = at(SERVER + 150, 900);
        let received = at(SERVER + 151, 100);
        assert_eq!(skew_ms(date, sent, received), Some(150_500));
        assert_eq!(skew_ms("not a date", sent, received), None);
    }

    #[test]
    fn warns_only_beyond_the_limits() {
        assert_eq!(verdict(4_000), None);
        assert_eq!(
            verdict(150_000),
            Some(ClockSkew {
                ahead: true,
                seconds: 150
            })
        );
        assert_eq!(verdict(-90_000), None);
        assert_eq!(
            verdict(-300_000),
            Some(ClockSkew {
                ahead: false,
                seconds: 300
            })
        );
    }
}
