//! SQLCipher-encrypted local outbox for offline event capture.
//!
//! See ADR-0004 §7 (outbox pattern) and ADR-0007 §5 (SQLCipher key
//! sourced from Windows Credential Manager / macOS Keychain).
//!
//! Contract for callers:
//!   - Every event is `enqueue`d BEFORE any UI acknowledgement, so
//!     the local DB is the source of truth for un-synced events.
//!   - The sync loop calls `drain` to grab a batch, POSTs it, and
//!     then calls `mark_sent` per accepted event or `mark_failed`
//!     per retryable rejection. Duplicates (`duplicate_noop` from the
//!     server) are treated as sent.
//!   - A retried `enqueue` with the same `event_ulid` is a no-op
//!     (schema PK), so producers that don't remember whether they've
//!     already staged an event can safely re-call.
//!
//! Threading: `Outbox` owns a single `rusqlite::Connection`. Callers
//! that share it across tasks/threads wrap in `Arc<Mutex<Outbox>>`.
//! Each method takes `&self` because rusqlite methods do; the internal
//! Connection is `!Sync` but that's enforced by the wrapper choice
//! upstream.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use thiserror::Error;

pub const CIPHER_KEY_LEN: usize = 32;

/// Current schema version. Bump when adding a migration to
/// [`migrate`]. The DB's `PRAGMA user_version` tracks the applied
/// version; migrations run only for the delta.
const SCHEMA_VERSION: i64 = 2;

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS outbox (
    event_ulid           TEXT    PRIMARY KEY,
    session_id           TEXT    NOT NULL,
    event_type           TEXT    NOT NULL,
    sequence_number      INTEGER NOT NULL,
    event_body           BLOB    NOT NULL,
    integrity_signature  BLOB    NOT NULL,
    created_at           INTEGER NOT NULL,
    retry_count          INTEGER NOT NULL DEFAULT 0,
    next_retry_at        INTEGER NOT NULL,
    last_error           TEXT
);

CREATE INDEX IF NOT EXISTS outbox_ready_idx
    ON outbox (next_retry_at, sequence_number);
"#;

/// v2: poisoned flag + reason for events the server permanently
/// rejected (per-event `rejected` result, or a batch-level 400/409
/// that indicates the payload is unrecoverable). Poisoned rows are
/// never returned by [`Outbox::drain`] but stay in the table for
/// audit/diagnostics.
const SCHEMA_V2: &str = r#"
ALTER TABLE outbox ADD COLUMN poisoned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN poison_reason TEXT;
"#;

fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current < 1 {
        conn.execute_batch(SCHEMA_V1)?;
    }
    if current < 2 {
        conn.execute_batch(SCHEMA_V2)?;
    }
    if current < SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum OutboxError {
    #[error("cipher key must be exactly {expected} bytes, got {actual}")]
    WrongKeyLength { expected: usize, actual: usize },
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("system clock is before UNIX_EPOCH")]
    ClockBeforeEpoch,
}

#[derive(Debug, Clone)]
pub struct EnqueueInput {
    pub event_ulid: String,
    pub session_id: String,
    pub event_type: String,
    pub sequence_number: i64,
    pub event_body: Vec<u8>,
    pub integrity_signature: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct OutboxEntry {
    pub event_ulid: String,
    pub session_id: String,
    pub event_type: String,
    pub sequence_number: i64,
    pub event_body: Vec<u8>,
    pub integrity_signature: Vec<u8>,
    pub created_at: SystemTime,
    pub retry_count: i64,
    pub next_retry_at: SystemTime,
    pub last_error: Option<String>,
    /// True when the server has permanently rejected this event.
    /// Poisoned rows are never returned by [`Outbox::drain`] but
    /// remain in the table for forensics.
    pub poisoned: bool,
    pub poison_reason: Option<String>,
}

pub struct Outbox {
    conn: Connection,
}

impl Outbox {
    /// Open an on-disk SQLCipher-encrypted outbox at `db_path`. If the
    /// file does not exist it is created. If it exists but was
    /// encrypted with a different key, the first PRAGMA-guarded
    /// operation returns `SQLITE_NOTADB` which surfaces here as
    /// [`OutboxError::Sqlite`].
    pub fn open(db_path: &Path, cipher_key: &[u8]) -> Result<Self, OutboxError> {
        Self::check_key_len(cipher_key)?;
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        Self::apply_key_and_bootstrap(conn, cipher_key)
    }

