//! One machine at a time (ADR-0028), the desktop side.
//!
//! `GET /v1/me/active-device?device_id=` answers two questions:
//!   - did an admin sign **this** computer out (`this_device.signed_out`)?
//!   - is the person clocked in on **another** computer (`elsewhere`)?
//!
//! The app asks right after sign-in and enrolment, before enrolling on
//! a silent start-up sign-in, on every policy poll (15 min), and when
//! the person presses "Check again". [`decide`] turns the answer into
//! what the app does. Network trouble never blocks anyone (fail open):
//! the next poll asks again, and a clock-in the server still refuses is
//! caught by the sync loop (`multi_device_conflict`).
//!
//! Nothing new is collected: the request carries this device's id, and
//! the answer names the other computer's OS and times only (its
//! hostname is stored hashed server-side, so the app never shows one).

use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::Value;

/// The other computer the person is clocked in on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Elsewhere {
    pub device_id: String,
    /// `windows` | `macos`, or `None` if the server sent anything else.
    pub os: Option<&'static str>,
    /// When the open session there started (RFC 3339), if given.
    pub opened_at: Option<String>,
}

/// The server's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveDevice {
    /// An admin signed this computer out (ADR-0028 §4).
    pub signed_out: bool,
    pub elsewhere: Option<Elsewhere>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckError {
    /// Network, 5xx, 401/429 or an unreadable body: fail open.
    Unavailable(String),
    /// A definite refusal, e.g. `unknown_device` (404). Also fail open:
    /// the device may simply not be enrolled yet.
    Refused(String),
}

/// What the webview shows while blocked (`StateView.blockedElsewhere`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedView {
    /// `windows` | `macos`; `None` until the server has said.
    pub os: Option<&'static str>,
    /// Clocked in there since (epoch ms), if known.
    pub opened_at: Option<u64>,
}

impl BlockedView {
    /// From a `multi_device_conflict` refusal, which carries the other
    /// session's `opened_at` but not its OS.
    pub fn from_conflict(opened_at: Option<&str>) -> Self {
        Self {
            os: None,
            opened_at: opened_at.and_then(epoch_ms),
        }
    }
}

impl From<&Elsewhere> for BlockedView {
    fn from(e: &Elsewhere) -> Self {
        Self {
            os: e.os,
            opened_at: e.opened_at.as_deref().and_then(epoch_ms),
        }
    }
}

/// What the app does with an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Leave everything as it is.
    Keep,
    /// No clock-in here: show the blocked screen.
    Block(BlockedView),
    /// Nothing open elsewhere: clocking in is allowed again.
    Unblock,
    /// An admin signed this computer out: sign out locally, keeping
    /// unsent events, without recording a clock-out.
    SignOut,
}

/// Pure: the action for `answer`.
///
/// - Signed out by an admin wins, even while clocked in here: the
///   server already closed that session.
/// - Clocked in elsewhere blocks only while clocked out here. Clocked
///   in here as well means this computer's session hasn't reached the
///   server yet; the sync loop's `multi_device_conflict` settles that.
/// - A check that fails changes nothing (fail open).
pub fn decide(
    answer: &Result<ActiveDevice, CheckError>,
    this_device: &str,
    clocked_out: bool,
) -> Action {
    let Ok(a) = answer else {
        return Action::Keep;
    };
    if a.signed_out {
        return Action::SignOut;
    }
    match &a.elsewhere {
        // Never blocked by itself, whatever the server says.
        Some(e) if e.device_id == this_device => Action::Unblock,
        Some(e) if clocked_out => Action::Block(e.into()),
        Some(_) => Action::Keep,
        None => Action::Unblock,
    }
}

