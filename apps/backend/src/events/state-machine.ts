/**
 * CloudPunch session state machine — MVP subset (ADR-0003 §3).
 *
 * The full ADR-0003 machine has 12 states including several ambient
 * ones (LOCKED / SLEEPING / OFFLINE_PENDING_SYNC / ON_CALL). At the
 * ingest layer, only "payroll states" — the ones that govern which
 * events are legal — need to be enforced. Ambient events are still
 * recorded but they do not change the payroll state, so their
 * validation is a no-op.
 *
 * Deferred to a later slice (see docs/architecture/state-machine.md):
 *   - Prior-state resume on SYSTEM_UNLOCK / SYSTEM_WAKE / NETWORK_ONLINE
 *   - Multi-device concurrent-activity anomaly
 *   - Clock-drift ERROR_FROZEN state
 */

export type PayrollState = 'ACTIVE' | 'ON_BREAK' | 'AWAY' | 'IDLE_PENDING' | 'CLOSED';

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
 * Ambient events (MEDIA_DEVICE_STATE, SYSTEM_LOCK/UNLOCK/SLEEP/WAKE,
 * NETWORK_OFFLINE/ONLINE, etc.) always return the current state.
 * They are recorded but do not gate other events.
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

    case 'USER_CLOCK_IN':
      // The session was already created — a second USER_CLOCK_IN is
      // always invalid at this layer.
      return null;

    case 'USER_CLOCK_OUT':
      if (current === 'CLOSED') return null;
      return 'CLOSED';

    case 'USER_START_BREAK':
      if (current !== 'ACTIVE') return null;
      return 'ON_BREAK';

    case 'USER_END_BREAK':
      if (current !== 'ON_BREAK') return null;
      return 'ACTIVE';

    case 'USER_MARK_AWAY':
      if (current !== 'ACTIVE') return null;
      return 'AWAY';

    case 'USER_MARK_BACK':
      if (current !== 'AWAY') return null;
      return 'ACTIVE';

    case 'INPUT_IDLE_5M':
      if (current !== 'ACTIVE') return null;
      return 'IDLE_PENDING';

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
