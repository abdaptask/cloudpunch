//! Where emitted [`CoreEvent`]s go.
//!
//! The core decides *what* to record; a sink decides *where*. This PR
//! ships two sinks:
//!   - [`LogSink`] — debug-build stderr log, for smoke tests;
//!   - [`RecordingSink`] — in-memory, for tests.
//!
//! The real sink (encode to the signed wire format, then
//! `Outbox::enqueue`) lands with slice 2b.4, once the device signing
//! key, session id, and ULID generation exist.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use thiserror::Error;

use super::CoreEvent;

#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("event sink failed: {0}")]
pub struct SinkError(pub String);

/// Receives every event the core emits, in emission order.
pub trait EventSink: Send {
    fn record(&mut self, event: &CoreEvent, at: SystemTime) -> Result<(), SinkError>;
}

/// Logs each event to stderr in debug builds; does nothing in release.
///
/// Logs the event type, time, and the state-driving payload only —
/// never the prompt note, which is employee free text.
#[derive(Debug, Default)]
pub struct LogSink;

impl EventSink for LogSink {
    fn record(&mut self, event: &CoreEvent, at: SystemTime) -> Result<(), SinkError> {
        #[cfg(debug_assertions)]
        eprintln!("[cloudpunch] event: {}", describe(event, at));
        #[cfg(not(debug_assertions))]
        let _ = (event, at);
        Ok(())
    }
}

/// One-line, note-free description of an event.
pub fn describe(event: &CoreEvent, at: SystemTime) -> String {
    let secs = at
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!(
        "{} at={secs} {}",
        event.event_type(),
        event.transition_payload()
    )
}

/// Keeps every recorded event in memory. Clones share the same
/// buffer, so a test can hand one clone to the driver and inspect
/// the other.
#[derive(Debug, Clone, Default)]
pub struct RecordingSink {
    events: Arc<Mutex<Vec<(CoreEvent, SystemTime)>>>,
    fail_with: Option<String>,
}

impl RecordingSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// A sink whose every `record` fails with `reason`. Nothing is
    /// stored.
    pub fn failing(reason: impl Into<String>) -> Self {
        Self {
            fail_with: Some(reason.into()),
            ..Self::default()
        }
    }

    pub fn events(&self) -> Vec<(CoreEvent, SystemTime)> {
        self.events.lock().expect("recording sink poisoned").clone()
    }

    pub fn event_types(&self) -> Vec<&'static str> {
        self.events().iter().map(|(e, _)| e.event_type()).collect()
    }
}

impl EventSink for RecordingSink {
    fn record(&mut self, event: &CoreEvent, at: SystemTime) -> Result<(), SinkError> {
        if let Some(reason) = &self.fail_with {
            return Err(SinkError(reason.clone()));
        }
        self.events
            .lock()
            .expect("recording sink poisoned")
            .push((event.clone(), at));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::super::{BreakKind, PromptResponse};
    use super::*;

    fn t(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn recording_sink_keeps_order_and_shares_buffer() {
        let sink = RecordingSink::new();
        let mut handle = sink.clone();
        handle.record(&CoreEvent::UserClockIn, t(1)).unwrap();
        handle
            .record(
                &CoreEvent::UserStartBreak {
                    kind: BreakKind::Bio,
                },
                t(2),
            )
            .unwrap();
        assert_eq!(sink.event_types(), ["USER_CLOCK_IN", "USER_START_BREAK"]);
        assert_eq!(sink.events()[1].1, t(2));
    }

    #[test]
    fn failing_sink_errors_and_stores_nothing() {
        let mut sink = RecordingSink::failing("disk full");
        assert_eq!(
            sink.record(&CoreEvent::UserClockIn, t(1)),
            Err(SinkError("disk full".into()))
        );
        assert!(sink.events().is_empty());
    }

    #[test]
    fn describe_never_includes_the_note() {
        let event = CoreEvent::UserPromptResponse {
            response: PromptResponse::WorkingAway,
            note: Some("visiting my doctor".into()),
            prompt_shown_at: t(100),
        };
        let line = describe(&event, t(110));
        assert!(line.starts_with("USER_PROMPT_RESPONSE at=110 "), "{line}");
        assert!(line.contains("working_away"), "{line}");
        assert!(!line.contains("doctor"), "{line}");
    }

    #[test]
    fn log_sink_never_fails() {
        let mut sink = LogSink;
        assert!(sink.record(&CoreEvent::UserClockIn, t(1)).is_ok());
    }
}
