//! reqwest-based [`BackendClient`] impl.
//!
//! Blocking client because the sync loop is synchronous. TLS uses
//! rustls + native system CA store — no OpenSSL surface in the sync
//! path (SQLCipher's vendored OpenSSL is not linked into reqwest).
//!
//! Response mapping — see the discriminated enum in
//! [`super::client::SendBatchResponse`] for the semantics of each
//! variant:
//!   - 200 → parse `results[]`, one `PerEventResult` per entry.
//!   - 400 → `ValidationFailed`.
//!   - 403 → `AuthDenied`.
//!   - 409 with `code = "device_*"`  → `DeviceInvalid`.
//!   - 409 with `code = "session_*"` → `SessionInvalid`.
//!   - 409 with `code = "multi_device_conflict"` → `MultiDeviceConflict`.
//!   - 5xx / network / timeout / body-parse → `Transient`.

use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde_json::{json, Value};

use super::client::{
    BackendClient, PerEventOutcome, PerEventResult, SendBatchResponse, SessionEnvelope,
};

/// Supplies a bearer token for each request (the app passes the
/// signed-in user's Entra access token, refreshed as needed). An error
/// makes that batch `Transient`.
pub type TokenSource = Box<dyn Fn() -> Result<String, String> + Send + Sync>;

pub struct ReqwestBackendClient {
    base_url: String,
    token: TokenSource,
    http: Client,
}

impl ReqwestBackendClient {
    /// `base_url` should NOT include the `/v1/events` path — it's
    /// appended internally so we can hit different routes from the
    /// same client later. Uses one fixed bearer token (tests).
    pub fn new(base_url: impl Into<String>, bearer_token: impl Into<String>) -> Self {
        let token = bearer_token.into();
        Self::with_token_source(base_url, Box::new(move || Ok(token.clone())))
    }

    /// A client that asks `token` for a bearer token on every batch.
    pub fn with_token_source(base_url: impl Into<String>, token: TokenSource) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest Client::builder is infallible for this config");
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token,
            http,
        }
    }
}

impl BackendClient for ReqwestBackendClient {
    fn send_batch(&self, envelope: &SessionEnvelope) -> SendBatchResponse {
        // Each event_body is stored as raw canonical JSON bytes.
        // Parse to serde_json::Value so it embeds as JSON in the
        // batch envelope (not as an escaped string).
        let mut events_json = Vec::with_capacity(envelope.events.len());
        for e in &envelope.events {
            match serde_json::from_slice::<Value>(&e.event_body) {
                Ok(v) => events_json.push(v),
                Err(err) => {
                    return SendBatchResponse::Transient(format!(
                        "event_body is not valid JSON at {}: {err}",
                        e.event_ulid
                    ));
                }
            }
        }

        let body = json!({
            "device_id": envelope.device_id,
            "session_id": envelope.session_id,
            "employee_id": envelope.employee_id,
            "correlation_id": envelope.correlation_id,
            "take_over": envelope.take_over,
            "events": events_json,
        });

        let bearer = match (self.token)() {
            Ok(t) => t,
            Err(e) => return SendBatchResponse::Transient(format!("token: {e}")),
        };
        let url = format!("{}/v1/events", self.base_url);
        let response = self.http.post(&url).bearer_auth(&bearer).json(&body).send();

        let resp = match response {
            Ok(r) => r,
            Err(err) => return SendBatchResponse::Transient(format!("http error: {err}")),
        };

        let status = resp.status();
        let body_bytes = match resp.bytes() {
            Ok(b) => b,
            Err(err) => {
                return SendBatchResponse::Transient(format!(
                    "http {} body read error: {err}",
                    status.as_u16()
                ))
            }
        };
        map_status_and_body(status, &body_bytes)
    }
}

fn map_status_and_body(status: StatusCode, body: &[u8]) -> SendBatchResponse {
    if status.is_success() {
        return parse_accepted_body(body).unwrap_or_else(|e| {
            SendBatchResponse::Transient(format!("200 body parse error: {e}"))
        });
    }
    match status {
        StatusCode::BAD_REQUEST => SendBatchResponse::ValidationFailed {
            message: extract_message(body).unwrap_or_else(|| "validation failed".into()),
        },
        StatusCode::FORBIDDEN => SendBatchResponse::AuthDenied {
            reason: extract_code_or_message(body).unwrap_or_else(|| "forbidden".into()),
        },
        StatusCode::CONFLICT => map_conflict_body(body),
        s if s.is_server_error() => {
            SendBatchResponse::Transient(format!("HTTP {}", status.as_u16()))
        }
        _ => SendBatchResponse::Transient(format!("unexpected HTTP {}", status.as_u16())),
    }
}

