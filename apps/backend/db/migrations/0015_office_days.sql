-- =====================================================================
-- CloudPunch migration 0015 — in-office days for hybrid workers
-- =====================================================================
--
-- Introduced: 2026-10-13
-- Implements: ADR-0039 §2
--
-- office_pattern: each person's usual office weekdays from a date; the
--   latest on or before a date applies (as shift_assignment does).
--   Empty weekdays: no usual office days.
-- office_day: a one-off for a person and date, in office or not; the
--   latest row per person and date wins ("untick" is a new row).
-- admin_bulk_request gains the 'office' kind (bulk office weekdays).
--
-- Both append-only, with an audit_log row per change.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE office_pattern (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         uuid NOT NULL REFERENCES employee(id),
  -- ISO weekdays, 1 = Monday … 7 = Sunday. Empty: none.
  weekdays            smallint[] NOT NULL CHECK (weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  effective_from      date NOT NULL,
  reason              text CHECK (reason IS NULL OR length(reason) <= 500),
  set_by_user_id      uuid NOT NULL REFERENCES app_user(id),
  set_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX office_pattern_employee_idx
  ON office_pattern (employee_id, effective_from DESC, set_at DESC);

CREATE TABLE office_day (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         uuid NOT NULL REFERENCES employee(id),
  office_date         date NOT NULL,
  in_office           boolean NOT NULL,
  reason              text CHECK (reason IS NULL OR length(reason) <= 500),
  set_by_user_id      uuid NOT NULL REFERENCES app_user(id),
  set_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX office_day_employee_idx ON office_day (employee_id, office_date, set_at DESC);

COMMENT ON TABLE office_pattern IS
  'Usual in-office weekdays per person (ADR-0039). Append-only; the latest on or before a date applies.';
COMMENT ON TABLE office_day IS
  'One-off in-office (or not) days per person (ADR-0039). Append-only; the latest per person and date wins.';

ALTER TABLE admin_bulk_request DROP CONSTRAINT admin_bulk_request_kind_check;
ALTER TABLE admin_bulk_request ADD CONSTRAINT admin_bulk_request_kind_check
  CHECK (kind IN ('manager', 'roles', 'welcome', 'shift', 'office'));

CREATE TRIGGER office_pattern_no_update
  BEFORE UPDATE ON office_pattern
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER office_pattern_no_delete
  BEFORE DELETE ON office_pattern
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER office_day_no_update
  BEFORE UPDATE ON office_day
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER office_day_no_delete
  BEFORE DELETE ON office_day
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT ON office_pattern, office_day TO cloudpunch_app;
  END IF;
END
$$;
