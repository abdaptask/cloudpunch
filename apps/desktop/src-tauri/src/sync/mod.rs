//! Sync loop: drains the outbox and POSTs to `/v1/events`.
//!
//! Owns an [`Outbox`] and a [`BackendClient`] and runs a fixed-cadence
//! poll loop on its own thread. Each tick:
//!   1. `outbox.drain(batch_size)` returns due, un-poisoned rows.
//!   2. Rows are grouped by `session_id` (backend requires one session
//!      per HTTP call). Within-group order is preserved.
//!   3. Each group becomes a [`SessionEnvelope`] with a fresh v4 UUID
//!      correlation_id and gets sent.
//!   4. The response is folded back into the outbox via `mark_sent` /
//!      `mark_poisoned` / `mark_failed` depending on outcome (see
//!      [`apply_response`]).
//!
//! Poison policy (2b.6.1):
//!   - Per-event `Rejected`  → poison that ULID.
//!   - `ValidationFailed`    → poison every event in the sent batch.
//!   - `DeviceInvalid`,      → poison (won't recover without operator
//!     `SessionInvalid`         action; keep for audit).
//!   - `AuthDenied`          → schedule retry `auth_retry` seconds out
//!                             (may resolve after admin action).
//!   - `MultiDeviceConflict` → schedule retry `multi_device_retry`
//!                             seconds out; UI prompt in 2b.7 handles
//!                             `take_over`.
//!   - `Transient`           → schedule retry `backoff.delay(retry_count)`.
//!
//! Threading:
//!   - The sync loop owns the [`Outbox`] exclusively while running.
//!   - `SyncLoop::shutdown` returns the `Outbox` so callers can inspect
//!     it in tests or drop it explicitly.
//!
//! Not in this slice:
//!   - Real HTTP client (2b.6.2 replaces the mock).
//!   - Network-awareness (pause when offline) (2b.6.3 adds that).
//!   - Entra token acquisition (2b.4; sync loop currently trusts a
//!     placeholder `employee_id` in [`SyncConfig`]).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};

use uuid::Uuid;

use crate::outbox::{Outbox, OutboxEntry, CIPHER_KEY_LEN};

pub mod backoff;
pub mod client;
pub mod reqwest_client;

pub use backoff::BackoffPolicy;
pub use client::{
    BackendClient, PerEventOutcome, PerEventResult, SendBatchResponse, SessionEnvelope,
};
pub use reqwest_client::ReqwestBackendClient;

#[derive(Debug, Clone)]
pub struct SyncConfig {
    /// Device identifier assigned at enrollment. Placeholder until
    /// device enrollment is wired end-to-end in the auth slice (2b.4).
    pub device_id: String,
    /// Signed-in employee. Placeholder for the same reason.
    pub employee_id: String,
    /// Maximum events pulled per outbox drain call.
    pub batch_size: usize,
    /// How often the loop wakes up to drain. On an active session
    /// this is the max latency between event enqueue and HTTP send.
    pub poll_interval: Duration,
    /// Retry delay after an `AuthDenied` response — long enough that
    /// we don't hammer the backend while an admin is fixing an
    /// employee record.
    pub auth_retry: Duration,
    /// Retry delay after `MultiDeviceConflict`. Long enough to give
    /// the user time to interact with the take-over prompt.
    pub multi_device_retry: Duration,
    /// Exponential-backoff schedule for `Transient` failures.
    pub backoff: BackoffPolicy,
}

impl SyncConfig {
    pub fn new(device_id: impl Into<String>, employee_id: impl Into<String>) -> Self {
        Self {
            device_id: device_id.into(),
            employee_id: employee_id.into(),
            batch_size: 100,
            poll_interval: Duration::from_secs(5),
            auth_retry: Duration::from_secs(60),
            multi_device_retry: Duration::from_secs(300),
            backoff: BackoffPolicy::default(),
        }
    }
}

