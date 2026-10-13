-- =====================================================================
-- CloudPunch migration 0017 — report emails, once
-- =====================================================================
--
-- Introduced: 2026-10-13
-- Implements: ADR-0040 §2 (the day-end summary)
--
-- One row per report email: which report, the day it covers and who it
-- went to. The primary key makes it go once, even with retries or two
-- servers (invariant 4). Append-only, like weekly_report_sent.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE report_sent (
  report      text NOT NULL CHECK (report IN ('day')),
  report_date date NOT NULL,
  recipient   citext NOT NULL,
  people      integer NOT NULL CHECK (people >= 0),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report, report_date, recipient)
);

COMMENT ON TABLE report_sent IS
  'A report email (ADR-0040), one row per report, day and recipient. Append-only.';

CREATE TRIGGER report_sent_no_update
  BEFORE UPDATE ON report_sent
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER report_sent_no_delete
  BEFORE DELETE ON report_sent
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT ON report_sent TO cloudpunch_app;
  END IF;
END
$$;
