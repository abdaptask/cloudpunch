-- =====================================================================
-- CloudPunch migration 0012 — the Monday late-starters email, once
-- =====================================================================
--
-- Introduced: 2026-10-09
-- Implements: ADR-0037 §4 (regular late starters)
--
-- One row per recipient per week the Monday email went to. The primary
-- key makes it go once, even with retries or two servers (invariant 4).
-- Append-only, like shift_alert.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE weekly_report_sent (
  week_start  date NOT NULL,
  recipient   citext NOT NULL,
  people      integer NOT NULL CHECK (people >= 0),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (week_start, recipient)
);

COMMENT ON TABLE weekly_report_sent IS
  'The Monday regular-late-starters email, one row per recipient per week (ADR-0037 §4). Append-only.';

CREATE TRIGGER weekly_report_sent_no_update
  BEFORE UPDATE ON weekly_report_sent
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER weekly_report_sent_no_delete
  BEFORE DELETE ON weekly_report_sent
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT ON weekly_report_sent TO cloudpunch_app;
  END IF;
END
$$;
