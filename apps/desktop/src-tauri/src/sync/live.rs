//! The running sync loop for the signed-in user (2b.4 F3c).
//!
//! Started once the recorder is armed and a backend is configured;
//! stopped on sign-out, before the outbox file and its key are deleted.
//! The loop opens its own connection to the user's outbox (the event
//! sink holds the other; SQLite's busy timeout serialises writes).

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use super::reqwest_client::{ReqwestBackendClient, TokenSource};
use super::{SyncConfig, SyncLoop};
use crate::outbox::{Outbox, OutboxError};

#[derive(Default)]
pub struct LiveSync {
    running: Mutex<Option<Running>>,
}

struct Running {
    oid: String,
    sync: SyncLoop,
}

impl LiveSync {
    /// Start syncing `oid`'s outbox, unless it is already syncing.
    /// A loop for a different user is stopped first.
    pub fn start(
        &self,
        oid: &str,
        outbox_path: &Path,
        outbox_key: &[u8],
        base_url: &str,
        token: TokenSource,
        is_online: Arc<AtomicBool>,
    ) -> Result<(), OutboxError> {
        let mut running = self.lock();
        if running.as_ref().is_some_and(|r| r.oid == oid) {
            return Ok(());
        }
        if let Some(old) = running.take() {
            drop(old.sync.shutdown());
        }
        let outbox = Outbox::open(outbox_path, outbox_key)?;
        let client = ReqwestBackendClient::with_token_source(base_url, token);
        let sync = SyncLoop::start(outbox, Box::new(client), SyncConfig::default(), is_online);
        *running = Some(Running {
            oid: oid.to_string(),
            sync,
        });
        Ok(())
    }

    /// Stop the loop and close its outbox connection. Blocks until the
    /// thread exits (at most one in-flight request).
    pub fn stop(&self) {
        if let Some(r) = self.lock().take() {
            drop(r.sync.shutdown());
        }
    }

    pub fn is_running(&self) -> bool {
        self.lock().is_some()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outbox::{EnqueueInput, CIPHER_KEY_LEN};
    use httpmock::prelude::*;
    use serde_json::json;
    use std::time::{Duration, Instant};

    const KEY: [u8; CIPHER_KEY_LEN] = [3u8; CIPHER_KEY_LEN];

    fn event(ulid: &str, seq: i64) -> EnqueueInput {
        EnqueueInput {
            event_ulid: ulid.into(),
            session_id: "11111111-1111-4111-8111-111111111111".into(),
            event_type: "USER_CLOCK_IN".into(),
            sequence_number: seq,
            event_body: format!(r#"{{"event_ulid":"{ulid}"}}"#).into_bytes(),
            integrity_signature: vec![0u8; 64],
            correlation_id: "22222222-2222-4222-8222-222222222222".into(),
            device_id: "33333333-3333-4333-8333-333333333333".into(),
            employee_id: "44444444-4444-4444-8444-444444444444".into(),
        }
    }

    fn wait_until(mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// End to end through the real client: the stored identity goes on
    /// the envelope, a fresh token on the request, and accepted rows
    /// leave the outbox.
    #[test]
    fn sends_stored_identity_with_a_fresh_token_and_drains() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.db");
        let producer = Outbox::open(&path, &KEY).unwrap();
        producer
            .enqueue(&event("01J8Q00000000000000000000A", 1))
            .unwrap();

        let server = MockServer::start();
        let m = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/events")
                .header("authorization", "Bearer fresh-1")
                .json_body_partial(
                    json!({
                        "device_id": "33333333-3333-4333-8333-333333333333",
                        "employee_id": "44444444-4444-4444-8444-444444444444",
                        "correlation_id": "22222222-2222-4222-8222-222222222222",
                        "session_id": "11111111-1111-4111-8111-111111111111",
                    })
                    .to_string(),
                );
            then.status(200).json_body(json!({
                "status": "batch_accepted",
                "results": [{ "event_ulid": "01J8Q00000000000000000000A", "status": "accepted" }],
            }));
        });

        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = calls.clone();
        let token: TokenSource = Box::new(move || {
            let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            Ok(format!("fresh-{n}"))
        });
        let live = LiveSync::default();
        live.start(
            "oid-a",
            &path,
            &KEY,
            &server.base_url(),
            token,
            Arc::new(AtomicBool::new(true)),
        )
        .unwrap();
        assert!(live.is_running());

        assert!(
            wait_until(|| producer.unsent_count().unwrap() == 0),
            "row was sent and removed"
        );
        m.assert();
        live.stop();
        assert!(!live.is_running());
    }

    #[test]
    fn a_failing_token_keeps_events_for_retry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.db");
        let producer = Outbox::open(&path, &KEY).unwrap();
        producer
            .enqueue(&event("01J8Q00000000000000000000A", 1))
            .unwrap();
        let server = MockServer::start();
        let m = server.mock(|when, then| {
            when.method(POST).path("/v1/events");
            then.status(200);
        });
        let live = LiveSync::default();
        live.start(
            "oid-a",
            &path,
            &KEY,
            &server.base_url(),
            Box::new(|| Err("not_signed_in".into())),
            Arc::new(AtomicBool::new(true)),
        )
        .unwrap();
        assert!(wait_until(|| {
            producer
                .get("01J8Q00000000000000000000A")
                .unwrap()
                .is_some_and(|e| e.retry_count > 0)
        }));
        live.stop();
        m.assert_hits(0);
        assert_eq!(producer.unsent_count().unwrap(), 1);
    }

    #[test]
    fn starting_twice_for_the_same_user_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.db");
        let live = LiveSync::default();
        let offline = Arc::new(AtomicBool::new(false));
        for _ in 0..2 {
            live.start(
                "oid-a",
                &path,
                &KEY,
                "http://127.0.0.1:9",
                Box::new(|| Ok("t".into())),
                offline.clone(),
            )
            .unwrap();
        }
        assert!(live.is_running());
        let started = Instant::now();
        live.stop();
        assert!(started.elapsed() < Duration::from_secs(2), "stop is prompt");
    }
}