/// Bundle of everything the sync loop needs to actually start on
/// boot. Kept separate from [`SyncConfig`] so the config stays purely
/// about scheduling policy and this holds identity/secret plumbing.
///
/// **Dev-only opt-in for now.** Real production wiring lands with
/// slice 2b.4 (MSAL for bearer token, OS keystore for outbox key,
/// enrollment record for device_id). Until then, unset env vars mean
/// `from_env()` returns `None` and the sync loop stays off.
#[derive(Debug, Clone)]
pub struct SyncBootstrap {
    pub backend_url: String,
    pub bearer_token: String,
    pub device_id: String,
    pub employee_id: String,
    pub outbox_path: PathBuf,
    pub outbox_key: [u8; CIPHER_KEY_LEN],
}

impl SyncBootstrap {
    /// Read six env vars:
    ///   CLOUDPUNCH_BACKEND_URL        — e.g. https://api.cloudpunch.local
    ///   CLOUDPUNCH_BEARER_TOKEN       — placeholder Entra token until 2b.4
    ///   CLOUDPUNCH_DEVICE_ID          — UUID
    ///   CLOUDPUNCH_EMPLOYEE_ID        — UUID
    ///   CLOUDPUNCH_OUTBOX_PATH        — file path for the SQLCipher DB
    ///   CLOUDPUNCH_OUTBOX_KEY_HEX     — 32 bytes hex (64 chars)
    ///
    /// Returns `None` if ANY var is missing or the outbox key isn't
    /// exactly 32 bytes when hex-decoded. Caller (`run()`) treats
    /// `None` as "sync loop stays off, log why".
    pub fn from_env() -> Result<Self, String> {
        use std::env::{var, var_os};
        let backend_url =
            var("CLOUDPUNCH_BACKEND_URL").map_err(|_| "CLOUDPUNCH_BACKEND_URL unset".to_string())?;
        let bearer_token = var("CLOUDPUNCH_BEARER_TOKEN")
            .map_err(|_| "CLOUDPUNCH_BEARER_TOKEN unset".to_string())?;
        let device_id =
            var("CLOUDPUNCH_DEVICE_ID").map_err(|_| "CLOUDPUNCH_DEVICE_ID unset".to_string())?;
        let employee_id = var("CLOUDPUNCH_EMPLOYEE_ID")
            .map_err(|_| "CLOUDPUNCH_EMPLOYEE_ID unset".to_string())?;
        let outbox_path: PathBuf = var_os("CLOUDPUNCH_OUTBOX_PATH")
            .ok_or_else(|| "CLOUDPUNCH_OUTBOX_PATH unset".to_string())?
            .into();
        let key_hex = var("CLOUDPUNCH_OUTBOX_KEY_HEX")
            .map_err(|_| "CLOUDPUNCH_OUTBOX_KEY_HEX unset".to_string())?;
        let key_bytes = hex::decode(key_hex.trim())
            .map_err(|e| format!("CLOUDPUNCH_OUTBOX_KEY_HEX not hex: {e}"))?;
        let outbox_key: [u8; CIPHER_KEY_LEN] = key_bytes.try_into().map_err(|v: Vec<u8>| {
            format!(
                "CLOUDPUNCH_OUTBOX_KEY_HEX decodes to {} bytes, want {CIPHER_KEY_LEN}",
                v.len()
            )
        })?;
        Ok(Self {
            backend_url,
            bearer_token,
            device_id,
            employee_id,
            outbox_path,
            outbox_key,
        })
    }
}

pub struct SyncLoop {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<Outbox>>,
}

impl SyncLoop {
    /// Spawn the loop on a dedicated thread. Returns immediately.
    ///
    /// `is_online` gates HTTP calls — when `false`, the loop sleeps
    /// instead of draining. The network watcher (or a test harness)
    /// flips it. Assumes `true` at start so a fresh boot doesn't
    /// pause for one poll cycle before shipping the first batch.
    pub fn start(
        outbox: Outbox,
        client: Box<dyn BackendClient>,
        config: SyncConfig,
        is_online: Arc<AtomicBool>,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();

        let thread = thread::Builder::new()
            .name("cp-sync-loop".into())
            .spawn(move || {
                let outbox = outbox;
                let client = client;
                let config = config;
                while !stop_clone.load(Ordering::Acquire) {
                    if is_online.load(Ordering::Acquire) {
                        run_tick(&outbox, &*client, &config);
                    }
                    thread::sleep(config.poll_interval);
                }
                outbox
            })
            .expect("failed to spawn cp-sync-loop thread");

        Self {
            stop,
            thread: Some(thread),
        }
    }

