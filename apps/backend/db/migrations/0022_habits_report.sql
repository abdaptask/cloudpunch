-- =====================================================================
-- CloudPunch migration 0022 — the habits inspector's emails, once
-- =====================================================================
--
-- Introduced: 2026-10-15
-- Implements: ADR-0051 §3
--
-- The weekly "habits so far" emails and the final 30-day report are
-- claimed in report_sent like the day-end email, so each goes once even
-- with retries, restarts or two servers (invariant 4). This only widens
-- the report kinds allowed.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

ALTER TABLE report_sent DROP CONSTRAINT report_sent_report_check;
ALTER TABLE report_sent ADD CONSTRAINT report_sent_report_check
  CHECK (report IN ('day', 'teams_corrections', 'habits'));
