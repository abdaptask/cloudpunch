//! Past days on the home screen (ADR-0016): fetches one working day
//! from `GET /v1/me/days/{date}` and keeps what it fetched in memory,
//! so a day already seen still shows when the backend can't be reached.
//! The cache belongs to one signed-in user and is emptied at sign-out.
//! Nothing is written to disk.

use std::collections::HashMap;
use std::sync::Mutex;

use reqwest::blocking::Client;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum DayError {
    /// Network, 5xx, 401/429 or an unreadable body: show the cached
    /// copy, or "offline".
    Unavailable(String),
    /// A definite answer (e.g. `date_out_of_range`, `no_employee`).
    Refused(String),
}

/// `YYYY-MM-DD`, digits only (the date goes into the URL path).
pub fn valid_date(date: &str) -> bool {
    let b = date.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// `GET {base}/v1/me/days/{date}`. The body is passed to the UI as is.
pub fn fetch(http: &Client, base_url: &str, token: &str, date: &str) -> Result<Value, DayError> {
    if !valid_date(date) {
        return Err(DayError::Refused("invalid_argument".into()));
    }
    let resp = http
        .get(format!(
            "{}/v1/me/days/{date}",
            base_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .send()
        .map_err(|e| DayError::Unavailable(format!("http error: {e}")))?;
    let status = resp.status();
    let body: Value = resp.json().unwrap_or(Value::Null);
    if status.is_success() {
        return if body["sessions"].is_array() {
            Ok(body)
        } else {
            Err(DayError::Unavailable("malformed day response".into()))
        };
    }
    let code = body["code"].as_str().unwrap_or("").to_string();
    match status.as_u16() {
        401 | 429 => Err(DayError::Unavailable(format!("HTTP {}", status.as_u16()))),
        400..=499 => Err(DayError::Refused(if code.is_empty() {
            format!("http_{}", status.as_u16())
        } else {
            code
        })),
        s => Err(DayError::Unavailable(format!("HTTP {s}"))),
    }
}

/// Days fetched this run, for one user.
#[derive(Default)]
pub struct DayCache {
    inner: Mutex<Option<(String, HashMap<String, Value>)>>,
}

impl DayCache {
    pub fn put(&self, oid: &str, date: &str, day: Value) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match inner.as_mut() {
            Some((owner, days)) if owner == oid => {
                days.insert(date.to_string(), day);
            }
            _ => *inner = Some((oid.to_string(), HashMap::from([(date.to_string(), day)]))),
        }
    }

    pub fn get(&self, oid: &str, date: &str) -> Option<Value> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match inner.as_ref() {
            Some((owner, days)) if owner == oid => days.get(date).cloned(),
            _ => None,
        }
    }

    pub fn clear(&self) {
        *self.inner.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use serde_json::json;
    use std::time::Duration;

    fn client() -> Client {
        Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
    }

    #[test]
    fn valid_date_accepts_only_yyyy_mm_dd() {
        assert!(valid_date("2026-09-25"));
        for bad in [
            "2026-9-25",
            "2026/09/25",
            "../../x",
            "2026-09-2a",
            "",
            "2026-09-255",
        ] {
            assert!(!valid_date(bad), "{bad}");
        }
    }

    #[test]
    fn fetch_returns_the_day_with_the_bearer_token() {
        let server = MockServer::start();
        let day = json!({ "date": "2026-09-24", "sessions": [], "totals": {} });
        let m = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/me/days/2026-09-24")
                .header("authorization", "Bearer tok");
            then.status(200).json_body(day.clone());
        });
        let got = fetch(&client(), &server.base_url(), "tok", "2026-09-24").unwrap();
        assert_eq!(got, day);
        m.assert();
    }

    #[test]
    fn fetch_errors_are_split_into_unavailable_and_refused() {
        let cases = [
            (
                400,
                json!({ "code": "date_out_of_range" }),
                Some("date_out_of_range"),
            ),
            (404, json!({ "code": "no_employee" }), Some("no_employee")),
            (401, json!({}), None),
            (503, json!({}), None),
        ];
        for (status, body, refused) in cases {
            let server = MockServer::start();
            server.mock(|when, then| {
                when.method(GET).path("/v1/me/days/2026-09-24");
                then.status(status).json_body(body.clone());
            });
            let err = fetch(&client(), &server.base_url(), "tok", "2026-09-24").unwrap_err();
            match refused {
                Some(code) => assert_eq!(err, DayError::Refused(code.into())),
                None => assert!(matches!(err, DayError::Unavailable(_)), "{status}"),
            }
        }
        assert!(matches!(
            fetch(&client(), "http://127.0.0.1:9", "tok", "2026-09-24"),
            Err(DayError::Unavailable(_))
        ));
        assert_eq!(
            fetch(&client(), "http://127.0.0.1:9", "tok", "../x"),
            Err(DayError::Refused("invalid_argument".into()))
        );
    }

    #[test]
    fn the_cache_is_per_user_and_clears() {
        let cache = DayCache::default();
        cache.put("a", "2026-09-24", json!(1));
        assert_eq!(cache.get("a", "2026-09-24"), Some(json!(1)));
        assert_eq!(cache.get("b", "2026-09-24"), None);
        // A different user replaces the whole cache.
        cache.put("b", "2026-09-23", json!(2));
        assert_eq!(cache.get("a", "2026-09-24"), None);
        cache.clear();
        assert_eq!(cache.get("b", "2026-09-23"), None);
    }
}
