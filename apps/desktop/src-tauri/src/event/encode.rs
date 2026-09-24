//! Turn a [`CoreEvent`] into the signed wire event the backend ingests
//! (ADR-0004 §5–§6, `apps/backend/src/events/schemas.ts`).
//!
//! The body is one `events[]` item: per-event fields plus the base64
//! Ed25519 signature. The signature covers the 16 canonical fields,
//! four of which (`correlation_id`, `device_id`, `employee_id`,
//! `session_id`) travel on the batch envelope, not in the body — the
//! backend rebuilds the same set from both before verifying.

use std::time::SystemTime;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::{DateTime, FixedOffset, Local, SecondsFormat, Utc};
use ed25519_dalek::SigningKey;
use serde_json::{json, Map, Value};
use thiserror::Error;

use super::canonicalize::{canonicalize_signed_fields, CanonicalizeError, SignedEventFields};
use super::signature::sign_bytes;
use crate::machine::CoreEvent;

/// Batch-level identity every event of a session is signed with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionContext {
    pub device_id: String,
    pub employee_id: String,
    pub session_id: String,
    /// One per session (ADR-0014): events stay verifiable across
    /// retries because every batch of the session carries this id.
    pub correlation_id: String,
    pub app_version: String,
}

/// Everything that varies per event.
#[derive(Debug, Clone, Copy)]
pub struct EventMeta<'a> {
    pub event_ulid: &'a str,
    pub sequence_number: i64,
    pub at: SystemTime,
    pub monotonic_ns: i64,
    pub offline_captured: bool,
}

/// A signed event, ready for the outbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedEvent {
    pub event_ulid: String,
    pub event_type: &'static str,
    pub sequence_number: i64,
    /// JSON `events[]` item, including `integrity_signature`.
    pub body: Vec<u8>,
    pub signature: [u8; 64],
}

#[derive(Debug, Error)]
pub enum EncodeError {
    #[error(transparent)]
    Canonicalize(#[from] CanonicalizeError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// `user` for employee actions, `system_watcher` for what the agent
/// observed (ADR-0004 `origin`).
fn origin(event: &CoreEvent) -> &'static str {
    match event {
        CoreEvent::InputIdle5m { .. }
        | CoreEvent::PromptTimeout30s
        | CoreEvent::MediaDeviceState { .. } => "system_watcher",
        _ => "user",
    }
}

/// The time zone an event is stamped in: IANA name + UTC offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Zone {
    pub iana: String,
    pub offset: FixedOffset,
}

impl Zone {
    /// This computer's zone at `at` (the offset can differ across DST).
    pub fn local(at: SystemTime) -> Self {
        Self {
            iana: tz_iana(),
            offset: *DateTime::<Local>::from(at).offset(),
        }
    }

    /// A fixed zone (tests, golden fixtures).
    pub fn fixed(iana: &str, offset_minutes: i32) -> Self {
        Self {
            iana: iana.to_string(),
            offset: FixedOffset::east_opt(offset_minutes * 60).expect("valid offset"),
        }
    }

    /// RFC 3339 with milliseconds and this zone's offset, e.g.
    /// `2026-09-24T09:15:03.412+05:30`.
    pub fn rfc3339(&self, at: SystemTime) -> String {
        DateTime::<Utc>::from(at)
            .with_timezone(&self.offset)
            .to_rfc3339_opts(SecondsFormat::Millis, false)
    }

    pub fn offset_minutes(&self) -> i16 {
        i16::try_from(self.offset.local_minus_utc() / 60).unwrap_or(0)
    }
}

/// IANA zone name (`Asia/Kolkata`); `Etc/UTC` if the OS can't say.
pub fn tz_iana() -> String {
    iana_time_zone::get_timezone()
        .ok()
        .filter(|z| {
            z.len() >= 2
                && z.len() <= 64
                && z.starts_with(|c: char| c.is_ascii_alphabetic())
                && z.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+-/_".contains(c))
        })
        .unwrap_or_else(|| "Etc/UTC".to_string())
}

