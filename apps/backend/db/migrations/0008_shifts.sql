-- =====================================================================
-- CloudPunch migration 0008 — shifts and "not working today"
-- =====================================================================
--
-- Introduced: 2026-10-07
-- Implements: ADR-0031 §1, §2 and its implementation notes 1–2
--
-- Additive only: two new tables. No existing rows change, nothing is
-- dropped, and time_event stays append-only (invariant 2).
--
-- shift_assignment: a weekly pattern per person, set by an
-- Administrator. A change is a new row (the latest with
-- effective_from on or before a date applies); no days means "no
-- shift". not_working_day: the person said "Not working today" for a
-- shift. Both append-only, like time_correction (0007).
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE shift_assignment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id          uuid NOT NULL REFERENCES employee(id),
  -- ISO weekdays, 1 = Monday … 7 = Sunday. Empty: no shift.
  days                 smallint[] NOT NULL CHECK (days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  start_time           time,
  end_time             time,
  tz_iana              varchar(64) NOT NULL,
  effective_from       date NOT NULL,
  reason               text CHECK (reason IS NULL OR length(reason) <= 500),
  assigned_by_user_id  uuid NOT NULL REFERENCES app_user(id),
  assigned_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (cardinality(days) = 0 AND start_time IS NULL AND end_time IS NULL)
    OR (cardinality(days) > 0 AND start_time IS NOT NULL AND end_time IS NOT NULL
        AND start_time <> end_time)
  )
);

CREATE INDEX shift_assignment_employee_idx
  ON shift_assignment (employee_id, effective_from DESC, assigned_at DESC);

COMMENT ON TABLE shift_assignment IS
  'Weekly shift per person (ADR-0031). Append-only; the latest row with effective_from <= a date applies.';
COMMENT ON COLUMN shift_assignment.end_time IS
  'At or before start_time: the shift ends the next day (overnight).';

CREATE TABLE not_working_day (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id          uuid NOT NULL REFERENCES employee(id),
  -- The date the shift starts on, in the shift's zone.
  shift_date           date NOT NULL,
  declared_by_user_id  uuid NOT NULL REFERENCES app_user(id),
  declared_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, shift_date)
);

COMMENT ON TABLE not_working_day IS
  '"Not working today" for one shift (ADR-0031 §2). Append-only; no reason is asked.';

CREATE TRIGGER shift_assignment_no_update
  BEFORE UPDATE ON shift_assignment
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER shift_assignment_no_delete
  BEFORE DELETE ON shift_assignment
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER not_working_day_no_update
  BEFORE UPDATE ON not_working_day
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER not_working_day_no_delete
  BEFORE DELETE ON not_working_day
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();

-- The app role reads and adds; never updates or deletes. Skipped where
-- the role doesn't exist (CI's throwaway database).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT ON shift_assignment, not_working_day TO cloudpunch_app;
  END IF;
END
$$;