    /// Open an in-memory SQLCipher outbox. Useful for unit tests.
    /// Each call creates a fresh isolated DB.
    pub fn open_in_memory(cipher_key: &[u8]) -> Result<Self, OutboxError> {
        Self::check_key_len(cipher_key)?;
        let conn = Connection::open_in_memory()?;
        Self::apply_key_and_bootstrap(conn, cipher_key)
    }

    fn check_key_len(cipher_key: &[u8]) -> Result<(), OutboxError> {
        if cipher_key.len() != CIPHER_KEY_LEN {
            return Err(OutboxError::WrongKeyLength {
                expected: CIPHER_KEY_LEN,
                actual: cipher_key.len(),
            });
        }
        Ok(())
    }

    fn apply_key_and_bootstrap(conn: Connection, cipher_key: &[u8]) -> Result<Self, OutboxError> {
        // SQLCipher requires the key BEFORE any other operation. We
        // pass raw hex to avoid PBKDF derivation — the key material is
        // already 32 bytes of CSPRNG output from the OS keystore.
        let hex_key = hex::encode(cipher_key);
        conn.pragma_update(None, "key", format!("x'{hex_key}'"))?;
        // Verify the key by touching sqlite_master. A wrong key on an
        // existing DB fails here with SQLITE_NOTADB.
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        })?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    /// Stage an event for later transmission. Duplicate `event_ulid`
    /// is a no-op (INSERT OR IGNORE), matching the retry-safety
    /// contract in ADR-0004 §7.
    pub fn enqueue(&self, event: &EnqueueInput) -> Result<(), OutboxError> {
        let now_secs = unix_seconds(SystemTime::now())?;
        self.conn.execute(
            "INSERT OR IGNORE INTO outbox (
                event_ulid, session_id, event_type, sequence_number,
                event_body, integrity_signature,
                created_at, retry_count, next_retry_at, last_error
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?7, NULL)",
            params![
                event.event_ulid,
                event.session_id,
                event.event_type,
                event.sequence_number,
                event.event_body,
                event.integrity_signature,
                now_secs,
            ],
        )?;
        Ok(())
    }

    /// Return up to `max` entries whose `next_retry_at` is in the past
    /// (or now) AND are not poisoned, oldest sequence first. The rows
    /// stay in the outbox until `mark_sent`, `mark_failed`, or
    /// `mark_poisoned` moves them along — a crash mid-batch is safe.
    pub fn drain(&self, max: usize) -> Result<Vec<OutboxEntry>, OutboxError> {
        let now_secs = unix_seconds(SystemTime::now())?;
        let mut stmt = self.conn.prepare(
            "SELECT event_ulid, session_id, event_type, sequence_number,
                    event_body, integrity_signature,
                    created_at, retry_count, next_retry_at, last_error,
                    poisoned, poison_reason
             FROM outbox
             WHERE next_retry_at <= ?1 AND poisoned = 0
             ORDER BY next_retry_at ASC, sequence_number ASC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![now_secs, max as i64], row_to_entry)?;
        rows.collect::<Result<Vec<_>, rusqlite::Error>>()
            .map_err(OutboxError::from)
    }

    /// Remove an event that the server accepted or acknowledged as a
    /// duplicate no-op. Missing rows are a no-op.
    pub fn mark_sent(&self, event_ulid: &str) -> Result<(), OutboxError> {
        self.conn
            .execute("DELETE FROM outbox WHERE event_ulid = ?1", params![event_ulid])?;
        Ok(())
    }

    /// Bump the retry counter, record the last error, and push
    /// `next_retry_at` out to the caller-supplied time. The caller
    /// computes the backoff (exponential + jitter) so this module
    /// doesn't own scheduling policy.
    pub fn mark_failed(
        &self,
        event_ulid: &str,
        error_message: &str,
        next_retry_at: SystemTime,
    ) -> Result<(), OutboxError> {
        let secs = unix_seconds(next_retry_at)?;
        self.conn.execute(
            "UPDATE outbox
             SET retry_count = retry_count + 1,
                 next_retry_at = ?2,
                 last_error = ?3
             WHERE event_ulid = ?1",
            params![event_ulid, secs, error_message],
        )?;
        Ok(())
    }

    /// Fetch a specific entry by ULID (mostly for tests and admin
    /// diagnostics). Returns None if the row was already sent.
    /// Poisoned rows ARE returned by this method — callers inspecting
    /// audit state need to see them.
    pub fn get(&self, event_ulid: &str) -> Result<Option<OutboxEntry>, OutboxError> {
        let mut stmt = self.conn.prepare(
            "SELECT event_ulid, session_id, event_type, sequence_number,
                    event_body, integrity_signature,
                    created_at, retry_count, next_retry_at, last_error,
                    poisoned, poison_reason
             FROM outbox WHERE event_ulid = ?1",
        )?;
        stmt.query_row(params![event_ulid], row_to_entry)
            .optional()
            .map_err(OutboxError::from)
    }

    /// Mark a row as permanently un-sendable and store the reason.
    /// Idempotent — subsequent calls just update `poison_reason`.
    /// Poisoned rows are excluded from [`Outbox::drain`] but remain
    /// visible via [`Outbox::get`] and [`Outbox::poisoned_count`].
    pub fn mark_poisoned(&self, event_ulid: &str, reason: &str) -> Result<(), OutboxError> {
        self.conn.execute(
            "UPDATE outbox
             SET poisoned = 1, poison_reason = ?2
             WHERE event_ulid = ?1",
            params![event_ulid, reason],
        )?;
        Ok(())
    }

    /// Total rows in the outbox (pending + poisoned).
    pub fn pending_count(&self) -> Result<u64, OutboxError> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?;
        Ok(n as u64)
    }

    /// Rows marked poisoned.
    pub fn poisoned_count(&self) -> Result<u64, OutboxError> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM outbox WHERE poisoned = 1",
            [],
            |row| row.get(0),
        )?;
        Ok(n as u64)
    }
}

