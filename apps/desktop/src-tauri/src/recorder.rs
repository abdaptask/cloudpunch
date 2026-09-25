//! Signed-event recording (2b.4 F3c): the agent's [`EventSink`] that
//! turns each [`CoreEvent`] into a signed wire event and stages it in
//! the user's encrypted outbox.
//!
//! [`Recorder`] is the shared handle the app arms and disarms:
//!   - **armed** once this user's identity is known, from a fresh
//!     enrollment or the identity cached in the outbox by an earlier
//!     one (so offline launches can still record);
//!   - **log-only** when no backend is configured (local development):
//!     events are logged, not stored;
//!   - **unarmed** otherwise. Clock-in is refused then, and anything
//!     emitted anyway stays in the driver's in-memory backlog until the
//!     recorder is armed.
//!
//! Sessions: `USER_CLOCK_IN` starts one with a fresh `session_id` and
//! `correlation_id` (ADR-0014) and sequence number 1. The session ends
//! when an event moves the payroll state to `Closed` — a clock-out or
//! an automatic one — tracked with the same transition table the core
//! and the backend use.
//!
//! One outbox file per user, `outbox-<oid>.db` in the app data folder,
//! encrypted with that user's outbox key (ADR-0007 §5).
//!
//! Crash recovery (ADR-0003 §10): the session in progress is also kept
//! in the outbox (`open_session`), tagged with this app run's id and a
//! heartbeat refreshed every minute. When the recorder is armed and
//! finds a session left by an *earlier* run, the app crashed or the
//! computer shut down while clocked in: it signs a `SESSION_RECOVERED`
//! event into that session, and the server closes it at the last
//! heartbeat, flagged `reconstructed` for manager review.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Instant, SystemTime};

use ed25519_dalek::SigningKey;
use thiserror::Error;

use crate::enroll::{Identity, APP_VERSION};
use crate::event::encode::{encode, encode_parts, EventMeta, SessionContext, Zone};
use crate::event::ulid::UlidGenerator;
use crate::keystore::{KeystoreError, SecretStore, Secrets};
use crate::machine::sink::{describe, EventSink, SinkError};
use crate::machine::transitions::{next_payroll_state, PayrollState};
use crate::machine::CoreEvent;
use crate::outbox::{CachedIdentity, EnqueueInput, OpenSession, Outbox, OutboxError};

