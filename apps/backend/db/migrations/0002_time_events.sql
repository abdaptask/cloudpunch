-- =====================================================================
-- CloudPunch migration 0002 — time_session and append-only time_event
-- =====================================================================
--
-- Introduced: Phase 2a (2026-09-23)
-- Implements: ADR-0003 §3 (state transitions produce time_event rows),
--             ADR-0004 §1 (time_event columns), ADR-0004 §4 (sequence
--             number uniqueness), ADR-0004 §5 (Ed25519 signature),
--             ADR-0004 §10 (append-only enforcement)
--
-- Deliberately excluded:
--   - Range partitioning on server_ts. MVP volume does not need it and
--     partitioning complicates unique constraints across partitions
--     (session_id, sequence_number would need the partition key).
--     A later migration introduces partitioning by attaching the
--     existing table as the initial partition; see ADR-0004 §1 note.
--   - break_period, idle_period derived tables — added when the
--     derivation layer lands.
--   - Row-level security policies for retention_worker vs app_rw —
--     introduced with the runner in Phase 2b.
--
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Append-only guard (shared function used by time_event + audit_log)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION deny_mutation_on_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only; UPDATE and DELETE are not permitted', TG_TABLE_NAME
    USING
      ERRCODE = 'insufficient_privilege',
      HINT    = 'Retention removes rows via ALTER TABLE ... DETACH PARTITION once partitioning lands (ADR-0004 §11).';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION deny_mutation_on_append_only IS
  'Raises 42501 (insufficient_privilege) on any UPDATE/DELETE attempted against an append-only table.';

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH STATEMENT
  EXECUTE FUNCTION deny_mutation_on_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH STATEMENT
  EXECUTE FUNCTION deny_mutation_on_append_only();

-- ---------------------------------------------------------------------
-- time_session — one row per clock-in / clock-out cycle
-- ---------------------------------------------------------------------

CREATE TABLE time_session (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id        uuid NOT NULL REFERENCES employee(id),
  device_id          uuid NOT NULL REFERENCES device(id),
  opened_at          timestamptz NOT NULL,
  closed_at          timestamptz,
  closed_reason      text CHECK (closed_reason IN (
    'user_clock_out',
    'idle_auto_clock_out',
    'app_exit_reconstructed',
    'system_shutdown_reconstructed',
    'greythr_termination_forced',
    'remote_takeover',
    'error_frozen'
  )),
  reconstructed      boolean NOT NULL DEFAULT false,
  legal_hold_until   date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (closed_at IS NULL AND closed_reason IS NULL)
    OR
    (closed_at IS NOT NULL AND closed_reason IS NOT NULL AND closed_at >= opened_at)
  )
);

COMMENT ON TABLE  time_session IS 'One row per clock-in/out cycle. See ADR-0003.';
COMMENT ON COLUMN time_session.reconstructed IS 'True when the session was recovered from an app crash, forced shutdown, or otherwise not closed by an explicit user action.';
COMMENT ON COLUMN time_session.legal_hold_until IS 'When set, retention (ADR-0004 §11) may not detach the session''s events until this date passes.';

-- ADR-0003 §4 invariant: at most one non-closed session per employee.
CREATE UNIQUE INDEX time_session_open_per_employee_uniq
  ON time_session (employee_id)
  WHERE closed_at IS NULL;

CREATE INDEX time_session_employee_opened_idx
  ON time_session (employee_id, opened_at DESC);

CREATE INDEX time_session_device_idx ON time_session (device_id);

CREATE TRIGGER time_session_set_updated_at
  BEFORE UPDATE ON time_session
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- time_event — append-only event ledger (ADR-0004)
-- ---------------------------------------------------------------------