/// Shared row-to-struct decoder used by both `drain` and `get`.
fn row_to_entry(row: &rusqlite::Row<'_>) -> Result<OutboxEntry, rusqlite::Error> {
    Ok(OutboxEntry {
        event_ulid: row.get(0)?,
        session_id: row.get(1)?,
        event_type: row.get(2)?,
        sequence_number: row.get(3)?,
        event_body: row.get(4)?,
        integrity_signature: row.get(5)?,
        created_at: system_time_from_secs(row.get::<_, i64>(6)?),
        retry_count: row.get(7)?,
        next_retry_at: system_time_from_secs(row.get::<_, i64>(8)?),
        last_error: row.get(9)?,
        poisoned: row.get::<_, i64>(10)? != 0,
        poison_reason: row.get(11)?,
    })
}

fn unix_seconds(t: SystemTime) -> Result<i64, OutboxError> {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .map_err(|_| OutboxError::ClockBeforeEpoch)
}

fn system_time_from_secs(s: i64) -> SystemTime {
    UNIX_EPOCH + std::time::Duration::from_secs(s.max(0) as u64)
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rand::RngCore;
    use std::time::Duration;

    fn make_key() -> [u8; CIPHER_KEY_LEN] {
        let mut k = [0u8; CIPHER_KEY_LEN];
        rand::rngs::OsRng.fill_bytes(&mut k);
        k
    }

    fn mk_input(ulid: &str, seq: i64) -> EnqueueInput {
        EnqueueInput {
            event_ulid: ulid.to_string(),
            session_id: "ssssssss-ssss-ssss-ssss-ssssssssssss".to_string(),
            event_type: "USER_CLOCK_IN".to_string(),
            sequence_number: seq,
            event_body: b"canonical bytes here".to_vec(),
            integrity_signature: vec![0u8; 64],
        }
    }

    #[test]
    fn open_rejects_wrong_key_length() {
        let short = vec![0u8; 31];
        assert!(matches!(
            Outbox::open_in_memory(&short),
            Err(OutboxError::WrongKeyLength { .. })
        ));
    }

    #[test]
    fn enqueue_then_drain_returns_the_event() {
        let key = make_key();
        let outbox = Outbox::open_in_memory(&key).unwrap();
        outbox.enqueue(&mk_input("01J8Q00000000000000000000A", 1)).unwrap();
        let batch = outbox.drain(10).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].event_ulid, "01J8Q00000000000000000000A");
        assert_eq!(batch[0].sequence_number, 1);
        assert_eq!(batch[0].retry_count, 0);
        assert!(batch[0].last_error.is_none());
    }

    #[test]
    fn enqueue_is_idempotent_on_duplicate_ulid() {
        let key = make_key();
        let outbox = Outbox::open_in_memory(&key).unwrap();
        let evt = mk_input("01J8Q00000000000000000000A", 1);
        outbox.enqueue(&evt).unwrap();
        outbox.enqueue(&evt).unwrap();
        assert_eq!(outbox.pending_count().unwrap(), 1);
    }

    #[test]
    fn drain_orders_by_sequence_then_next_retry() {
        let key = make_key();
        let outbox = Outbox::open_in_memory(&key).unwrap();
        outbox.enqueue(&mk_input("01J8Q00000000000000000000B", 2)).unwrap();
        outbox.enqueue(&mk_input("01J8Q00000000000000000000A", 1)).unwrap();
        outbox.enqueue(&mk_input("01J8Q00000000000000000000C", 3)).unwrap();
        let batch = outbox.drain(10).unwrap();
        let seqs: Vec<i64> = batch.iter().map(|e| e.sequence_number).collect();
        assert_eq!(seqs, vec![1, 2, 3]);
    }

    #[test]
    fn drain_respects_max_batch() {
        let key = make_key();
        let outbox = Outbox::open_in_memory(&key).unwrap();
        for i in 1..=10 {
            let ulid = format!("01J8Q000000000000000000{:03}", i);
            outbox.enqueue(&mk_input(&ulid, i)).unwrap();
        }
        assert_eq!(outbox.drain(3).unwrap().len(), 3);
    }

    #[test]
    fn mark_sent_removes_the_row() {
        let key = make_key();
        let outbox = Outbox::open_in_memory(&key).unwrap();
        outbox.enqueue(&mk_input("01J8Q00000000000000000000A", 1)).unwrap();
        outbox.mark_sent("01J8Q00000000000000000000A").unwrap();
        assert_eq!(outbox.pending_count().unwrap(), 0);
        assert!(outbox.get("01J8Q00000000000000000000A").unwrap().is_none());
    }

    #[test]
    fn mark_sent_missing_row_is_noop() {
        let key = make_key();
        let outbox = Outbox::open_in_memory(&key).unwrap();
        outbox.mark_sent("never-existed").unwrap();
        assert_eq!(outbox.pending_count().unwrap(), 0);
    }

    #[test]
    fn mark_failed_bumps_counter_and_pushes_next_retry() {
        let key = make_key();
        let outbox = Outbox::open_in_memory(&key).unwrap();
        outbox.enqueue(&mk_input("01J8Q00000000000000000000A", 1)).unwrap();

        let future = SystemTime::now() + Duration::from_secs(120);
        outbox
            .mark_failed("01J8Q00000000000000000000A", "500 upstream", future)
            .unwrap();

        // drain(now) should return NOTHING because next_retry_at is in
        // the future.
        assert!(outbox.drain(10).unwrap().is_empty());

        let entry = outbox
            .get("01J8Q00000000000000000000A")
            .unwrap()
            .expect("row still present");
        assert_eq!(entry.retry_count, 1);
        assert_eq!(entry.last_error.as_deref(), Some("500 upstream"));
        assert!(entry.next_retry_at >= SystemTime::now() + Duration::from_secs(60));
    }

    #[test]
    fn on_disk_persists_across_reopens_with_the_same_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.db");
        let key = make_key();

        {
            let outbox = Outbox::open(&path, &key).unwrap();
            outbox.enqueue(&mk_input("01J8Q00000000000000000000A", 1)).unwrap();
            outbox.enqueue(&mk_input("01J8Q00000000000000000000B", 2)).unwrap();
        }

        let reopened = Outbox::open(&path, &key).unwrap();
        assert_eq!(reopened.pending_count().unwrap(), 2);
        let batch = reopened.drain(10).unwrap();
        assert_eq!(batch.len(), 2);
    }

    #[test]
    fn mark_poisoned_flags_row_and_excludes_from_drain() {
        let key = make_key();
        let outbox = Outbox::open_in_memory(&key).unwrap();
        outbox
            .enqueue(&mk_input("01J8Q00000000000000000000A", 1))
            .unwrap();
        outbox
            .enqueue(&mk_input("01J8Q00000000000000000000B", 2))
            .unwrap();

        outbox
            .mark_poisoned("01J8Q00000000000000000000A", "signature_invalid: bad sig")
            .unwrap();

        // Drain returns only the un-poisoned row.
        let batch = outbox.drain(10).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].event_ulid, "01J8Q00000000000000000000B");

        // Poisoned row still visible via get, with reason preserved.
        let poisoned = outbox
            .get("01J8Q00000000000000000000A")
            .unwrap()
            .expect("poisoned row still exists");
        assert!(poisoned.poisoned);
        assert_eq!(
            poisoned.poison_reason.as_deref(),
            Some("signature_invalid: bad sig")
        );

        assert_eq!(outbox.pending_count().unwrap(), 2);
        assert_eq!(outbox.poisoned_count().unwrap(), 1);
    }

    #[test]
    fn mark_poisoned_is_idempotent_and_updates_reason() {
        let key = make_key();
        let outbox = Outbox::open_in_memory(&key).unwrap();
        outbox
            .enqueue(&mk_input("01J8Q00000000000000000000A", 1))
            .unwrap();
        outbox
            .mark_poisoned("01J8Q00000000000000000000A", "first")
            .unwrap();
        outbox
            .mark_poisoned("01J8Q00000000000000000000A", "second")
            .unwrap();
        let entry = outbox
            .get("01J8Q00000000000000000000A")
            .unwrap()
            .expect("row present");
        assert!(entry.poisoned);
        assert_eq!(entry.poison_reason.as_deref(), Some("second"));
    }

    #[test]
    fn mark_poisoned_missing_row_is_noop() {
        let key = make_key();
        let outbox = Outbox::open_in_memory(&key).unwrap();
        outbox.mark_poisoned("never-existed", "nope").unwrap();
        assert_eq!(outbox.poisoned_count().unwrap(), 0);
    }

    /// The whole point of SQLCipher — the on-disk DB is unreadable
    /// without the right key. Opening with a wrong key surfaces as a
    /// SQLite error on the first PRAGMA-guarded query.
    #[test]
    fn wrong_key_cannot_open_existing_db() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.db");
        let key = make_key();

        {
            let outbox = Outbox::open(&path, &key).unwrap();
            outbox.enqueue(&mk_input("01J8Q00000000000000000000A", 1)).unwrap();
        }

        let mut wrong = key;
        wrong[0] ^= 0xff;
        assert!(matches!(
            Outbox::open(&path, &wrong),
            Err(OutboxError::Sqlite(_))
        ));
    }
}
