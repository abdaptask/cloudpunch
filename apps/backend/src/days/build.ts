import type { TimeEventRecord, TimeSession } from '../db/index.js';
import { nextState, type PayrollState } from '../events/state-machine.js';

/**
 * Day history (ADR-0016). Pure: sessions and their events in, working
 * days with segments out.
 *
 * - Segments are rebuilt by replaying a session's events through the
 *   shared state machine, and use the same kinds the desktop draws.
 * - Times keep the offset each event was recorded with, so they are
 *   shown on the clock of the computer where the work happened.
 * - A working day is a run of sessions, each starting within
 *   `MAX_GAP_MS` of the previous one ending, dated by its first
 *   clock-in in that computer's own zone. Never split at midnight.
 */

export const MAX_GAP_MS = 6 * 3_600_000;

export type SegmentKind =
  | 'working'
  | 'call_teams'
  | 'call_zoom'
  | 'call_other'
  | 'bio_break'
  | 'meal_break'
  | 'other_break'
  | 'away_meeting'
  | 'away_phone'
  | 'away_working'
  | 'prompt';

export interface DaySegment {
  kind: SegmentKind;
  startedAt: Date;
  endedAt: Date;
  /** Offset (minutes east of UTC) of the event that started it. */
  offsetMinutes: number;
}

export interface BuiltSession {
  session: TimeSession;
  tzIana: string;
  /** Offset recorded at clock-in. */
  offsetMinutes: number;
  clockIn: Date;
  /** Where the session ends: its close, else the last segment's end. */
  end: Date;
  open: boolean;
  segments: DaySegment[];
}

export interface WorkingDay {
  /** `YYYY-MM-DD`, the local date of the first clock-in. */
  date: string;
  sessions: BuiltSession[];
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function callKind(callType: string | null): SegmentKind {
  if (callType === 'teams') return 'call_teams';
  if (callType === 'zoom') return 'call_zoom';
  return 'call_other';
}

function breakKind(kind: string | null): SegmentKind {
  if (kind === 'bio') return 'bio_break';
  if (kind === 'meal') return 'meal_break';
  return 'other_break';
}

function awayKind(reason: string | null): SegmentKind {
  if (reason === 'meeting') return 'away_meeting';
  if (reason === 'phone_call') return 'away_phone';
  return 'away_working';
}

/** The segment kind after `evt` moved the state to `next`. */
function kindAfter(
  next: PayrollState,
  evt: TimeEventRecord,
  current: SegmentKind | null,
): SegmentKind | null {
  const p = evt.payload;
  switch (next) {
    case 'ACTIVE':
      return 'working';
    case 'ON_CALL':
      // A call in progress keeps its kind unless the event names one.
      return str(p['call_type']) !== null
        ? callKind(str(p['call_type']))
        : current?.startsWith('call_')
          ? current
          : 'call_other';
    case 'ON_BREAK':
      if (evt.eventType === 'USER_START_BREAK') return breakKind(str(p['break_kind']));
      if (str(p['response']) === 'bio_break') return 'bio_break';
      if (str(p['response']) === 'meal_break') return 'meal_break';
      return current ?? 'other_break';
    case 'AWAY':
      if (evt.eventType === 'USER_MARK_AWAY') return awayKind(str(p['away_reason']));
      if (str(p['response']) === 'on_phone_call') return 'away_phone';
      if (str(p['response']) === 'working_away') return 'away_working';
      return current ?? 'away_working';
    case 'IDLE_PENDING':
      return 'prompt';
    case 'CLOSED':
      return null;
  }
}

/** One session's segments, from its events in sequence order. */
export function buildSession(
  session: TimeSession,
  events: readonly TimeEventRecord[],
  now: Date,
): BuiltSession | null {
  const ordered = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const clockInEvt = ordered.find((e) => e.eventType === 'USER_CLOCK_IN');
  if (!clockInEvt) return null;

  const segments: DaySegment[] = [];
  let state: PayrollState = 'CLOSED';
  // The segment in progress, if any.
  const cur: { seg: { kind: SegmentKind; startedAt: Date; offsetMinutes: number } | null } = {
    seg: null,
  };
  const closeAt = (at: Date): void => {
    const seg = cur.seg;
    if (seg && at > seg.startedAt) segments.push({ ...seg, endedAt: at });
    cur.seg = null;
  };

  for (const evt of ordered) {
    let next: PayrollState | null;
    if (evt.eventType === 'USER_CLOCK_IN') {
      next = state === 'CLOSED' ? 'ACTIVE' : null;
    } else {
      next = nextState(state, evt.eventType, evt.payload);
    }
    if (next === null) continue; // ingest already rejected invalid ones
    const kind = kindAfter(next, evt, cur.seg?.kind ?? null);
    state = next;
    if (kind === (cur.seg?.kind ?? null)) continue;
    closeAt(evt.clientTs);
    if (kind) cur.seg = { kind, startedAt: evt.clientTs, offsetMinutes: evt.utcOffsetMinutes };
  }

  const isOpen = session.closedAt === null;
  closeAt(session.closedAt ?? now);
  const last = segments[segments.length - 1];
  return {
    session,
    tzIana: clockInEvt.tzIana,
    offsetMinutes: clockInEvt.utcOffsetMinutes,
    clockIn: clockInEvt.clientTs,
    end: isOpen ? now : (session.closedAt ?? last?.endedAt ?? clockInEvt.clientTs),
    open: isOpen,
    segments,
  };
}

/** Local calendar date of `at` at `offsetMinutes`. */
export function localDate(at: Date, offsetMinutes: number): string {
  return new Date(at.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** ISO 8601 with the recorded offset: `2026-09-25T18:30:00.000+05:30`. */
export function isoWithOffset(at: Date, offsetMinutes: number): string {
  const local = new Date(at.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 23);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}

/** Group sessions (any order) into working days (ADR-0016 §1). */
export function workingDays(sessions: readonly BuiltSession[]): WorkingDay[] {
  const sorted = [...sessions].sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime());
  const days: WorkingDay[] = [];
  let current: WorkingDay | null = null;
  let lastEnd = 0;
  for (const s of sorted) {
    if (current && s.clockIn.getTime() - lastEnd <= MAX_GAP_MS) {
      current.sessions.push(s);
    } else {
      current = { date: localDate(s.clockIn, s.offsetMinutes), sessions: [s] };
      days.push(current);
    }
    lastEnd = Math.max(lastEnd, s.end.getTime());
  }
  return days;
}

export interface DayTotals {
  worked_ms: number;
  calls_ms: number;
  meetings_ms: number;
  breaks_ms: number;
  prompt_ms: number;
}

/** Worked = at the computer + calls + away (meeting/phone/working away). */
export function totals(day: WorkingDay | null): DayTotals {
  const out: DayTotals = { worked_ms: 0, calls_ms: 0, meetings_ms: 0, breaks_ms: 0, prompt_ms: 0 };
  for (const s of day?.sessions ?? []) {
    for (const seg of s.segments) {
      const ms = seg.endedAt.getTime() - seg.startedAt.getTime();
      if (seg.kind.endsWith('_break')) out.breaks_ms += ms;
      else if (seg.kind === 'prompt') out.prompt_ms += ms;
      else {
        out.worked_ms += ms;
        if (seg.kind.startsWith('call_')) out.calls_ms += ms;
        if (seg.kind === 'away_meeting') out.meetings_ms += ms;
      }
    }
  }
  return out;
}