    /// Signal the loop to stop and block until the thread exits.
    /// Returns the owned [`Outbox`] so callers (mostly tests) can
    /// inspect the resulting state.
    pub fn shutdown(mut self) -> Outbox {
        self.stop.store(true, Ordering::Release);
        self.thread
            .take()
            .expect("sync loop thread must exist")
            .join()
            .expect("sync loop panicked")
    }
}

/// Single drain-group-send-apply pass. Exposed so tests can drive
/// deterministic ticks without threading.
pub fn run_tick(outbox: &Outbox, client: &dyn BackendClient, config: &SyncConfig) {
    let entries = match outbox.drain(config.batch_size) {
        Ok(e) => e,
        Err(_) => return, // Fatal outbox errors surface via other paths.
    };
    if entries.is_empty() {
        return;
    }

    for group in group_by_session(entries) {
        let envelope = SessionEnvelope {
            device_id: config.device_id.clone(),
            session_id: group[0].session_id.clone(),
            employee_id: config.employee_id.clone(),
            correlation_id: Uuid::new_v4().to_string(),
            take_over: false,
            events: group,
        };
        let response = client.send_batch(&envelope);
        apply_response(outbox, &envelope, response, config);
    }
}

/// Group by session_id while preserving the drain-order of both
/// sessions and events-within-a-session.
fn group_by_session(entries: Vec<OutboxEntry>) -> Vec<Vec<OutboxEntry>> {
    use std::collections::HashMap;
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<OutboxEntry>> = HashMap::new();
    for e in entries {
        if !groups.contains_key(&e.session_id) {
            order.push(e.session_id.clone());
        }
        groups.entry(e.session_id.clone()).or_default().push(e);
    }
    order
        .into_iter()
        .map(|sid| groups.remove(&sid).expect("session id was inserted"))
        .collect()
}

