//! Backend client abstraction for `POST /v1/events`.
//!
//! The real reqwest-backed impl lands in slice 2b.6.2; this module
//! only defines the trait, the request/response shapes the sync loop
//! needs to reason about, and a mock impl used by the sync-loop tests.
//!
//! Response taxonomy is deliberately richer than "OK vs error" because
//! the sync loop takes different actions per outcome:
//!   - `Accepted`            → per-event `mark_sent` / `mark_poisoned`
//!   - `ValidationFailed`    → poison whole batch (payload malformed)
//!   - `AuthDenied`          → long-retry (admin fix may resolve)
//!   - `DeviceInvalid`       → poison (needs re-enrollment)
//!   - `SessionInvalid`      → poison (won't recover)
//!   - `MultiDeviceConflict` → long-retry, UI prompt in 2b.7 decides
//!   - `Transient`           → backoff retry

use std::sync::{Arc, Mutex};

use crate::outbox::OutboxEntry;

/// One session's worth of events plus the batch envelope fields the
/// backend requires. All events in a batch share `session_id`.
#[derive(Debug, Clone)]
pub struct SessionEnvelope {
    pub device_id: String,
    pub session_id: String,
    pub employee_id: String,
    pub correlation_id: String,
    pub take_over: bool,
    pub events: Vec<OutboxEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PerEventResult {
    pub event_ulid: String,
    pub outcome: PerEventOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PerEventOutcome {
    Accepted,
    DuplicateNoop,
    Rejected { code: String, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendBatchResponse {
    /// 200 OK. Per-event outcomes attached in the same order as the
    /// events submitted (backend doesn't guarantee order but same-order
    /// is idiomatic; we key by event_ulid regardless).
    Accepted { results: Vec<PerEventResult> },
    /// 400 — batch payload failed schema validation. The whole batch
    /// is unrecoverable in its current form.
    ValidationFailed { message: String },
    /// 403 — signed-in user isn't permitted to submit for this
    /// employee. May resolve after admin fix, so schedule a long
    /// retry rather than poisoning.
    AuthDenied { reason: String },
    /// 409 — device is unknown / revoked / owned by another user.
    /// Won't recover without re-enrollment; poison.
    DeviceInvalid { reason: String },
    /// 409 — session-lifecycle rejection (not open / already closed /
    /// wrong employee / wrong device). Won't recover; poison.
    SessionInvalid { reason: String },
    /// 409 — the employee already has an open session on another
    /// device. Requires user decision (take_over vs discard);
    /// scheduled with a long retry until the UI prompt (2b.7) resolves.
    MultiDeviceConflict {
        existing_session_id: String,
        existing_device_id: String,
    },
    /// Network error, HTTP 5xx, timeout, anything else. Retry with
    /// exponential backoff.
    Transient(String),
}

pub trait BackendClient: Send {
    fn send_batch(&self, envelope: &SessionEnvelope) -> SendBatchResponse;
}

// ---------------------------------------------------------------
// Test helpers — a mock client used by sync loop tests.
// ---------------------------------------------------------------

/// One call to the mock client. The record captures what the sync
/// loop actually submitted (session, correlation, event ulids). Tests
/// assert against this to verify grouping / batching / correlation.
#[derive(Debug, Clone)]
pub struct CallRecord {
    pub session_id: String,
    pub correlation_id: String,
    pub take_over: bool,
    pub event_ulids: Vec<String>,
}

pub type Handler = dyn Fn(&SessionEnvelope) -> SendBatchResponse + Send + Sync;

/// Test-only backend client. Records each call and returns whatever
/// the supplied handler decides.
pub struct MockClient {
    handler: Box<Handler>,
    calls: Arc<Mutex<Vec<CallRecord>>>,
}

impl MockClient {
    pub fn new(
        handler: impl Fn(&SessionEnvelope) -> SendBatchResponse + Send + Sync + 'static,
    ) -> Self {
        Self {
            handler: Box::new(handler),
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Shared handle to the call log so tests can assert on it while
    /// the client is still owned by the sync loop.
    pub fn calls(&self) -> Arc<Mutex<Vec<CallRecord>>> {
        self.calls.clone()
    }
}

impl BackendClient for MockClient {
    fn send_batch(&self, envelope: &SessionEnvelope) -> SendBatchResponse {
        self.calls.lock().unwrap().push(CallRecord {
            session_id: envelope.session_id.clone(),
            correlation_id: envelope.correlation_id.clone(),
            take_over: envelope.take_over,
            event_ulids: envelope.events.iter().map(|e| e.event_ulid.clone()).collect(),
        });
        (self.handler)(envelope)
    }
}