fn parse_accepted_body(body: &[u8]) -> Result<SendBatchResponse, String> {
    let v: Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let results = v
        .get("results")
        .and_then(|r| r.as_array())
        .ok_or_else(|| "missing results array".to_string())?;
    let mut per_event = Vec::with_capacity(results.len());
    for r in results {
        let event_ulid = r
            .get("event_ulid")
            .and_then(|s| s.as_str())
            .ok_or_else(|| "result missing event_ulid".to_string())?
            .to_string();
        let status_str = r
            .get("status")
            .and_then(|s| s.as_str())
            .ok_or_else(|| "result missing status".to_string())?;
        let outcome = match status_str {
            "accepted" => PerEventOutcome::Accepted,
            "duplicate_noop" => PerEventOutcome::DuplicateNoop,
            "rejected" => PerEventOutcome::Rejected {
                code: r
                    .get("code")
                    .and_then(|s| s.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                message: r
                    .get("message")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string(),
            },
            other => return Err(format!("unknown per-event status: {other}")),
        };
        per_event.push(PerEventResult {
            event_ulid,
            outcome,
        });
    }
    Ok(SendBatchResponse::Accepted { results: per_event })
}

fn map_conflict_body(body: &[u8]) -> SendBatchResponse {
    let v: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return SendBatchResponse::Transient("409 body not JSON".to_string()),
    };
    let code = v.get("code").and_then(|s| s.as_str()).unwrap_or("");
    match code {
        "multi_device_conflict" => SendBatchResponse::MultiDeviceConflict {
            existing_session_id: v
                .get("existing_session_id")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string(),
            existing_device_id: v
                .get("existing_device_id")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string(),
        },
        c if c.starts_with("device_") => SendBatchResponse::DeviceInvalid {
            reason: c.to_string(),
        },
        c if c.starts_with("session_") => SendBatchResponse::SessionInvalid {
            reason: c.to_string(),
        },
        other => SendBatchResponse::Transient(format!("unexpected 409 code: {other}")),
    }
}

fn extract_message(body: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(body).ok()?;
    v.get("message")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
}

