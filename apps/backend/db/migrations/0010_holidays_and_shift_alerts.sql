-- =====================================================================
-- CloudPunch migration 0010 — holidays and shift-start alerts
-- =====================================================================
--
-- Introduced: 2026-10-09
-- Implements: ADR-0037 §1 (holidays) and §3 (shift-start emails)
--
-- Additive only: two new tables. No existing rows change, nothing is
-- dropped, and time_event stays append-only (invariant 2).
--
-- holiday: one company list. Adding or removing a day is a new row;
-- the latest row for a date wins (cancelled = removed).
-- shift_alert: one row per email sent about a shift (missed clock-in,
-- late clock-in, not working). The unique key makes each email go
-- once, even with retries or more than one server (invariant 4).
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE holiday (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date      date NOT NULL,
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  cancelled         boolean NOT NULL DEFAULT false,
  added_by_user_id  uuid NOT NULL REFERENCES app_user(id),
  added_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX holiday_date_idx ON holiday (holiday_date, added_at DESC);

COMMENT ON TABLE holiday IS
  'Company holidays (ADR-0037 §1). Append-only; the latest row for a date applies, cancelled = removed.';

CREATE TABLE shift_alert (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employee(id),
  -- The date the shift starts on, in the shift's zone.
  shift_date    date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('missed', 'late_clock_in', 'not_working')),
  -- Who it went to (addresses), for the record.
  sent_to       text[] NOT NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, shift_date, kind)
);

COMMENT ON TABLE shift_alert IS
  'Shift-start emails sent (ADR-0037 §3). Append-only; unique per person, shift and kind.';

CREATE TRIGGER holiday_no_update
  BEFORE UPDATE ON holiday
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER holiday_no_delete
  BEFORE DELETE ON holiday
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER shift_alert_no_update
  BEFORE UPDATE ON shift_alert
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER shift_alert_no_delete
  BEFORE DELETE ON shift_alert
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();

-- The app role reads and adds; never updates or deletes. Skipped where
-- the role doesn't exist (CI's throwaway database).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT ON holiday, shift_alert TO cloudpunch_app;
  END IF;
END
$$;
