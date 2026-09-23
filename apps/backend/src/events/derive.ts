/**
 * Break + idle period derivation from an event stream.
 *
 * This is a pure function that pairs START events with their END
 * events and emits closed period records. Persistence of the results
 * (materialised `break_period` / `idle_period` tables) lands in Phase
 * 3 when reporting endpoints need them; the derivation logic itself
 * is available today for on-demand queries and tests.
 *
 * Rules (per ADR-0003 §3 and docs/architecture/state-machine.md):
 *   - `USER_START_BREAK` opens a break; `USER_END_BREAK` closes it.
 *   - `USER_PROMPT_RESPONSE` with `bio_break` / `meal_break` opens a
 *     break (the prompt itself is both an idle end and a break start).
 *   - `INPUT_IDLE_5M` opens an idle period; it closes on
 *     `USER_PROMPT_RESPONSE`, `PROMPT_TIMEOUT_30S`, or `INPUT_ACTIVITY`.
 *   - If the session closes while a break or idle is open, the period
 *     is emitted with the session's `closedAt` as `endedAt` and
 *     `sourceEndEventUlid = null`.
 *   - Nested / overlapping breaks are not supported by the state
 *     machine (USER_START_BREAK is only valid from ACTIVE), so a
 *     new START always closes any straggling open period first (with
 *     the previous START's own timestamps as best-effort end).
 */

export type BreakKind = 'bio' | 'meal' | 'other';

export interface DerivedBreakPeriod {
  breakKind: BreakKind;
  startedAt: Date;
  endedAt: Date | null;
  sourceStartEventUlid: string;
  sourceEndEventUlid: string | null;
}

export type IdleResolution = 'user_response' | 'input_dismiss' | 'timeout_close' | 'session_close';

export interface DerivedIdlePeriod {
  startedAt: Date;
  endedAt: Date | null;
  resolution: IdleResolution;
  /** Populated when `resolution === 'user_response'`. */
  response: string | null;
  sourceStartEventUlid: string;
  sourceEndEventUlid: string | null;
}

export interface DeriveResult {
  breaks: readonly DerivedBreakPeriod[];
  idles: readonly DerivedIdlePeriod[];
}

export interface EventForDerivation {
  eventUlid: string;
  eventType: string;
  clientTs: Date;
  payload: Record<string, unknown>;
}

interface OpenBreak {
  start: EventForDerivation;
  kind: BreakKind;
}

/**
 * Fold an ordered event stream into break + idle periods.
 * The input must be sorted by sequence_number (or client_ts) ascending.
 */
export function derivePeriods(
  events: readonly EventForDerivation[],
  sessionClosedAt: Date | null,
): DeriveResult {
  const breaks: DerivedBreakPeriod[] = [];
  const idles: DerivedIdlePeriod[] = [];
  let openBreak: OpenBreak | null = null;
  let openIdle: EventForDerivation | null = null;

  for (const evt of events) {
    // ── close paths first ───────────────────────────────────────
    if (openIdle) {
      if (evt.eventType === 'USER_PROMPT_RESPONSE') {
        idles.push({
          startedAt: openIdle.clientTs,
          endedAt: evt.clientTs,
          resolution: 'user_response',
          response: readString(evt.payload, 'response'),
          sourceStartEventUlid: openIdle.eventUlid,
          sourceEndEventUlid: evt.eventUlid,
        });
        openIdle = null;
      } else if (evt.eventType === 'PROMPT_TIMEOUT_30S') {
        idles.push({
          startedAt: openIdle.clientTs,
          endedAt: evt.clientTs,
          resolution: 'timeout_close',
          response: null,
          sourceStartEventUlid: openIdle.eventUlid,
          sourceEndEventUlid: evt.eventUlid,
        });
        openIdle = null;
      } else if (evt.eventType === 'INPUT_ACTIVITY') {
        idles.push({
          startedAt: openIdle.clientTs,
          endedAt: evt.clientTs,
          resolution: 'input_dismiss',
          response: null,
          sourceStartEventUlid: openIdle.eventUlid,
          sourceEndEventUlid: evt.eventUlid,
        });
        openIdle = null;
      }
    }

    if (openBreak && evt.eventType === 'USER_END_BREAK') {
      breaks.push({
        breakKind: openBreak.kind,
        startedAt: openBreak.start.clientTs,
        endedAt: evt.clientTs,
        sourceStartEventUlid: openBreak.start.eventUlid,
        sourceEndEventUlid: evt.eventUlid,
      });
      openBreak = null;
    }

    // ── open paths ──────────────────────────────────────────────
    if (evt.eventType === 'INPUT_IDLE_5M') {
      // If an idle is already open (shouldn't happen — state machine
      // prevents it), emit the prior with no end and start fresh.
      if (openIdle) {
        idles.push({
          startedAt: openIdle.clientTs,
          endedAt: null,
          resolution: 'session_close',
          response: null,
          sourceStartEventUlid: openIdle.eventUlid,
          sourceEndEventUlid: null,
        });
      }
      openIdle = evt;
    } else if (evt.eventType === 'USER_START_BREAK') {
      if (openBreak) {
        breaks.push({
          breakKind: openBreak.kind,
          startedAt: openBreak.start.clientTs,
          endedAt: null,
          sourceStartEventUlid: openBreak.start.eventUlid,
          sourceEndEventUlid: null,
        });
      }
      const kind = coerceBreakKind(readString(evt.payload, 'break_kind'));
      openBreak = { start: evt, kind };
    } else if (evt.eventType === 'USER_PROMPT_RESPONSE') {
      const response = readString(evt.payload, 'response');
      if (response === 'bio_break' || response === 'meal_break') {
        if (openBreak) {
          breaks.push({
            breakKind: openBreak.kind,
            startedAt: openBreak.start.clientTs,
            endedAt: null,
            sourceStartEventUlid: openBreak.start.eventUlid,
            sourceEndEventUlid: null,
          });
        }
        openBreak = { start: evt, kind: response === 'bio_break' ? 'bio' : 'meal' };
      }
    }
  }

  // ── close any straggling open periods at session end ──────────
  if (openBreak) {
    breaks.push({
      breakKind: openBreak.kind,
      startedAt: openBreak.start.clientTs,
      endedAt: sessionClosedAt,
      sourceStartEventUlid: openBreak.start.eventUlid,
      sourceEndEventUlid: null,
    });
  }
  if (openIdle) {
    idles.push({
      startedAt: openIdle.clientTs,
      endedAt: sessionClosedAt,
      resolution: 'session_close',
      response: null,
      sourceStartEventUlid: openIdle.eventUlid,
      sourceEndEventUlid: null,
    });
  }

  return { breaks, idles };
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' ? v : null;
}

function coerceBreakKind(raw: string | null): BreakKind {
  if (raw === 'bio' || raw === 'meal' || raw === 'other') return raw;
  return 'other';
}