#[derive(Debug, Error)]
pub enum RecorderError {
    #[error(transparent)]
    Keystore(#[from] KeystoreError),
    #[error(transparent)]
    Outbox(#[from] OutboxError),
    #[error("app data folder: {0}")]
    Io(#[from] std::io::Error),
    #[error("signing: {0}")]
    Signing(String),
}

/// Where an armed recorder writes: one user's outbox, identity, and
/// signing key.
pub struct Target {
    outbox: Outbox,
    identity: Identity,
    key: SigningKey,
}

impl Target {
    /// This user's outbox file in `data_dir`.
    pub fn outbox_path(data_dir: &Path, oid: &str) -> PathBuf {
        data_dir.join(format!("outbox-{oid}.db"))
    }

    /// Open the user's outbox and remember `identity` in it.
    pub fn open<S: SecretStore>(
        data_dir: &Path,
        identity: Identity,
        secrets: &Secrets<S>,
    ) -> Result<Self, RecorderError> {
        let outbox = open_outbox(data_dir, &identity.oid, secrets)?;
        outbox.save_identity(&CachedIdentity {
            oid: identity.oid.clone(),
            device_id: identity.device_id.clone(),
            employee_id: identity.employee_id.clone(),
        })?;
        let key = secrets.device_key(&identity.oid)?;
        Ok(Self {
            outbox,
            identity,
            key,
        })
    }

    /// Open the user's outbox with the identity an earlier enrollment
    /// cached there. `None` if there is none (never enrolled here).
    pub fn from_cache<S: SecretStore>(
        data_dir: &Path,
        oid: &str,
        secrets: &Secrets<S>,
    ) -> Result<Option<Self>, RecorderError> {
        if !Self::outbox_path(data_dir, oid).exists() {
            return Ok(None);
        }
        let outbox = open_outbox(data_dir, oid, secrets)?;
        let Some(cached) = outbox.load_identity(oid)? else {
            return Ok(None);
        };
        let key = secrets.device_key(oid)?;
        Ok(Some(Self {
            outbox,
            identity: Identity {
                oid: cached.oid,
                device_id: cached.device_id,
                employee_id: cached.employee_id,
            },
            key,
        }))
    }

    /// In-memory target for tests.
    #[cfg(test)]
    pub fn in_memory(identity: Identity, key: SigningKey) -> Self {
        Self {
            outbox: Outbox::open_in_memory(&[5u8; crate::outbox::CIPHER_KEY_LEN])
                .expect("in-memory outbox"),
            identity,
            key,
        }
    }
}

fn open_outbox<S: SecretStore>(
    data_dir: &Path,
    oid: &str,
    secrets: &Secrets<S>,
) -> Result<Outbox, RecorderError> {
    std::fs::create_dir_all(data_dir)?;
    let key = secrets.outbox_key(oid)?;
    Ok(Outbox::open(&Target::outbox_path(data_dir, oid), &key)?)
}

enum Mode {
    Unarmed,
    LogOnly,
    Armed(Box<Target>),
}

struct Shared {
    mode: Mode,
    /// The network watcher's reachability flag, once watchers run.
    online: Option<Arc<AtomicBool>>,
    /// This app run. An `open_session` row from another run is stale.
    run_id: String,
}

impl Shared {
    /// No watcher yet counts as online (as the sync loop assumes).
    fn online(&self) -> bool {
        match &self.online {
            Some(flag) => flag.load(Ordering::Acquire),
            None => true,
        }
    }
}

/// Shared arm/disarm handle; clones share state.
#[derive(Clone)]
pub struct Recorder {
    shared: Arc<Mutex<Shared>>,
}

impl Default for Recorder {
    fn default() -> Self {
        Self::new()
    }
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared {
                mode: Mode::Unarmed,
                online: None,
                run_id: uuid::Uuid::new_v4().to_string(),
            })),
        }
    }

    /// A recorder that only logs (tests, and development without a
    /// backend).
    pub fn log_only() -> Self {
        let r = Self::new();
        r.set_log_only();
        r
    }

    /// Start recording into `target`. A session an earlier run left
    /// open is recovered first (see the module docs).
    pub fn arm(&self, target: Target) {
        self.arm_at(target, SystemTime::now(), &Zone::local(SystemTime::now()));
    }

    fn arm_at(&self, target: Target, now: SystemTime, zone: &Zone) {
        let mut shared = self.lock();
        match recover_stale_session(&target, &shared.run_id, shared.online(), now, zone) {
            Ok(true) => eprintln!("[cloudpunch] recovered a session left open by an earlier run"),
            Ok(false) => {}
            Err(e) => eprintln!("[cloudpunch] session recovery failed: {e}"),
        }
        shared.mode = Mode::Armed(Box::new(target));
    }

    /// Heartbeat for the session in progress (called every minute).
    pub fn heartbeat(&self, now: SystemTime) {
        let shared = self.lock();
        if let Mode::Armed(t) = &shared.mode {
            if let Err(e) = t
                .outbox
                .touch_open_session(&t.identity.oid, &shared.run_id, now)
            {
                eprintln!("[cloudpunch] heartbeat failed: {e}");
            }
        }
    }

    /// Close the outbox (sign-out).
    pub fn disarm(&self) {
        self.lock().mode = Mode::Unarmed;
    }

    pub fn set_log_only(&self) {
        self.lock().mode = Mode::LogOnly;
    }

    pub fn set_online_flag(&self, online: Arc<AtomicBool>) {
        self.lock().online = Some(online);
    }

    /// The reachability flag for the sync loop (online until the
    /// network watcher says otherwise).
    pub fn online_flag(&self) -> Arc<AtomicBool> {
        self.lock()
            .online
            .clone()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(true)))
    }

    pub fn is_armed(&self) -> bool {
        matches!(self.lock().mode, Mode::Armed(_))
    }

    /// Whether a clock-in now would be recorded (or knowingly only
    /// logged, in development).
    pub fn can_record(&self) -> bool {
        !matches!(self.lock().mode, Mode::Unarmed)
    }

    /// Events staged but not yet sent; 0 when not armed.
    pub fn unsent(&self) -> Result<u64, OutboxError> {
        match &self.lock().mode {
            Mode::Armed(t) => t.outbox.unsent_count(),
            _ => Ok(0),
        }
    }

    /// The sink the agent's driver records through.
    pub fn sink(&self) -> OutboxSink {
        OutboxSink {
            recorder: self.clone(),
            session: None,
            ulids: UlidGenerator::new(),
            anchor: Instant::now(),
            zone: Box::new(Zone::local),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|p| p.into_inner())
    }
}