/// Full wire payload: the fields the state machine reads, plus notes
/// and the prompt timestamp (schemas under `packages/event-schema`).
pub fn wire_payload(event: &CoreEvent, zone: &Zone) -> Value {
    let mut payload = match event.transition_payload() {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    match event {
        CoreEvent::UserPromptResponse {
            note,
            prompt_shown_at,
            ..
        } => {
            payload.insert("note".into(), json!(note));
            payload.insert(
                "prompt_shown_at".into(),
                json!(zone.rfc3339(*prompt_shown_at)),
            );
        }
        CoreEvent::UserMarkAway {
            note: Some(note), ..
        } => {
            payload.insert("note".into(), json!(note));
        }
        _ => {}
    }
    Value::Object(payload)
}

/// Encode and sign one event.
pub fn encode(
    ctx: &SessionContext,
    meta: EventMeta<'_>,
    event: &CoreEvent,
    zone: &Zone,
    key: &SigningKey,
) -> Result<EncodedEvent, EncodeError> {
    let payload = wire_payload(event, zone);
    let client_ts = zone.rfc3339(meta.at);
    let offset = zone.offset_minutes();
    let tz = zone.iana.as_str();
    let origin = origin(event);
    let signed = SignedEventFields {
        app_version: &ctx.app_version,
        client_ts: &client_ts,
        correlation_id: &ctx.correlation_id,
        device_id: &ctx.device_id,
        employee_id: &ctx.employee_id,
        event_type: event.event_type(),
        event_ulid: meta.event_ulid,
        monotonic_ns: meta.monotonic_ns,
        offline_captured: meta.offline_captured,
        origin,
        parent_event_ulid: None,
        payload: &payload,
        sequence_number: meta.sequence_number,
        session_id: &ctx.session_id,
        tz_iana: tz,
        utc_offset_minutes: offset,
    };
    let signature = sign_bytes(key, &canonicalize_signed_fields(&signed)?);
    let body = serde_json::to_vec(&json!({
        "event_ulid": meta.event_ulid,
        "event_type": event.event_type(),
        "sequence_number": meta.sequence_number,
        "client_ts": client_ts,
        "monotonic_ns": meta.monotonic_ns,
        "tz_iana": tz,
        "utc_offset_minutes": offset,
        "app_version": ctx.app_version,
        "origin": origin,
        "offline_captured": meta.offline_captured,
        "payload": payload,
        "integrity_signature": STANDARD.encode(signature),
        "parent_event_ulid": Value::Null,
    }))?;
    Ok(EncodedEvent {
        event_ulid: meta.event_ulid.to_string(),
        event_type: event.event_type(),
        sequence_number: meta.sequence_number,
        body,
        signature,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::signature::verify_bytes;
    use crate::machine::{AwayReason, BreakKind, CallType, IdleTrigger, PromptResponse};
    use std::time::{Duration, UNIX_EPOCH};

    fn ctx() -> SessionContext {
        SessionContext {
            device_id: "7a1c5f2e-0d3b-4c6a-9e8f-1b2c3d4e5f60".into(),
            employee_id: "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b".into(),
            session_id: "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e".into(),
            correlation_id: "c0ffee00-1111-4222-8333-444455556666".into(),
            app_version: "0.0.0".into(),
        }
    }

    fn meta(ulid: &str, seq: i64) -> EventMeta<'_> {
        EventMeta {
            event_ulid: ulid,
            sequence_number: seq,
            at: UNIX_EPOCH + Duration::from_millis(1_790_000_000_123),
            monotonic_ns: 42_000,
            offline_captured: false,
        }
    }

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    const ULID: &str = "01J8Q0000000000000000000AB";

    /// Rebuild the signed fields the way the backend does
    /// (`ingest.ts`): body fields + batch context.
    fn verify(ctx: &SessionContext, body: &Value, key: &SigningKey) -> bool {
        let signed = SignedEventFields {
            app_version: body["app_version"].as_str().unwrap(),
            client_ts: body["client_ts"].as_str().unwrap(),
            correlation_id: &ctx.correlation_id,
            device_id: &ctx.device_id,
            employee_id: &ctx.employee_id,
            event_type: body["event_type"].as_str().unwrap(),
            event_ulid: body["event_ulid"].as_str().unwrap(),
            monotonic_ns: body["monotonic_ns"].as_i64().unwrap(),
            offline_captured: body["offline_captured"].as_bool().unwrap(),
            origin: body["origin"].as_str().unwrap(),
            parent_event_ulid: body["parent_event_ulid"].as_str(),
            payload: &body["payload"],
            sequence_number: body["sequence_number"].as_i64().unwrap(),
            session_id: &ctx.session_id,
            tz_iana: body["tz_iana"].as_str().unwrap(),
            utc_offset_minutes: body["utc_offset_minutes"].as_i64().unwrap() as i16,
        };
        let bytes = canonicalize_signed_fields(&signed).unwrap();
        let sig = STANDARD
            .decode(body["integrity_signature"].as_str().unwrap())
            .unwrap();
        verify_bytes(key.verifying_key().as_bytes(), &bytes, &sig).is_ok()
    }

    #[test]
    fn body_has_exactly_the_backend_fields_and_verifies() {
        let e = encode(
            &ctx(),
            meta(ULID, 1),
            &CoreEvent::UserClockIn,
            &Zone::fixed("Asia/Kolkata", 330),
            &key(),
        )
        .unwrap();
        let body: Value = serde_json::from_slice(&e.body).unwrap();
        let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "app_version",
                "client_ts",
                "event_type",
                "event_ulid",
                "integrity_signature",
                "monotonic_ns",
                "offline_captured",
                "origin",
                "parent_event_ulid",
                "payload",
                "sequence_number",
                "tz_iana",
                "utc_offset_minutes",
            ]
        );
        assert_eq!(body["origin"], "user");
        assert_eq!(body["integrity_signature"].as_str().unwrap().len(), 88);
        assert!(verify(&ctx(), &body, &key()));
    }

    #[test]
    fn tampering_or_a_different_batch_context_fails_verification() {
        let e = encode(
            &ctx(),
            meta(ULID, 1),
            &CoreEvent::UserClockOut,
            &Zone::fixed("Asia/Kolkata", 330),
            &key(),
        )
        .unwrap();
        let mut body: Value = serde_json::from_slice(&e.body).unwrap();
        let mut other = ctx();
        other.correlation_id = "d0ffee00-1111-4222-8333-444455556666".into();
        assert!(!verify(&other, &body, &key()), "correlation id is signed");
        body["sequence_number"] = json!(2);
        assert!(!verify(&ctx(), &body, &key()), "fields are signed");
    }

    #[test]
    fn client_ts_carries_millis_and_the_offset_that_matches_utc_offset_minutes() {
        let e = encode(
            &ctx(),
            meta(ULID, 1),
            &CoreEvent::UserClockIn,
            &Zone::fixed("Asia/Kolkata", 330),
            &key(),
        )
        .unwrap();
        let body: Value = serde_json::from_slice(&e.body).unwrap();
        let ts = body["client_ts"].as_str().unwrap();
        let parsed = DateTime::parse_from_rfc3339(ts).unwrap();
        assert_eq!(parsed.timestamp_millis(), 1_790_000_000_123);
        assert!(ts.ends_with(".123+05:30"), "{ts}");
        assert_eq!(body["utc_offset_minutes"], 330);
        assert_eq!(body["tz_iana"], "Asia/Kolkata");
    }

    #[test]
    fn local_zone_offset_matches_its_timestamps() {
        let now = SystemTime::now();
        let z = Zone::local(now);
        let parsed = DateTime::parse_from_rfc3339(&z.rfc3339(now)).unwrap();
        assert_eq!(
            i64::from(parsed.offset().local_minus_utc() / 60),
            i64::from(z.offset_minutes())
        );
    }

    #[test]
    fn payloads_match_the_event_schemas() {
        let z = Zone::fixed("Asia/Kolkata", 330);
        let shown = UNIX_EPOCH + Duration::from_secs(1_790_000_000);
        let resp = CoreEvent::UserPromptResponse {
            response: PromptResponse::WorkingAway,
            note: Some("site visit".into()),
            prompt_shown_at: shown,
        };
        let p = wire_payload(&resp, &z);
        assert_eq!(p["response"], "working_away");
        assert_eq!(p["note"], "site visit");
        assert!(DateTime::parse_from_rfc3339(p["prompt_shown_at"].as_str().unwrap()).is_ok());

        let no_note = CoreEvent::UserPromptResponse {
            response: PromptResponse::StillWorking,
            note: None,
            prompt_shown_at: shown,
        };
        assert!(wire_payload(&no_note, &z)["note"].is_null());

        let away = CoreEvent::UserMarkAway {
            reason: AwayReason::Meeting,
            note: None,
        };
        assert_eq!(wire_payload(&away, &z), json!({ "away_reason": "meeting" }));

        let call = CoreEvent::MediaDeviceState {
            in_use: true,
            call_type: Some(CallType::Teams),
        };
        assert_eq!(
            wire_payload(&call, &z),
            json!({ "in_use": true, "call_type": "teams" })
        );
        assert_eq!(
            wire_payload(
                &CoreEvent::UserStartBreak {
                    kind: BreakKind::Meal
                },
                &z
            ),
            json!({ "break_kind": "meal" })
        );
        assert_eq!(wire_payload(&CoreEvent::UserClockIn, &z), json!({}));
    }

    #[test]
    fn watcher_events_are_system_origin() {
        let e = encode(
            &ctx(),
            meta(ULID, 3),
            &CoreEvent::PromptTimeout30s,
            &Zone::fixed("Asia/Kolkata", 330),
            &key(),
        )
        .unwrap();
        let body: Value = serde_json::from_slice(&e.body).unwrap();
        assert_eq!(body["origin"], "system_watcher");
    }

    const GOLDEN: &str =
        include_str!("../../../../../packages/event-schema/fixtures/signed-events.json");

    /// A whole shift the backend must accept in order: every state the
    /// desktop can reach, each payload shape, and both origins.
    fn golden_shift() -> Vec<CoreEvent> {
        vec![
            CoreEvent::UserClockIn,
            CoreEvent::MediaDeviceState {
                in_use: true,
                call_type: Some(CallType::Teams),
            },
            CoreEvent::MediaDeviceState {
                in_use: false,
                call_type: None,
            },
            CoreEvent::InputIdle5m {
                trigger: IdleTrigger::InputIdle,
            },
            CoreEvent::UserPromptResponse {
                response: PromptResponse::WorkingAway,
                note: Some("Site visit — back by 3".into()),
                prompt_shown_at: golden_at(3),
            },
            CoreEvent::UserMarkBack,
            CoreEvent::UserStartBreak {
                kind: BreakKind::Meal,
            },
            CoreEvent::UserEndBreak,
            CoreEvent::UserMarkAway {
                reason: AwayReason::Meeting,
                note: None,
            },
            CoreEvent::UserMarkBack,
            CoreEvent::UserClockOut,
        ]
    }

    /// Event `i` happens `i` minutes after 2026-09-21T14:13:20.123Z.
    fn golden_at(i: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(1_790_000_000_123 + i * 60_000)
    }

    fn golden_bodies() -> Vec<Value> {
        let zone = Zone::fixed("Asia/Kolkata", 330);
        golden_shift()
            .iter()
            .enumerate()
            .map(|(i, event)| {
                let at = golden_at(i as u64);
                let ms = u128::from(1_790_000_000_123 + i as u64 * 60_000);
                let ulid = crate::event::ulid::encode((ms << 80) | (i as u128 + 1));
                let meta = EventMeta {
                    event_ulid: &ulid,
                    sequence_number: i as i64 + 1,
                    at,
                    monotonic_ns: i as i64 * 60_000_000_000,
                    offline_captured: false,
                };
                let e = encode(&ctx(), meta, event, &zone, &key()).unwrap();
                serde_json::from_slice(&e.body).unwrap()
            })
            .collect()
    }

    fn golden_document() -> Value {
        let c = ctx();
        json!({
            "$comment": "Signed events from the desktop encoder (event/encode.rs), checked by the backend's ingest (signed-events.fixture.test.ts). Test key only: Ed25519 seed = 32 bytes of 0x07. Regenerate with CLOUDPUNCH_UPDATE_GOLDEN=1 cargo test golden, then prettier. See ADR-0004 §5–§6, ADR-0014.",
            "public_key_base64": STANDARD.encode(key().verifying_key().as_bytes()),
            "envelope": {
                "device_id": c.device_id,
                "session_id": c.session_id,
                "employee_id": c.employee_id,
                "correlation_id": c.correlation_id,
            },
            "events": golden_bodies(),
        })
    }

    #[test]
    fn golden_signed_events_match_the_shared_fixture() {
        let doc = golden_document();
        if std::env::var_os("CLOUDPUNCH_UPDATE_GOLDEN").is_some() {
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../packages/event-schema/fixtures/signed-events.json"
            );
            let text = serde_json::to_string_pretty(&doc).unwrap() + "\n";
            std::fs::write(path, text).unwrap();
            return;
        }
        let fixture: Value = serde_json::from_str(GOLDEN).unwrap();
        // Ed25519 is deterministic, so equal signatures mean the
        // canonical bytes match too.
        assert_eq!(
            fixture, doc,
            "encoder output drifted from signed-events.json"
        );
    }

    #[test]
    fn golden_shift_is_a_legal_state_sequence() {
        use crate::machine::transitions::{next_payroll_state, PayrollState};
        let mut state = PayrollState::Active;
        for (i, body) in golden_bodies().iter().enumerate() {
            let t = body["event_type"].as_str().unwrap();
            if i == 0 {
                assert_eq!(t, "USER_CLOCK_IN");
                continue;
            }
            state = next_payroll_state(state, t, Some(&body["payload"]))
                .unwrap_or_else(|| panic!("{t} rejected from {state:?}"));
            assert!(verify(&ctx(), body, &key()));
        }
        assert_eq!(state, PayrollState::Closed);
    }

    #[test]
    fn tz_iana_is_a_valid_zone_name() {
        let tz = tz_iana();
        assert!(tz.contains('/') || tz == "UTC", "{tz}");
    }
}
