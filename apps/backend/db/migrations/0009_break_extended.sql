-- =====================================================================
-- CloudPunch migration 0009 — the break-extension event
-- =====================================================================
--
-- Introduced: 2026-10-07
-- Implements: ADR-0031 §3 ("5 more min" / "10 more min")
--
-- Additive only: widens the event_type CHECK list (as 0004 did) with
-- USER_BREAK_EXTENDED. No rows change, nothing is dropped, and
-- time_event stays append-only (invariant 2).
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

ALTER TABLE time_event DROP CONSTRAINT time_event_event_type_check;
ALTER TABLE time_event ADD CONSTRAINT time_event_event_type_check CHECK (event_type IN (
  'USER_CLOCK_IN',
  'USER_CLOCK_OUT',
  'USER_PROMPT_RESPONSE',
  'USER_START_BREAK',
  'USER_END_BREAK',
  'USER_MARK_AWAY',
  'USER_MARK_BACK',
  'INPUT_ACTIVITY',
  'INPUT_IDLE_5M',
  'PROMPT_TIMEOUT_30S',
  'MEDIA_DEVICE_STATE',
  'SYSTEM_LOCK',
  'SYSTEM_UNLOCK',
  'SYSTEM_SLEEP',
  'SYSTEM_WAKE',
  'NETWORK_OFFLINE',
  'NETWORK_ONLINE',
  'SERVER_ACK',
  'SERVER_REJECT',
  'CLOCK_DRIFT_DETECTED',
  'SESSION_RECOVERED',
  'INTEGRITY_VIOLATION',
  'IDLE_STARTED',
  'IDLE_ENDED',
  'IDLE_CAP_REACHED',
  'USER_IDLE_EXPLAINED',
  'USER_BREAK_EXTENDED'
));