fn extract_code_or_message(body: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(body).ok()?;
    v.get("code")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            v.get("message")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outbox::OutboxEntry;
    use httpmock::prelude::*;
    use std::time::SystemTime;

    fn mk_entry(ulid: &str, seq: i64) -> OutboxEntry {
        OutboxEntry {
            event_ulid: ulid.to_string(),
            session_id: "sess-11111111-1111-1111-1111-111111111111".to_string(),
            event_type: "USER_CLOCK_IN".to_string(),
            sequence_number: seq,
            event_body: format!(r#"{{"event_ulid":"{ulid}","event_type":"USER_CLOCK_IN"}}"#)
                .into_bytes(),
            integrity_signature: vec![0u8; 64],
            created_at: SystemTime::UNIX_EPOCH,
            retry_count: 0,
            next_retry_at: SystemTime::UNIX_EPOCH,
            last_error: None,
            poisoned: false,
            poison_reason: None,
            correlation_id: String::new(),
            device_id: String::new(),
            employee_id: String::new(),
        }
    }

    fn mk_envelope(events: Vec<OutboxEntry>) -> SessionEnvelope {
        SessionEnvelope {
            device_id: "dev-11111111-1111-1111-1111-111111111111".to_string(),
            session_id: "sess-11111111-1111-1111-1111-111111111111".to_string(),
            employee_id: "emp-11111111-1111-1111-1111-111111111111".to_string(),
            correlation_id: "corr-11111111-1111-1111-1111-111111111111".to_string(),
            take_over: false,
            events,
        }
    }

    #[test]
    fn returns_accepted_when_backend_returns_200_with_results() {
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/events")
                .header("authorization", "Bearer test-token");
            then.status(200)
                .header("content-type", "application/json")
                .body(
                    r#"{
                        "correlation_id":"corr-11111111-1111-1111-1111-111111111111",
                        "server_ts":"2026-09-23T00:00:00Z",
                        "session_closed_with":null,
                        "results":[
                            {"event_ulid":"01J8Q00000000000000000000A","status":"accepted","server_ts":"2026-09-23T00:00:00Z"},
                            {"event_ulid":"01J8Q00000000000000000000B","status":"duplicate_noop","server_ts":"2026-09-23T00:00:00Z"}
                        ]
                    }"#,
                );
        });

        let client = ReqwestBackendClient::new(server.base_url(), "test-token");
        let env = mk_envelope(vec![
            mk_entry("01J8Q00000000000000000000A", 1),
            mk_entry("01J8Q00000000000000000000B", 2),
        ]);
        let resp = client.send_batch(&env);

        mock.assert();
        match resp {
            SendBatchResponse::Accepted { results } => {
                assert_eq!(results.len(), 2);
                assert!(matches!(results[0].outcome, PerEventOutcome::Accepted));
                assert!(matches!(results[1].outcome, PerEventOutcome::DuplicateNoop));
            }
            other => panic!("expected Accepted, got {other:?}"),
        }
    }

    #[test]
    fn returns_accepted_with_per_event_rejected() {
        let server = MockServer::start();
        let _mock = server.mock(|when, then| {
            when.method(POST).path("/v1/events");
            then.status(200).header("content-type", "application/json").body(
                r#"{
                    "correlation_id":"corr-1","server_ts":"2026-09-23T00:00:00Z",
                    "session_closed_with":null,
                    "results":[
                        {"event_ulid":"01J8Q00000000000000000000A","status":"rejected","code":"signature_invalid","message":"bad sig"}
                    ]
                }"#,
            );
        });

        let client = ReqwestBackendClient::new(server.base_url(), "t");
        let env = mk_envelope(vec![mk_entry("01J8Q00000000000000000000A", 1)]);
        let resp = client.send_batch(&env);
        match resp {
            SendBatchResponse::Accepted { results } => {
                assert_eq!(results.len(), 1);
                assert!(matches!(
                    &results[0].outcome,
                    PerEventOutcome::Rejected { code, .. } if code == "signature_invalid"
                ));
            }
            other => panic!("expected Accepted with rejected, got {other:?}"),
        }
    }

    #[test]
    fn maps_400_to_validation_failed() {
        let server = MockServer::start();
        let _mock = server.mock(|when, then| {
            when.method(POST).path("/v1/events");
            then.status(400)
                .header("content-type", "application/problem+json")
                .body(r#"{"code":"validation","message":"device_id must be uuid","issues":[]}"#);
        });

        let client = ReqwestBackendClient::new(server.base_url(), "t");
        let env = mk_envelope(vec![mk_entry("01J8Q00000000000000000000A", 1)]);
        let resp = client.send_batch(&env);
        match resp {
            SendBatchResponse::ValidationFailed { message } => {
                assert!(message.contains("device_id"));
            }
            other => panic!("expected ValidationFailed, got {other:?}"),
        }
    }

    #[test]
    fn maps_403_to_auth_denied() {
        let server = MockServer::start();
        let _mock = server.mock(|when, then| {
            when.method(POST).path("/v1/events");
            then.status(403)
                .header("content-type", "application/problem+json")
                .body(r#"{"code":"no_user_for_oid","message":"..."}"#);
        });

        let client = ReqwestBackendClient::new(server.base_url(), "t");
        let env = mk_envelope(vec![mk_entry("01J8Q00000000000000000000A", 1)]);
        let resp = client.send_batch(&env);
        match resp {
            SendBatchResponse::AuthDenied { reason } => assert_eq!(reason, "no_user_for_oid"),
            other => panic!("expected AuthDenied, got {other:?}"),
        }
    }

    #[test]
    fn maps_409_device_revoked_to_device_invalid() {
        let server = MockServer::start();
        let _mock = server.mock(|when, then| {
            when.method(POST).path("/v1/events");
            then.status(409)
                .header("content-type", "application/problem+json")
                .body(r#"{"code":"device_revoked","message":"..."}"#);
        });

        let client = ReqwestBackendClient::new(server.base_url(), "t");
        let env = mk_envelope(vec![mk_entry("01J8Q00000000000000000000A", 1)]);
        let resp = client.send_batch(&env);
        match resp {
            SendBatchResponse::DeviceInvalid { reason } => assert_eq!(reason, "device_revoked"),
            other => panic!("expected DeviceInvalid, got {other:?}"),
        }
    }

    #[test]
    fn maps_409_session_closed_to_session_invalid() {
        let server = MockServer::start();
        let _mock = server.mock(|when, then| {
            when.method(POST).path("/v1/events");
            then.status(409)
                .body(r#"{"code":"session_closed","message":"..."}"#);
        });

        let client = ReqwestBackendClient::new(server.base_url(), "t");
        let env = mk_envelope(vec![mk_entry("01J8Q00000000000000000000A", 1)]);
        let resp = client.send_batch(&env);
        assert!(matches!(
            resp,
            SendBatchResponse::SessionInvalid { reason } if reason == "session_closed"
        ));
    }

    #[test]
    fn maps_409_multi_device_conflict_with_full_body() {
        let server = MockServer::start();
        let _mock = server.mock(|when, then| {
            when.method(POST).path("/v1/events");
            then.status(409).body(
                r#"{
                    "code":"multi_device_conflict",
                    "message":"...",
                    "existing_session_id":"other-sess",
                    "existing_device_id":"other-dev",
                    "opened_at":"2026-09-23T00:00:00Z",
                    "hint":"resubmit with take_over: true..."
                }"#,
            );
        });

        let client = ReqwestBackendClient::new(server.base_url(), "t");
        let env = mk_envelope(vec![mk_entry("01J8Q00000000000000000000A", 1)]);
        let resp = client.send_batch(&env);
        match resp {
            SendBatchResponse::MultiDeviceConflict {
                existing_session_id,
                existing_device_id,
            } => {
                assert_eq!(existing_session_id, "other-sess");
                assert_eq!(existing_device_id, "other-dev");
            }
            other => panic!("expected MultiDeviceConflict, got {other:?}"),
        }
    }

    #[test]
    fn maps_500_to_transient() {
        let server = MockServer::start();
        let _mock = server.mock(|when, then| {
            when.method(POST).path("/v1/events");
            then.status(500).body("internal");
        });

        let client = ReqwestBackendClient::new(server.base_url(), "t");
        let env = mk_envelope(vec![mk_entry("01J8Q00000000000000000000A", 1)]);
        let resp = client.send_batch(&env);
        assert!(matches!(resp, SendBatchResponse::Transient(msg) if msg.contains("500")));
    }

    #[test]
    fn network_error_maps_to_transient() {
        // Point at a port that is (almost certainly) not listening.
        // reqwest returns a connect error → Transient.
        let client = ReqwestBackendClient::new("http://127.0.0.1:1", "t");
        let env = mk_envelope(vec![mk_entry("01J8Q00000000000000000000A", 1)]);
        let resp = client.send_batch(&env);
        assert!(matches!(resp, SendBatchResponse::Transient(_)));
    }

    #[test]
    fn malformed_event_body_returns_transient_with_ulid() {
        let server = MockServer::start(); // never called
        let client = ReqwestBackendClient::new(server.base_url(), "t");

        let mut bad = mk_entry("01J8Q00000000000000000000A", 1);
        bad.event_body = b"not-json".to_vec();
        let env = mk_envelope(vec![bad]);

        let resp = client.send_batch(&env);
        match resp {
            SendBatchResponse::Transient(msg) => {
                assert!(msg.contains("01J8Q00000000000000000000A"));
                assert!(msg.contains("not valid JSON"));
            }
            other => panic!("expected Transient, got {other:?}"),
        }
    }

    #[test]
    fn body_is_json_with_expected_shape_and_events_array() {
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/events")
                .json_body_partial(
                    r#"{
                        "device_id":"dev-11111111-1111-1111-1111-111111111111",
                        "session_id":"sess-11111111-1111-1111-1111-111111111111",
                        "employee_id":"emp-11111111-1111-1111-1111-111111111111",
                        "correlation_id":"corr-11111111-1111-1111-1111-111111111111",
                        "take_over":false
                    }"#,
                );
            then.status(200).body(
                r#"{"correlation_id":"corr-1","server_ts":"2026-09-23T00:00:00Z","session_closed_with":null,"results":[]}"#,
            );
        });

        let client = ReqwestBackendClient::new(server.base_url(), "t");
        let env = mk_envelope(vec![mk_entry("01J8Q00000000000000000000A", 1)]);
        let _ = client.send_batch(&env);
        mock.assert();
    }
}