/// `GET {base}/v1/me/active-device?device_id={device_id}`.
pub fn check(
    http: &Client,
    base_url: &str,
    token: &str,
    device_id: &str,
) -> Result<ActiveDevice, CheckError> {
    let id: String = url::form_urlencoded::byte_serialize(device_id.as_bytes()).collect();
    let resp = http
        .get(format!(
            "{}/v1/me/active-device?device_id={id}",
            base_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .send()
        .map_err(|e| CheckError::Unavailable(format!("http error: {e}")))?;
    let status = resp.status();
    let body: Value = resp.json().unwrap_or(Value::Null);
    if status.is_success() {
        return parse(&body).ok_or_else(|| CheckError::Unavailable("malformed answer".into()));
    }
    match status.as_u16() {
        401 | 429 => Err(CheckError::Unavailable(format!("HTTP {}", status.as_u16()))),
        s @ 400..=499 => Err(CheckError::Refused(
            body["code"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("http_{s}")),
        )),
        s => Err(CheckError::Unavailable(format!("HTTP {s}"))),
    }
}

fn parse(body: &Value) -> Option<ActiveDevice> {
    let signed_out = body["this_device"]["signed_out"].as_bool()?;
    let elsewhere = match &body["elsewhere"] {
        Value::Null => None,
        e @ Value::Object(_) => Some(Elsewhere {
            device_id: e["device_id"].as_str()?.to_string(),
            os: match e["os"].as_str() {
                Some("windows") => Some("windows"),
                Some("macos") => Some("macos"),
                _ => None,
            },
            opened_at: e["opened_at"].as_str().map(str::to_string),
        }),
        _ => return None,
    };
    Some(ActiveDevice {
        signed_out,
        elsewhere,
    })
}

/// RFC 3339 to epoch ms; `None` if unreadable or before 1970.
fn epoch_ms(s: &str) -> Option<u64> {
    let t = chrono::DateTime::parse_from_rfc3339(s).ok()?;
    u64::try_from(t.timestamp_millis()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use serde_json::json;
    use std::time::Duration;

    const ME: &str = "33333333-3333-4333-8333-333333333333";
    const OTHER: &str = "55555555-5555-4555-8555-555555555555";

    fn client() -> Client {
        Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
    }

    fn answer(server: &MockServer, status: u16, body: Value) -> Result<ActiveDevice, CheckError> {
        let m = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/me/active-device")
                .query_param("device_id", ME)
                .header("authorization", "Bearer tok");
            then.status(status).json_body(body);
        });
        let got = check(&client(), &server.base_url(), "tok", ME);
        m.assert();
        got
    }

    #[test]
    fn clocked_in_elsewhere_is_read_with_its_os_and_start() {
        let server = MockServer::start();
        let got = answer(
            &server,
            200,
            json!({
                "this_device": { "signed_out": false },
                "elsewhere": {
                    "device_id": OTHER,
                    "os": "macos",
                    "enrolled_at": "2026-09-01T04:00:00Z",
                    "opened_at": "2026-09-30T03:32:00Z"
                }
            }),
        )
        .unwrap();
        let e = got.elsewhere.clone().unwrap();
        assert!(!got.signed_out);
        assert_eq!(e.device_id, OTHER);
        assert_eq!(e.os, Some("macos"));
        assert_eq!(
            BlockedView::from(&e).opened_at,
            Some(epoch_ms("2026-09-30T03:32:00Z").unwrap())
        );
    }

    #[test]
    fn nothing_elsewhere_and_signed_out_are_read() {
        let server = MockServer::start();
        let free = answer(
            &server,
            200,
            json!({ "this_device": { "signed_out": false }, "elsewhere": null }),
        );
        assert_eq!(
            free,
            Ok(ActiveDevice {
                signed_out: false,
                elsewhere: None
            })
        );
        let server = MockServer::start();
        let out = answer(
            &server,
            200,
            json!({ "this_device": { "signed_out": true }, "elsewhere": null }),
        );
        assert!(out.unwrap().signed_out);
    }

    #[test]
    fn an_unknown_os_is_not_guessed() {
        let body = json!({
            "this_device": { "signed_out": false },
            "elsewhere": { "device_id": OTHER, "os": "linux", "opened_at": null }
        });
        let e = parse(&body).unwrap().elsewhere.unwrap();
        assert_eq!(e.os, None);
        assert_eq!(BlockedView::from(&e).opened_at, None);
    }

    #[test]
    fn unknown_device_is_a_refusal_and_malformed_or_5xx_is_unavailable() {
        let server = MockServer::start();
        assert_eq!(
            answer(&server, 404, json!({ "code": "unknown_device" })),
            Err(CheckError::Refused("unknown_device".into()))
        );
        let server = MockServer::start();
        assert!(matches!(
            answer(&server, 200, json!({ "elsewhere": null })),
            Err(CheckError::Unavailable(_))
        ));
        let server = MockServer::start();
        assert!(matches!(
            answer(&server, 503, json!({})),
            Err(CheckError::Unavailable(_))
        ));
        let server = MockServer::start();
        assert!(matches!(
            answer(&server, 401, json!({ "code": "invalid_token" })),
            Err(CheckError::Unavailable(_))
        ));
    }

    /// 400 (missing or non-UUID device id) and 403 `no_user_for_oid`
    /// never block anyone.
    #[test]
    fn bad_request_and_no_user_fail_open() {
        let server = MockServer::start();
        let bad = answer(&server, 400, json!({ "code": "validation" }));
        assert_eq!(bad, Err(CheckError::Refused("validation".into())));
        assert_eq!(decide(&bad, ME, true), Action::Keep);
        let server = MockServer::start();
        let no_user = answer(&server, 403, json!({ "code": "no_user_for_oid" }));
        assert_eq!(no_user, Err(CheckError::Refused("no_user_for_oid".into())));
        assert_eq!(decide(&no_user, ME, true), Action::Keep);
    }

    #[test]
    fn a_network_error_fails_open() {
        let got = check(&client(), "http://127.0.0.1:1", "tok", ME);
        assert!(matches!(got, Err(CheckError::Unavailable(_))));
        assert_eq!(decide(&got, ME, true), Action::Keep);
    }

    fn elsewhere(os: Option<&'static str>) -> Result<ActiveDevice, CheckError> {
        Ok(ActiveDevice {
            signed_out: false,
            elsewhere: Some(Elsewhere {
                device_id: OTHER.into(),
                os,
                opened_at: Some("2026-09-30T03:32:00Z".into()),
            }),
        })
    }

    #[test]
    fn clocked_in_elsewhere_blocks_only_while_clocked_out_here() {
        let blocked = decide(&elsewhere(Some("windows")), ME, true);
        assert_eq!(
            blocked,
            Action::Block(BlockedView {
                os: Some("windows"),
                opened_at: epoch_ms("2026-09-30T03:32:00Z"),
            })
        );
        // Clocked in here too: the sync loop's conflict decides.
        assert_eq!(decide(&elsewhere(Some("windows")), ME, false), Action::Keep);
    }

    #[test]
    fn nothing_elsewhere_unblocks_and_signed_out_wins() {
        let free = Ok(ActiveDevice {
            signed_out: false,
            elsewhere: None,
        });
        assert_eq!(decide(&free, ME, true), Action::Unblock);
        let out = Ok(ActiveDevice {
            signed_out: true,
            elsewhere: None,
        });
        assert_eq!(decide(&out, ME, false), Action::SignOut);
        let mut both = elsewhere(None).unwrap();
        both.signed_out = true;
        assert_eq!(decide(&Ok(both), ME, true), Action::SignOut);
    }

    #[test]
    fn refusals_fail_open_and_this_device_never_blocks_itself() {
        let refused = Err(CheckError::Refused("unknown_device".into()));
        assert_eq!(decide(&refused, ME, true), Action::Keep);
        let mut me = elsewhere(Some("windows")).unwrap();
        me.elsewhere.as_mut().unwrap().device_id = ME.into();
        assert_eq!(decide(&Ok(me), ME, true), Action::Unblock);
    }

    #[test]
    fn a_conflict_gives_the_start_without_an_os() {
        let b = BlockedView::from_conflict(Some("2026-09-30T03:32:00.000Z"));
        assert_eq!(b.os, None);
        assert_eq!(b.opened_at, epoch_ms("2026-09-30T03:32:00Z"));
        assert_eq!(
            BlockedView::from_conflict(Some("yesterday")).opened_at,
            None
        );
        assert_eq!(BlockedView::from_conflict(None).opened_at, None);
    }
}
