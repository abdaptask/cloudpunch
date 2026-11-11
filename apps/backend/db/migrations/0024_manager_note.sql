-- =====================================================================
-- CloudPunch migration 0024 — "Tell manager" notes
-- =====================================================================
--
-- Introduced: 2026-11-11
-- Implements: ADR-0055 §6
--
-- A note from HR or an Administrator to a person's manager, with the
-- person's 14 days as they were when it went, and a follow-up 14 days
-- later. What was sent never changes: only `seen_*` and the follow-up
-- columns are filled in later, and each step also writes an audit_log
-- row about the person.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE manager_note (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who it is about, and the manager it went to.
  employee_id       uuid NOT NULL REFERENCES employee(id),
  manager_id        uuid NOT NULL REFERENCES employee(id),
  sent_by           uuid NOT NULL REFERENCES app_user(id),
  topics            text[] NOT NULL CHECK (
                      cardinality(topics) >= 1 AND
                      topics <@ ARRAY['activity','timings','breaks','missed']::text[]),
  message           text NOT NULL CHECK (length(message) BETWEEN 10 AND 2000),
  -- The 14 days before it went (ADR-0055 §3), as sent.
  summary           jsonb NOT NULL,
  sent_at           timestamptz NOT NULL,
  seen_at           timestamptz,
  seen_by           uuid REFERENCES app_user(id),
  follow_up_on      date NOT NULL,
  -- Improved / no change / worse, with the numbers (ADR-0055 §5).
  follow_up         jsonb,
  followed_up_at    timestamptz,
  CHECK (employee_id <> manager_id),
  CHECK ((follow_up IS NULL) = (followed_up_at IS NULL))
);

CREATE INDEX manager_note_employee_idx ON manager_note (employee_id, sent_at DESC);
CREATE INDEX manager_note_manager_idx ON manager_note (manager_id, sent_at DESC);
CREATE INDEX manager_note_due_idx ON manager_note (follow_up_on) WHERE followed_up_at IS NULL;

COMMENT ON TABLE manager_note IS
  'A note to a manager about one of their people, and its 14-day follow-up (ADR-0055).';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT, UPDATE ON manager_note TO cloudpunch_app;
  END IF;
END
$$;