struct Session {
    ctx: SessionContext,
    next_seq: i64,
    state: PayrollState,
}

/// The agent's event sink. See the module docs.
pub struct OutboxSink {
    recorder: Recorder,
    session: Option<Session>,
    ulids: UlidGenerator,
    /// Origin of `monotonic_ns`.
    anchor: Instant,
    zone: Box<dyn Fn(SystemTime) -> Zone + Send>,
}

impl OutboxSink {
    /// For tests: stamp every event in a fixed zone.
    #[cfg(test)]
    fn with_zone(mut self, zone: Zone) -> Self {
        self.zone = Box::new(move |_| zone.clone());
        self
    }
}

impl EventSink for OutboxSink {
    fn record(&mut self, event: &CoreEvent, at: SystemTime) -> Result<(), SinkError> {
        #[cfg(debug_assertions)]
        eprintln!("[cloudpunch] event: {}", describe(event, at));

        let recorder = self.recorder.clone();
        let shared = recorder.lock();
        let online = shared.online();
        let target = match &shared.mode {
            Mode::LogOnly => return Ok(()),
            Mode::Unarmed => return Err(SinkError("recorder not ready".into())),
            Mode::Armed(t) => t,
        };

        if matches!(event, CoreEvent::UserClockIn) {
            self.session = Some(Session {
                ctx: SessionContext {
                    device_id: target.identity.device_id.clone(),
                    employee_id: target.identity.employee_id.clone(),
                    session_id: uuid::Uuid::new_v4().to_string(),
                    correlation_id: uuid::Uuid::new_v4().to_string(),
                    app_version: APP_VERSION.to_string(),
                },
                next_seq: 1,
                // The server opens the session in ACTIVE; the table
                // treats a later USER_CLOCK_IN as a duplicate.
                state: PayrollState::Active,
            });
        }
        let Some(session) = self.session.as_mut() else {
            // The core only emits inside a session; never guess one.
            eprintln!(
                "[cloudpunch] {} outside a session; not recorded",
                event.event_type()
            );
            return Ok(());
        };

        let ulid = self
            .ulids
            .next(at)
            .map_err(|e| SinkError(format!("ulid: {e}")))?;
        let meta = EventMeta {
            event_ulid: &ulid,
            sequence_number: session.next_seq,
            at,
            monotonic_ns: i64::try_from(self.anchor.elapsed().as_nanos()).unwrap_or(i64::MAX),
            offline_captured: !online,
        };
        let encoded = encode(&session.ctx, meta, event, &(self.zone)(at), &target.key)
            .map_err(|e| SinkError(format!("encode: {e}")))?;
        target
            .outbox
            .enqueue(&EnqueueInput {
                event_ulid: encoded.event_ulid,
                session_id: session.ctx.session_id.clone(),
                event_type: encoded.event_type.to_string(),
                sequence_number: encoded.sequence_number,
                event_body: encoded.body,
                integrity_signature: encoded.signature.to_vec(),
                correlation_id: session.ctx.correlation_id.clone(),
                device_id: session.ctx.device_id.clone(),
                employee_id: session.ctx.employee_id.clone(),
            })
            .map_err(|e| SinkError(format!("outbox: {e}")))?;

        session.next_seq += 1;
        let payload = event.transition_payload();
        if let Some(next) = next_payroll_state(session.state, event.event_type(), Some(&payload)) {
            session.state = next;
        }
        // Keep the crash-recovery record in step. The event itself is
        // already safe in the outbox, so a failure here is only logged.
        let kept = if session.state == PayrollState::Closed {
            target.outbox.clear_open_session(&target.identity.oid)
        } else {
            target.outbox.save_open_session(&OpenSession {
                oid: target.identity.oid.clone(),
                run_id: shared.run_id.clone(),
                session_id: session.ctx.session_id.clone(),
                correlation_id: session.ctx.correlation_id.clone(),
                device_id: session.ctx.device_id.clone(),
                employee_id: session.ctx.employee_id.clone(),
                next_seq: session.next_seq,
                payroll_state: session.state.as_str().to_string(),
                last_alive_at: at,
            })
        };
        if let Err(e) = kept {
            eprintln!("[cloudpunch] open-session record not updated: {e}");
        }
        if session.state == PayrollState::Closed {
            self.session = None;
        }
        Ok(())
    }
}

