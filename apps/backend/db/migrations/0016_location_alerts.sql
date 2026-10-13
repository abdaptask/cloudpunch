-- =====================================================================
-- CloudPunch migration 0016 — "connecting from a new place" emails, once
-- =====================================================================
--
-- Introduced: 2026-10-13
-- Implements: ADR-0041 §3
--
-- One row per email: a person, the new place (city and country,
-- lower-cased) and the day it was sent. The unique key makes it go once,
-- even when two computers report the same new place together
-- (invariant 4). Append-only, like shift_alert.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE location_alert (
  employee_id  uuid NOT NULL REFERENCES employee(id),
  city         text NOT NULL,
  country      text NOT NULL,
  sent_on      date NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, city, country, sent_on)
);

COMMENT ON TABLE location_alert IS
  'A "connecting from a new place" email (ADR-0041), once per person, place and day. Append-only.';

CREATE TRIGGER location_alert_no_update
  BEFORE UPDATE ON location_alert
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER location_alert_no_delete
  BEFORE DELETE ON location_alert
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT ON location_alert TO cloudpunch_app;
  END IF;
END
$$;
