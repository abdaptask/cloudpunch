/**
 * CloudPunch session state machine — MVP subset (ADR-0003 §3).
 *
 * The full ADR-0003 machine has 12 states including several ambient
 * ones (LOCKED / SLEEPING / OFFLINE_PENDING_SYNC). At the ingest
 * layer, only "payroll states" — the ones that govern which events
 * are legal — need to be enforced. Ambient events are still recorded
 * but they do not change the payroll state, so their validation is a
 * no-op.
 *
 * ON_CALL is a payroll state (ADR-0009): MEDIA_DEVICE_STATE moves
 * ACTIVE / IDLE_PENDING into it and back out to ACTIVE, and it gates
 * which user events are legal. A long silent call can open the prompt
 * (INPUT_IDLE_5M with trigger=silent_call, ADR-0010).
 *
 * Deferred to a later slice (see docs/architecture/state-machine.md):
 *   - Prior-state resume on SYSTEM_UNLOCK / SYSTEM_WAKE / NETWORK_ONLINE
 *   - Multi-device concurrent-activity anomaly
 *   - Clock-drift ERROR_FROZEN state
 */

export type PayrollState = 'ACTIVE' | 'ON_CALL' | 'ON_BREAK' | 'AWAY' | 'IDLE_PENDING' | 'CLOSED';

/**
 * State a session enters immediately after USER_CLOCK_IN is accepted.
 * The client has clocked in and is presumed working until proven
 * otherwise.
 */
export const INITIAL_STATE: PayrollState = 'ACTIVE';

/**
 * Ambient event types — recorded but do not change payroll state.
 */
const AMBIENT_EVENTS: ReadonlySet<string> = new Set([
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
]);

/** `MEDIA_DEVICE_STATE.payload.call_type` (ADR-0012). */
const CALL_TYPES: ReadonlySet<string> = new Set(['teams', 'zoom', 'other']);

/** `USER_MARK_AWAY.payload.away_reason` (ADR-0011 §2). */
const AWAY_REASONS: ReadonlySet<string> = new Set([
  'working_away',
  'phone_call',
  'meeting',
  'other',
]);

const PROMPT_RESPONSES: ReadonlySet<string> = new Set([
  'still_working',
  'bio_break',
  'meal_break',
  'on_phone_call',
  'working_away',
  'end_shift',
]);

/**
 * Compute the next payroll state given the current state and an
 * incoming event. Returns `null` if the transition is invalid — the
 * ingest layer converts that into a `state_transition_invalid`
 * per-event rejection.
 *
 * Ambient events (SYSTEM_LOCK/UNLOCK/SLEEP/WAKE, NETWORK_OFFLINE/
 * ONLINE, etc.) always return the current state. They are recorded
 * but do not gate other events.
 *
 * USER_CLOCK_IN can only be the first event of a session. The ingest
 * layer's session-lookup path creates the session on the first
 * USER_CLOCK_IN before it ever calls this function; so if this
 * function receives USER_CLOCK_IN, the session already exists — that
 * is always an invalid transition.
 */
export function nextState(
  current: PayrollState,
  eventType: string,
  payload?: Record<string, unknown>,
): PayrollState | null {
  if (AMBIENT_EVENTS.has(eventType)) return current;

  switch (eventType) {
    case 'INPUT_ACTIVITY':
      // Activity never changes state. In particular it does NOT
      // dismiss a visible idle prompt — the user must answer it, and
      // the client resets its grace countdown instead (ADR-0008).
      return current;

    case 'MEDIA_DEVICE_STATE': {
      // ADR-0009: { in_use: boolean }, plus an optional call_type
      // category while in use (ADR-0012).
      const inUse = payload?.['in_use'];
      if (typeof inUse !== 'boolean') return null;
      if (payload && 'call_type' in payload) {
        const callType = payload['call_type'];
        if (!inUse || typeof callType !== 'string' || !CALL_TYPES.has(callType)) return null;
      }
      if (inUse && (current === 'ACTIVE' || current === 'IDLE_PENDING')) return 'ON_CALL';
      if (!inUse && current === 'ON_CALL') return 'ACTIVE';
      // Every other combination is recorded without changing state.
      return current;
    }

    case 'USER_CLOCK_IN':
      // The session was already created — a second USER_CLOCK_IN is
      // always invalid at this layer.
      return null;

    case 'USER_CLOCK_OUT':
      if (current === 'CLOSED') return null;
      return 'CLOSED';

    case 'USER_START_BREAK':
      if (current !== 'ACTIVE' && current !== 'ON_CALL') return null;
      return 'ON_BREAK';

    case 'USER_END_BREAK':
      if (current !== 'ON_BREAK') return null;
      return 'ACTIVE';

    case 'USER_MARK_AWAY': {
      if (current !== 'ACTIVE') return null;
      // ADR-0011 §2: the reason is required and must be known.
      const reason = payload?.['away_reason'];
      if (typeof reason !== 'string' || !AWAY_REASONS.has(reason)) return null;
      return 'AWAY';
    }

    case 'USER_MARK_BACK':
      if (current !== 'AWAY') return null;
      return 'ACTIVE';

    case 'INPUT_IDLE_5M': {
      // ADR-0010: `trigger` says why the prompt opened; absent means
      // input_idle. Each trigger is only legal from its own state.
      const trigger = payload && 'trigger' in payload ? payload['trigger'] : 'input_idle';
      if (trigger === 'input_idle') return current === 'ACTIVE' ? 'IDLE_PENDING' : null;
      if (trigger === 'silent_call') return current === 'ON_CALL' ? 'IDLE_PENDING' : null;
      return null;
    }

    case 'PROMPT_TIMEOUT_30S':
      if (current !== 'IDLE_PENDING') return null;
      return 'CLOSED';

    case 'USER_PROMPT_RESPONSE': {
      if (current !== 'IDLE_PENDING') return null;
      const response =
        payload && typeof payload['response'] === 'string' ? payload['response'] : null;
      if (!response || !PROMPT_RESPONSES.has(response)) return null;
      switch (response) {
        case 'still_working':
          return 'ACTIVE';
        case 'bio_break':
        case 'meal_break':
          return 'ON_BREAK';
        case 'on_phone_call':
        case 'working_away':
          return 'AWAY';
        case 'end_shift':
          return 'CLOSED';
        default:
          return null;
      }
    }

    default:
      // Unknown event types are rejected. The zod schema at the API
      // boundary already prevents this in practice.
      return null;
  }
}

/**
 * Fold an ordered event stream into the current PayrollState. If the
 * stream is empty, returns {@link INITIAL_STATE} — the state a
 * session enters at USER_CLOCK_IN.
 *
 * Invalid transitions in historical data are treated as no-ops here
 * (state remains what it was). At ingest time, invalid transitions
 * are rejected before persistence, so this defensive behaviour is a
 * safety net for corrupted or edge-case data.
 */
export function deriveState(
  events: Iterable<{ eventType: string; payload: Record<string, unknown> }>,
): PayrollState {
  let state: PayrollState = INITIAL_STATE;
  for (const evt of events) {
    const next = nextState(state, evt.eventType, evt.payload);
    if (next !== null) state = next;
  }
  return state;
}