CREATE TABLE time_event (
  event_ulid          char(26) PRIMARY KEY,
  event_type          text NOT NULL CHECK (event_type IN (
    'USER_CLOCK_IN',
    'USER_CLOCK_OUT',
    'USER_PROMPT_RESPONSE',
    'USER_START_BREAK',
    'USER_END_BREAK',
    'USER_MARK_AWAY',
    'USER_MARK_BACK',
    'INPUT_ACTIVITY',
    'INPUT_IDLE_5M',
    'PROMPT_TIMEOUT_30S',
    'MEDIA_DEVICE_STATE',
    'SYSTEM_LOCK',
    'SYSTEM_UNLOCK',
    'SYSTEM_SLEEP',
    'SYSTEM_WAKE',
    'NETWORK_OFFLINE',
    'NETWORK_ONLINE',
    'SERVER_ACK',
    'SERVER_REJECT',
    'CLOCK_DRIFT_DETECTED',
    'SESSION_RECOVERED',
    'INTEGRITY_VIOLATION'
  )),
  session_id          uuid NOT NULL REFERENCES time_session(id),
  employee_id         uuid NOT NULL REFERENCES employee(id),
  sequence_number     integer NOT NULL,
  client_ts           timestamptz NOT NULL,
  server_ts           timestamptz NOT NULL DEFAULT now(),
  monotonic_ns        bigint NOT NULL,
  tz_iana             varchar(64) NOT NULL,
  utc_offset_minutes  smallint NOT NULL,
  device_id           uuid NOT NULL REFERENCES device(id),
  app_version         varchar(32) NOT NULL,
  origin              text NOT NULL CHECK (origin IN ('user','system_watcher','server','reconstructed')),
  offline_captured    boolean NOT NULL,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  integrity_signature bytea NOT NULL,
  correlation_id      uuid NOT NULL,
  parent_event_ulid   char(26),
  inserted_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (event_ulid ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  CHECK (sequence_number >= 1),
  CHECK (monotonic_ns >= 0),
  CHECK (utc_offset_minutes BETWEEN -720 AND 840),
  CHECK (octet_length(integrity_signature) = 64),
  CHECK (client_ts <= server_ts + INTERVAL '10 seconds'),
  CHECK (parent_event_ulid IS NULL OR parent_event_ulid ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);

COMMENT ON TABLE  time_event IS 'Append-only event ledger. Every state change is a row here; state itself is derived (ADR-0004).';
COMMENT ON COLUMN time_event.event_ulid IS 'Client-generated Crockford ULID; monotonic per session.';
COMMENT ON COLUMN time_event.sequence_number IS 'Monotonic per session, starts at 1. Gap tolerance is enforced at the ingest layer (ADR-0004 §4).';
COMMENT ON COLUMN time_event.integrity_signature IS 'Ed25519 signature (64 bytes) over canonical bytes of the signed subset. See packages/event-schema/canonicalization.md.';
COMMENT ON COLUMN time_event.parent_event_ulid IS 'Optional causal link, e.g. PROMPT_TIMEOUT_30S points at the INPUT_IDLE_5M that opened the prompt.';

-- Sequence + ULID uniqueness constraints
CREATE UNIQUE INDEX time_event_session_seq_uniq
  ON time_event (session_id, sequence_number);

-- Employee timeline queries
CREATE INDEX time_event_employee_server_ts_idx
  ON time_event (employee_id, server_ts DESC);

-- Trace views + debugging
CREATE INDEX time_event_correlation_idx
  ON time_event (correlation_id);

-- Rare but small; used for causal-chain reconstruction
CREATE INDEX time_event_parent_idx
  ON time_event (parent_event_ulid)
  WHERE parent_event_ulid IS NOT NULL;

-- Append-only enforcement
CREATE TRIGGER time_event_no_update
  BEFORE UPDATE ON time_event
  FOR EACH STATEMENT
  EXECUTE FUNCTION deny_mutation_on_append_only();

CREATE TRIGGER time_event_no_delete
  BEFORE DELETE ON time_event
  FOR EACH STATEMENT
  EXECUTE FUNCTION deny_mutation_on_append_only();

-- =====================================================================
-- End of migration 0002
-- =====================================================================

COMMIT;
