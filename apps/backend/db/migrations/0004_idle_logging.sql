-- 0004 — Log idle time instead of clocking out (ADR-0018).
--
-- Additive only: widens two CHECK lists. No rows change, nothing is
-- dropped, and time_event stays append-only (invariant 2).
--   time_event.event_type     + IDLE_STARTED, IDLE_ENDED,
--                               IDLE_CAP_REACHED, USER_IDLE_EXPLAINED
--   time_session.closed_reason + idle_cap

BEGIN;

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
  'USER_IDLE_EXPLAINED'
));

ALTER TABLE time_session DROP CONSTRAINT time_session_closed_reason_check;
ALTER TABLE time_session ADD CONSTRAINT time_session_closed_reason_check CHECK (closed_reason IN (
  'user_clock_out',
  'idle_auto_clock_out',
  'idle_cap',
  'app_exit_reconstructed',
  'system_shutdown_reconstructed',
  'greythr_termination_forced',
  'remote_takeover',
  'error_frozen'
));

COMMIT;