/// If `target`'s outbox holds a session left open by another run, sign
/// `SESSION_RECOVERED` into it and forget it. Returns whether it did.
fn recover_stale_session(
    target: &Target,
    run_id: &str,
    online: bool,
    now: SystemTime,
    zone: &Zone,
) -> Result<bool, RecorderError> {
    let oid = &target.identity.oid;
    let Some(stale) = target.outbox.load_open_session(oid)? else {
        return Ok(false);
    };
    if stale.run_id == run_id {
        return Ok(false);
    }
    let ctx = SessionContext {
        device_id: stale.device_id.clone(),
        employee_id: stale.employee_id.clone(),
        session_id: stale.session_id.clone(),
        correlation_id: stale.correlation_id.clone(),
        app_version: APP_VERSION.to_string(),
    };
    let ulid = UlidGenerator::new()
        .next(now)
        .map_err(|e| RecorderError::Signing(format!("ulid: {e}")))?;
    let payload = serde_json::json!({
        "reconstruction_reason": "session_recovered",
        "last_heartbeat_at": zone.rfc3339(stale.last_alive_at),
        "recovered_at": zone.rfc3339(now),
    });
    let meta = EventMeta {
        event_ulid: &ulid,
        sequence_number: stale.next_seq,
        at: now,
        monotonic_ns: 0,
        offline_captured: !online,
    };
    let encoded = encode_parts(
        &ctx,
        meta,
        "SESSION_RECOVERED",
        "reconstructed",
        &payload,
        zone,
        &target.key,
    )
    .map_err(|e| RecorderError::Signing(e.to_string()))?;
    target.outbox.enqueue(&EnqueueInput {
        event_ulid: encoded.event_ulid,
        session_id: ctx.session_id,
        event_type: encoded.event_type.to_string(),
        sequence_number: encoded.sequence_number,
        event_body: encoded.body,
        integrity_signature: encoded.signature.to_vec(),
        correlation_id: ctx.correlation_id,
        device_id: ctx.device_id,
        employee_id: ctx.employee_id,
    })?;
    target.outbox.clear_open_session(oid)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::encode::tests::verify as verify_body;
    use crate::keystore::MemoryStore;
    use crate::machine::{BreakKind, PromptResponse};
    use serde_json::Value;
    use std::time::{Duration, UNIX_EPOCH};

    const OID: &str = "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

    fn identity() -> Identity {
        Identity {
            oid: OID.into(),
            device_id: "33333333-3333-4333-8333-333333333333".into(),
            employee_id: "44444444-4444-4444-8444-444444444444".into(),
        }
    }

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn t(s: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_790_000_000 + s)
    }

    fn armed() -> (Recorder, OutboxSink) {
        let r = Recorder::new();
        r.arm(Target::in_memory(identity(), key()));
        let sink = r.sink().with_zone(Zone::fixed("Asia/Kolkata", 330));
        (r, sink)
    }

    fn rows(r: &Recorder) -> Vec<crate::outbox::OutboxEntry> {
        match &r.lock().mode {
            Mode::Armed(t) => t.outbox.drain(100).unwrap(),
            _ => Vec::new(),
        }
    }

    fn shift(sink: &mut OutboxSink, from: u64) {
        let events = [
            CoreEvent::UserClockIn,
            CoreEvent::UserStartBreak {
                kind: BreakKind::Meal,
            },
            CoreEvent::UserEndBreak,
            CoreEvent::UserClockOut,
        ];
        for (i, e) in events.iter().enumerate() {
            sink.record(e, t(from + i as u64 * 60)).unwrap();
        }
    }

    #[test]
    fn a_shift_is_one_signed_session_in_order() {
        let (r, mut sink) = armed();
        shift(&mut sink, 0);
        let rows = rows(&r);
        let types: Vec<_> = rows.iter().map(|e| e.event_type.as_str()).collect();
        assert_eq!(
            types,
            [
                "USER_CLOCK_IN",
                "USER_START_BREAK",
                "USER_END_BREAK",
                "USER_CLOCK_OUT"
            ]
        );
        let seqs: Vec<_> = rows.iter().map(|e| e.sequence_number).collect();
        assert_eq!(seqs, [1, 2, 3, 4]);

        let first = &rows[0];
        assert!(uuid::Uuid::parse_str(&first.session_id).is_ok());
        assert!(uuid::Uuid::parse_str(&first.correlation_id).is_ok());
        assert_ne!(first.session_id, first.correlation_id);
        for e in &rows {
            // ADR-0014: one correlation id for the whole session.
            assert_eq!(e.session_id, first.session_id);
            assert_eq!(e.correlation_id, first.correlation_id);
            assert_eq!(e.device_id, identity().device_id);
            assert_eq!(e.employee_id, identity().employee_id);

            let ctx = SessionContext {
                device_id: e.device_id.clone(),
                employee_id: e.employee_id.clone(),
                session_id: e.session_id.clone(),
                correlation_id: e.correlation_id.clone(),
                app_version: APP_VERSION.into(),
            };
            let body: Value = serde_json::from_slice(&e.event_body).unwrap();
            assert!(
                verify_body(&ctx, &body, &key()),
                "{} verifies",
                e.event_type
            );
            assert_eq!(body["tz_iana"], "Asia/Kolkata");
            assert_eq!(body["offline_captured"], false);
        }
        // ULIDs increase with the events.
        let ulids: Vec<_> = rows.iter().map(|e| e.event_ulid.clone()).collect();
        let mut sorted = ulids.clone();
        sorted.sort();
        assert_eq!(ulids, sorted);
    }

    #[test]
    fn the_next_clock_in_starts_a_new_session_at_one() {
        let (r, mut sink) = armed();
        shift(&mut sink, 0);
        shift(&mut sink, 3600);
        let rows = rows(&r);
        assert_eq!(rows.len(), 8);
        // drain() interleaves sessions by sequence; group them back.
        let mut sessions: Vec<(String, String)> = rows
            .iter()
            .map(|e| (e.session_id.clone(), e.correlation_id.clone()))
            .collect();
        sessions.sort();
        sessions.dedup();
        assert_eq!(sessions.len(), 2);
        assert_ne!(sessions[0].1, sessions[1].1, "one correlation id each");
        for (sid, _) in &sessions {
            let mut mine: Vec<_> = rows.iter().filter(|e| &e.session_id == sid).collect();
            mine.sort_by_key(|e| e.sequence_number);
            let seqs: Vec<_> = mine.iter().map(|e| e.sequence_number).collect();
            assert_eq!(seqs, [1, 2, 3, 4]);
            assert_eq!(mine[0].event_type, "USER_CLOCK_IN");
        }
    }

    #[test]
    fn an_automatic_clock_out_ends_the_session() {
        let (r, mut sink) = armed();
        sink.record(&CoreEvent::UserClockIn, t(0)).unwrap();
        sink.record(
            &CoreEvent::InputIdle5m {
                trigger: crate::machine::IdleTrigger::InputIdle,
            },
            t(300),
        )
        .unwrap();
        sink.record(&CoreEvent::PromptTimeout30s, t(330)).unwrap();
        // Anything after the session closed is outside a session.
        sink.record(&CoreEvent::UserEndBreak, t(400)).unwrap();
        let rows = rows(&r);
        let types: Vec<_> = rows.iter().map(|e| e.event_type.as_str()).collect();
        assert_eq!(
            types,
            ["USER_CLOCK_IN", "INPUT_IDLE_5M", "PROMPT_TIMEOUT_30S"]
        );
        assert!(sink.session.is_none());
    }

    #[test]
    fn offline_events_are_flagged() {
        let (r, mut sink) = armed();
        let online = Arc::new(AtomicBool::new(false));
        r.set_online_flag(online.clone());
        sink.record(&CoreEvent::UserClockIn, t(0)).unwrap();
        online.store(true, Ordering::Release);
        sink.record(
            &CoreEvent::UserPromptResponse {
                response: PromptResponse::StillWorking,
                note: None,
                prompt_shown_at: t(1),
            },
            t(2),
        )
        .unwrap();
        let flags: Vec<Value> = rows(&r)
            .iter()
            .map(|e| {
                serde_json::from_slice::<Value>(&e.event_body).unwrap()["offline_captured"].clone()
            })
            .collect();
        assert_eq!(flags, [Value::Bool(true), Value::Bool(false)]);
    }

    #[test]
    fn unarmed_refuses_and_log_only_drops() {
        let r = Recorder::new();
        assert!(!r.can_record());
        let mut sink = r.sink();
        assert!(sink.record(&CoreEvent::UserClockIn, t(0)).is_err());

        let r = Recorder::log_only();
        assert!(r.can_record());
        assert!(!r.is_armed());
        let mut sink = r.sink();
        assert!(sink.record(&CoreEvent::UserClockIn, t(0)).is_ok());
        assert_eq!(r.unsent().unwrap(), 0);
    }

    #[test]
    fn a_refused_event_is_recorded_once_armed_with_sequence_intact() {
        let r = Recorder::new();
        let mut sink = r.sink().with_zone(Zone::fixed("Asia/Kolkata", 330));
        assert!(sink.record(&CoreEvent::UserClockIn, t(0)).is_err());
        r.arm(Target::in_memory(identity(), key()));
        // The driver replays its backlog: same event again.
        sink.record(&CoreEvent::UserClockIn, t(0)).unwrap();
        sink.record(&CoreEvent::UserClockOut, t(60)).unwrap();
        let seqs: Vec<_> = rows(&r).iter().map(|e| e.sequence_number).collect();
        assert_eq!(seqs, [1, 2]);
        assert_eq!(r.unsent().unwrap(), 2);
    }

    #[test]
    fn target_caches_identity_for_offline_launches() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Secrets::new(MemoryStore::default());
        assert!(Target::from_cache(dir.path(), OID, &secrets)
            .unwrap()
            .is_none());
        let opened = Target::open(dir.path(), identity(), &secrets).unwrap();
        assert!(Target::outbox_path(dir.path(), OID).exists());
        drop(opened);
        let cached = Target::from_cache(dir.path(), OID, &secrets)
            .unwrap()
            .expect("cached identity");
        assert_eq!(cached.identity, identity());
        assert_eq!(
            cached.key.to_bytes(),
            secrets.device_key(OID).unwrap().to_bytes()
        );
    }

    fn open_row(r: &Recorder) -> Option<OpenSession> {
        match &r.lock().mode {
            Mode::Armed(t) => t.outbox.load_open_session(OID).unwrap(),
            _ => None,
        }
    }

    #[test]
    fn the_session_in_progress_is_kept_for_recovery_and_cleared_at_clock_out() {
        let (r, mut sink) = armed();
        sink.record(&CoreEvent::UserClockIn, t(0)).unwrap();
        let open = open_row(&r).expect("recorded at clock-in");
        assert_eq!(open.next_seq, 2);
        assert_eq!(open.payroll_state, "ACTIVE");
        assert_eq!(open.last_alive_at, t(0));

        sink.record(
            &CoreEvent::UserStartBreak {
                kind: BreakKind::Bio,
            },
            t(60),
        )
        .unwrap();
        let open = open_row(&r).unwrap();
        assert_eq!(
            (open.next_seq, open.payroll_state.as_str()),
            (3, "ON_BREAK")
        );

        r.heartbeat(t(120));
        assert_eq!(open_row(&r).unwrap().last_alive_at, t(120));

        sink.record(&CoreEvent::UserEndBreak, t(180)).unwrap();
        sink.record(&CoreEvent::UserClockOut, t(240)).unwrap();
        assert_eq!(open_row(&r), None);
    }

    #[test]
    fn a_session_left_by_an_earlier_run_is_recovered_on_arming() {
        // Run 1: clock in, heartbeat, then "crash" (never clock out).
        let run1 = Recorder::new();
        let target = Target::in_memory(identity(), key());
        run1.arm(target);
        let mut sink = run1.sink().with_zone(Zone::fixed("Asia/Kolkata", 330));
        sink.record(&CoreEvent::UserClockIn, t(0)).unwrap();
        run1.heartbeat(t(1800));
        let Mode::Armed(target) = std::mem::replace(&mut run1.lock().mode, Mode::Unarmed) else {
            unreachable!()
        };

        // Run 2 arms with the same outbox.
        let run2 = Recorder::new();
        run2.arm_at(*target, t(90_000), &Zone::fixed("Asia/Kolkata", 330));
        let rows = rows(&run2);
        assert_eq!(rows.len(), 2);
        let recovered = rows
            .iter()
            .find(|e| e.event_type == "SESSION_RECOVERED")
            .expect("recovery event");
        let clock_in = rows
            .iter()
            .find(|e| e.event_type == "USER_CLOCK_IN")
            .unwrap();
        assert_eq!(recovered.session_id, clock_in.session_id);
        assert_eq!(recovered.correlation_id, clock_in.correlation_id);
        assert_eq!(recovered.sequence_number, 2);

        let body: Value = serde_json::from_slice(&recovered.event_body).unwrap();
        assert_eq!(body["origin"], "reconstructed");
        assert_eq!(
            body["payload"]["reconstruction_reason"],
            "session_recovered"
        );
        let heartbeat = Zone::fixed("Asia/Kolkata", 330).rfc3339(t(1800));
        assert_eq!(body["payload"]["last_heartbeat_at"], heartbeat.as_str());
        let ctx = SessionContext {
            device_id: recovered.device_id.clone(),
            employee_id: recovered.employee_id.clone(),
            session_id: recovered.session_id.clone(),
            correlation_id: recovered.correlation_id.clone(),
            app_version: APP_VERSION.into(),
        };
        assert!(verify_body(&ctx, &body, &key()));
        assert_eq!(open_row(&run2), None, "forgotten once recovered");
    }

    #[test]
    fn re_arming_in_the_same_run_does_not_recover_the_live_session() {
        let (r, mut sink) = armed();
        sink.record(&CoreEvent::UserClockIn, t(0)).unwrap();
        let Mode::Armed(target) = std::mem::replace(&mut r.lock().mode, Mode::Unarmed) else {
            unreachable!()
        };
        r.arm(*target);
        let types: Vec<_> = rows(&r).into_iter().map(|e| e.event_type).collect();
        assert_eq!(types, ["USER_CLOCK_IN"]);
        assert!(open_row(&r).is_some());
    }
}
