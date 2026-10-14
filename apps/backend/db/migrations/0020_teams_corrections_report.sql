-- =====================================================================
-- CloudPunch migration 0020 — the daily "corrections waiting" Teams post
-- =====================================================================
--
-- Introduced: 2026-10-14
-- Implements: ADR-0043 §3
--
-- The daily Teams post of corrections waiting is claimed in report_sent
-- like the day-end email, so it goes once a day even with retries or
-- two servers (invariant 4). This only widens the report kinds allowed.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

ALTER TABLE report_sent DROP CONSTRAINT report_sent_report_check;
ALTER TABLE report_sent ADD CONSTRAINT report_sent_report_check
  CHECK (report IN ('day', 'teams_corrections'));
