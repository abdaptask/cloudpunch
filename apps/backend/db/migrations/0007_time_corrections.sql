-- =====================================================================
-- CloudPunch migration 0007 — time corrections
-- =====================================================================
--
-- Introduced: 2026-10-07
-- Implements: ADR-0030 §2 (time corrections, stored apart from events)
--
-- Additive only: two new tables. No existing rows change, nothing is
-- dropped, and time_event stays append-only (invariant 2).
--
-- A correction says: for this person, from `from_at` to `to_at`, the
-- time was `kind`, with a reason. Decisions (endorsed, approved,
-- rejected, withdrawn) are rows of their own; a correction's status is
-- derived from them. Both tables are append-only: a mistake is fixed
-- with another correction, never by editing (ADR-0030 §4).
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE time_correction (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id           uuid NOT NULL REFERENCES employee(id),
  from_at               timestamptz NOT NULL,
  to_at                 timestamptz NOT NULL,
  kind                  text NOT NULL CHECK (kind ~ '^[a-z_]{1,40}$'),
  reason                text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  requested_by_user_id  uuid NOT NULL REFERENCES app_user(id),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (to_at > from_at),
  -- ADR-0030 §5: at most 16 hours per correction.
  CHECK (to_at - from_at <= interval '16 hours')
);

CREATE INDEX time_correction_employee_idx ON time_correction (employee_id, from_at);

COMMENT ON TABLE  time_correction IS
  'A requested change to how a stretch of someone''s time counts (ADR-0030). Append-only; status comes from time_correction_decision.';
COMMENT ON COLUMN time_correction.kind IS
  'working, away_working, a break kind (bio_break, meal_break, …) or not_worked. Checked by the API against the fixed list.';
COMMENT ON COLUMN time_correction.reason IS 'Why, in the requester''s words (required, at most 500 characters).';

CREATE TABLE time_correction_decision (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correction_id       uuid NOT NULL REFERENCES time_correction(id),
  decision            text NOT NULL CHECK (decision IN ('endorsed','approved','rejected','withdrawn')),
  decided_by_user_id  uuid NOT NULL REFERENCES app_user(id),
  decided_at          timestamptz NOT NULL DEFAULT now(),
  note                text CHECK (note IS NULL OR length(note) <= 500)
);

CREATE INDEX time_correction_decision_correction_idx
  ON time_correction_decision (correction_id, decided_at);

-- At most one endorsement, and at most one final decision, per
-- correction: two people deciding at once can't both win.
CREATE UNIQUE INDEX time_correction_decision_one_endorsement
  ON time_correction_decision (correction_id) WHERE decision = 'endorsed';
CREATE UNIQUE INDEX time_correction_decision_one_final
  ON time_correction_decision (correction_id) WHERE decision IN ('approved','rejected','withdrawn');

COMMENT ON TABLE time_correction_decision IS
  'Decisions on a time correction (ADR-0030 §3). Append-only. No final decision yet means pending.';

-- Append-only, as time_event and audit_log (function from 0002).
CREATE TRIGGER time_correction_no_update
  BEFORE UPDATE ON time_correction
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER time_correction_no_delete
  BEFORE DELETE ON time_correction
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER time_correction_decision_no_update
  BEFORE UPDATE ON time_correction_decision
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER time_correction_decision_no_delete
  BEFORE DELETE ON time_correction_decision
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();

-- The app role reads and adds; never updates or deletes. Skipped where
-- the role doesn't exist (CI's throwaway database).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT ON time_correction, time_correction_decision TO cloudpunch_app;
  END IF;
END
$$;