fn apply_response(
    outbox: &Outbox,
    envelope: &SessionEnvelope,
    response: SendBatchResponse,
    config: &SyncConfig,
) {
    match response {
        SendBatchResponse::Accepted { results } => {
            for r in results {
                match r.outcome {
                    PerEventOutcome::Accepted | PerEventOutcome::DuplicateNoop => {
                        let _ = outbox.mark_sent(&r.event_ulid);
                    }
                    PerEventOutcome::Rejected { code, message } => {
                        let _ = outbox
                            .mark_poisoned(&r.event_ulid, &format!("{code}: {message}"));
                    }
                }
            }
        }
        SendBatchResponse::ValidationFailed { message } => {
            let reason = format!("validation: {message}");
            for e in &envelope.events {
                let _ = outbox.mark_poisoned(&e.event_ulid, &reason);
            }
        }
        SendBatchResponse::AuthDenied { reason } => {
            let retry_at = SystemTime::now() + config.auth_retry;
            let msg = format!("auth_denied: {reason}");
            for e in &envelope.events {
                let _ = outbox.mark_failed(&e.event_ulid, &msg, retry_at);
            }
        }
        SendBatchResponse::DeviceInvalid { reason } => {
            let full = format!("device_invalid: {reason}");
            for e in &envelope.events {
                let _ = outbox.mark_poisoned(&e.event_ulid, &full);
            }
        }
        SendBatchResponse::SessionInvalid { reason } => {
            let full = format!("session_invalid: {reason}");
            for e in &envelope.events {
                let _ = outbox.mark_poisoned(&e.event_ulid, &full);
            }
        }
        SendBatchResponse::MultiDeviceConflict {
            existing_session_id,
            existing_device_id,
        } => {
            let retry_at = SystemTime::now() + config.multi_device_retry;
            let msg = format!(
                "multi_device_conflict: existing_session={existing_session_id}, existing_device={existing_device_id}"
            );
            for e in &envelope.events {
                let _ = outbox.mark_failed(&e.event_ulid, &msg, retry_at);
            }
        }
        SendBatchResponse::Transient(err) => {
            let retry_count = envelope
                .events
                .first()
                .map(|e| e.retry_count as u32)
                .unwrap_or(0);
            let retry_at = SystemTime::now() + config.backoff.delay(retry_count);
            for e in &envelope.events {
                let _ = outbox.mark_failed(&e.event_ulid, &err, retry_at);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outbox::{EnqueueInput, Outbox, CIPHER_KEY_LEN};
    use crate::sync::client::{CallRecord, MockClient};
    use rand::RngCore;
    use std::sync::{Arc, Mutex};

    // ---- fixtures ----

    fn make_key() -> [u8; CIPHER_KEY_LEN] {
        let mut k = [0u8; CIPHER_KEY_LEN];
        rand::rngs::OsRng.fill_bytes(&mut k);
        k
    }

    fn mk_event(ulid: &str, seq: i64, session_id: &str) -> EnqueueInput {
        EnqueueInput {
            event_ulid: ulid.to_string(),
            session_id: session_id.to_string(),
            event_type: "USER_CLOCK_IN".to_string(),
            sequence_number: seq,
            event_body: format!(r#"{{"event_ulid":"{ulid}"}}"#).into_bytes(),
            integrity_signature: vec![0u8; 64],
        }
    }

    fn cfg() -> SyncConfig {
        SyncConfig {
            device_id: "dev-11111111-1111-1111-1111-111111111111".to_string(),
            employee_id: "emp-11111111-1111-1111-1111-111111111111".to_string(),
            batch_size: 100,
            poll_interval: Duration::from_millis(20),
            auth_retry: Duration::from_secs(60),
            multi_device_retry: Duration::from_secs(300),
            backoff: BackoffPolicy::default(),
        }
    }

    fn all_accepted(env: &SessionEnvelope) -> SendBatchResponse {
        SendBatchResponse::Accepted {
            results: env
                .events
                .iter()
                .map(|e| PerEventResult {
                    event_ulid: e.event_ulid.clone(),
                    outcome: PerEventOutcome::Accepted,
                })
                .collect(),
        }
    }

    // ---- group_by_session pure fn ----

    #[test]
    fn group_by_session_preserves_first_seen_order_of_sessions() {
        let entries = vec![
            mk_event_full("A", 1, "sess-2"),
            mk_event_full("B", 1, "sess-1"),
            mk_event_full("C", 2, "sess-2"),
            mk_event_full("D", 2, "sess-1"),
        ];
        let groups = group_by_session(entries);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0][0].session_id, "sess-2");
        let ulids_g0: Vec<_> = groups[0].iter().map(|e| e.event_ulid.as_str()).collect();
        let ulids_g1: Vec<_> = groups[1].iter().map(|e| e.event_ulid.as_str()).collect();
        assert_eq!(ulids_g0, vec!["A", "C"]);
        assert_eq!(ulids_g1, vec!["B", "D"]);
    }

    /// Helper that produces an OutboxEntry directly (bypassing the DB)
    /// for unit-testing pure functions.
    fn mk_event_full(ulid: &str, seq: i64, session_id: &str) -> OutboxEntry {
        OutboxEntry {
            event_ulid: ulid.to_string(),
            session_id: session_id.to_string(),
            event_type: "USER_CLOCK_IN".to_string(),
            sequence_number: seq,
            event_body: Vec::new(),
            integrity_signature: Vec::new(),
            created_at: SystemTime::UNIX_EPOCH,
            retry_count: 0,
            next_retry_at: SystemTime::UNIX_EPOCH,
            last_error: None,
            poisoned: false,
            poison_reason: None,
        }
    }

    // ---- run_tick integration with real (in-memory) outbox + mock client ----

    #[test]
    fn accepted_response_removes_rows_from_outbox() {
        let outbox = Outbox::open_in_memory(&make_key()).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000A", 1, "s1")).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000B", 2, "s1")).unwrap();

        let client = MockClient::new(all_accepted);
        run_tick(&outbox, &client, &cfg());

        assert_eq!(outbox.pending_count().unwrap(), 0);
        assert_eq!(client.calls().lock().unwrap().len(), 1);
    }

    #[test]
    fn duplicate_noop_is_treated_as_accepted() {
        let outbox = Outbox::open_in_memory(&make_key()).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000A", 1, "s1")).unwrap();

        let client = MockClient::new(|env| SendBatchResponse::Accepted {
            results: env
                .events
                .iter()
                .map(|e| PerEventResult {
                    event_ulid: e.event_ulid.clone(),
                    outcome: PerEventOutcome::DuplicateNoop,
                })
                .collect(),
        });
        run_tick(&outbox, &client, &cfg());
        assert_eq!(outbox.pending_count().unwrap(), 0);
    }

    #[test]
    fn per_event_rejected_poisons_only_that_ulid() {
        let outbox = Outbox::open_in_memory(&make_key()).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000A", 1, "s1")).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000B", 2, "s1")).unwrap();

        let client = MockClient::new(|env| SendBatchResponse::Accepted {
            results: env
                .events
                .iter()
                .map(|e| {
                    if e.event_ulid.ends_with("A") {
                        PerEventResult {
                            event_ulid: e.event_ulid.clone(),
                            outcome: PerEventOutcome::Rejected {
                                code: "signature_invalid".into(),
                                message: "bad sig".into(),
                            },
                        }
                    } else {
                        PerEventResult {
                            event_ulid: e.event_ulid.clone(),
                            outcome: PerEventOutcome::Accepted,
                        }
                    }
                })
                .collect(),
        });
        run_tick(&outbox, &client, &cfg());

        assert_eq!(outbox.poisoned_count().unwrap(), 1);
        let poisoned = outbox
            .get("01J8Q00000000000000000000A")
            .unwrap()
            .expect("still present");
        assert!(poisoned.poisoned);
        assert!(poisoned
            .poison_reason
            .as_deref()
            .unwrap()
            .contains("signature_invalid"));
        // Accepted row should be gone.
        assert!(outbox.get("01J8Q00000000000000000000B").unwrap().is_none());
    }

    #[test]
    fn validation_failed_poisons_the_whole_batch() {
        let outbox = Outbox::open_in_memory(&make_key()).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000A", 1, "s1")).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000B", 2, "s1")).unwrap();

        let client = MockClient::new(|_| SendBatchResponse::ValidationFailed {
            message: "device_id must be uuid".to_string(),
        });
        run_tick(&outbox, &client, &cfg());
        assert_eq!(outbox.poisoned_count().unwrap(), 2);
    }

    #[test]
    fn device_invalid_poisons_batch_with_prefixed_reason() {
        let outbox = Outbox::open_in_memory(&make_key()).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000A", 1, "s1")).unwrap();

        let client = MockClient::new(|_| SendBatchResponse::DeviceInvalid {
            reason: "device_revoked".into(),
        });
        run_tick(&outbox, &client, &cfg());
        let entry = outbox
            .get("01J8Q00000000000000000000A")
            .unwrap()
            .expect("row present");
        assert!(entry.poisoned);
        assert!(entry
            .poison_reason
            .as_deref()
            .unwrap()
            .starts_with("device_invalid:"));
    }

    #[test]
    fn auth_denied_schedules_long_retry_without_poisoning() {
        let outbox = Outbox::open_in_memory(&make_key()).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000A", 1, "s1")).unwrap();

        let client = MockClient::new(|_| SendBatchResponse::AuthDenied {
            reason: "no_user_for_oid".into(),
        });
        run_tick(&outbox, &client, &cfg());

        let entry = outbox
            .get("01J8Q00000000000000000000A")
            .unwrap()
            .expect("row present");
        assert!(!entry.poisoned);
        assert_eq!(entry.retry_count, 1);
        // At least 50s in the future (config default is 60s).
        assert!(entry.next_retry_at >= SystemTime::now() + Duration::from_secs(50));
    }

    #[test]
    fn multi_device_conflict_schedules_5_minute_retry() {
        let outbox = Outbox::open_in_memory(&make_key()).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000A", 1, "s1")).unwrap();

        let client = MockClient::new(|_| SendBatchResponse::MultiDeviceConflict {
            existing_session_id: "existing-sess".into(),
            existing_device_id: "existing-dev".into(),
        });
        run_tick(&outbox, &client, &cfg());
        let entry = outbox
            .get("01J8Q00000000000000000000A")
            .unwrap()
            .expect("row present");
        assert!(!entry.poisoned);
        assert!(entry.next_retry_at >= SystemTime::now() + Duration::from_secs(250));
    }

    #[test]
    fn transient_response_applies_backoff_ladder() {
        let outbox = Outbox::open_in_memory(&make_key()).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000A", 1, "s1")).unwrap();

        let client = MockClient::new(|_| SendBatchResponse::Transient("500 upstream".into()));

        // Tick 1: retry_count 0 → base 5s.
        run_tick(&outbox, &client, &cfg());
        let after1 = outbox.get("01J8Q00000000000000000000A").unwrap().unwrap();
        assert_eq!(after1.retry_count, 1);

        // Fast-forward: mark next_retry_at to now so drain returns it
        // again on the next tick.
        outbox
            .mark_failed(
                "01J8Q00000000000000000000A",
                "artificial-warp",
                SystemTime::now() - Duration::from_secs(1),
            )
            .unwrap();

        // Tick 2: retry_count 2 → 45s (factor cubed once).
        run_tick(&outbox, &client, &cfg());
        let after2 = outbox.get("01J8Q00000000000000000000A").unwrap().unwrap();
        assert!(after2.retry_count >= 3);
    }

    #[test]
    fn one_http_call_per_session_when_events_span_multiple_sessions() {
        let outbox = Outbox::open_in_memory(&make_key()).unwrap();
        // Interleaved so drain returns them mixed.
        outbox.enqueue(&mk_event("01J8Q00000000000000000000A", 1, "s1")).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000B", 1, "s2")).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000C", 2, "s1")).unwrap();

        let client = MockClient::new(all_accepted);
        run_tick(&outbox, &client, &cfg());

        let calls: Vec<CallRecord> = client.calls().lock().unwrap().clone();
        assert_eq!(calls.len(), 2, "one call per session_id");
        let sids: Vec<&str> = calls.iter().map(|c| c.session_id.as_str()).collect();
        assert!(sids.contains(&"s1") && sids.contains(&"s2"));
        // s1 batch has 2 events, s2 batch has 1.
        let s1 = calls.iter().find(|c| c.session_id == "s1").unwrap();
        let s2 = calls.iter().find(|c| c.session_id == "s2").unwrap();
        assert_eq!(s1.event_ulids.len(), 2);
        assert_eq!(s2.event_ulids.len(), 1);
    }

    // ---- SyncLoop threaded lifecycle ----

    #[test]
    fn syncloop_drains_and_shuts_down_cleanly() {
        let outbox = Outbox::open_in_memory(&make_key()).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000A", 1, "s1")).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000B", 2, "s1")).unwrap();

        let client = MockClient::new(all_accepted);
        let calls = client.calls();
        let online = Arc::new(AtomicBool::new(true));
        let loop_ = SyncLoop::start(outbox, Box::new(client), cfg(), online);

        // Give the loop a couple ticks to drain.
        for _ in 0..20 {
            if !calls.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        let outbox = loop_.shutdown();
        assert_eq!(outbox.pending_count().unwrap(), 0);
        assert!(!calls.lock().unwrap().is_empty());
    }

    #[test]
    fn syncloop_skips_when_offline_and_resumes_when_online_flips() {
        let outbox = Outbox::open_in_memory(&make_key()).unwrap();
        outbox.enqueue(&mk_event("01J8Q00000000000000000000A", 1, "s1")).unwrap();

        let client = MockClient::new(all_accepted);
        let calls = client.calls();
        let online = Arc::new(AtomicBool::new(false));
        let loop_ = SyncLoop::start(outbox, Box::new(client), cfg(), online.clone());

        // Give the loop several tick-intervals to prove it does NOT
        // send while offline.
        std::thread::sleep(Duration::from_millis(150));
        assert!(
            calls.lock().unwrap().is_empty(),
            "sync loop must not send while is_online=false"
        );

        // Flip online — expect at least one call within a few ticks.
        online.store(true, Ordering::Release);
        let mut sent = false;
        for _ in 0..30 {
            if !calls.lock().unwrap().is_empty() {
                sent = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(sent, "sync loop must resume once online flips true");

        let outbox = loop_.shutdown();
        assert_eq!(outbox.pending_count().unwrap(), 0);
    }

    // Suppress unused-import warning when only the loop test uses Arc/Mutex.
    #[allow(dead_code)]
    fn _use(_: Arc<Mutex<()>>) {}
}
