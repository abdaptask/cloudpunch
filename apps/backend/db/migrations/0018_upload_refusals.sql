-- =====================================================================
-- CloudPunch migration 0018 — uploads the server refused, counted
-- =====================================================================
--
-- Introduced: 2026-10-13
-- Implements: ADR-0040 §3.4 (adoption and health: "uploads the server
--             refused, such as a computer with a wrong clock")
--
-- One row per computer, person, reason and day, counting the events
-- refused and when it last happened. A computer whose clock runs fast
-- retries every minute; a counter keeps that to one row a day instead
-- of thousands. Not part of the time record: nothing here changes
-- anyone's time, so rows are updated in place (the count goes up).
-- The ids are as the upload gave them (a refused upload may name an
-- unknown computer), so there are no foreign keys.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE upload_refusal (
  device_id      uuid NOT NULL,
  employee_id    uuid NOT NULL,
  reason         text NOT NULL CHECK (reason ~ '^[a-z_]{1,64}$'),
  refused_on     date NOT NULL,
  events         integer NOT NULL CHECK (events >= 0),
  -- How far ahead the computer's clock was, at most, when that's why.
  ahead_seconds  integer,
  first_at       timestamptz NOT NULL,
  last_at        timestamptz NOT NULL,
  PRIMARY KEY (device_id, employee_id, reason, refused_on)
);

CREATE INDEX upload_refusal_day_idx ON upload_refusal (refused_on);

COMMENT ON TABLE upload_refusal IS
  'Uploads the server refused, counted per computer, person, reason and day (ADR-0040 §3.4). Not part of the time record.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT, UPDATE ON upload_refusal TO cloudpunch_app;
  END IF;
END
$$;
