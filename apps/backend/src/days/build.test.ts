import { describe, expect, it } from 'vitest';
import type { TimeEventRecord, TimeSession } from '../db/index.js';
import {
  buildSession,
  isoWithOffset,
  localDate,
  totals,
  workingDays,
  type BuiltSession,
} from './build.js';

const IST = 330;
const EST = -240; // EDT in September
const MIN = 60_000;

/** A UTC instant from a local wall time at `offset`. */
function local(dateTime: string, offset: number): Date {
  return new Date(Date.parse(`${dateTime}Z`) - offset * MIN);
}

let seq = 0;
function evt(
  eventType: string,
  at: Date,
  offset: number,
  payload: Record<string, unknown> = {},
): TimeEventRecord {
  seq += 1;
  return {
    eventUlid: `E${seq}`,
    eventType,
    sessionId: 's',
    employeeId: 'e',
    sequenceNumber: seq,
    clientTs: at,
    serverTs: at,
    monotonicNs: 0,
    tzIana: offset === IST ? 'Asia/Kolkata' : 'America/New_York',
    utcOffsetMinutes: offset,
    deviceId: 'd',
    appVersion: '0.1.0',
    origin: 'user',
    offlineCaptured: false,
    payload,
    integritySignature: new Uint8Array(64),
    correlationId: 'c',
    parentEventUlid: null,
  } as unknown as TimeEventRecord;
}

function session(id: string, openedAt: Date, closedAt: Date | null): TimeSession {
  return {
    id,
    employeeId: 'e',
    deviceId: 'd',
    openedAt,
    closedAt,
    closedReason: closedAt ? 'user_clock_out' : null,
    reconstructed: false,
  };
}

/** A clock-in … clock-out session with optional events in between. */
function shift(
  id: string,
  from: string,
  to: string | null,
  offset: number,
  between: TimeEventRecord[] = [],
  now = new Date(),
): BuiltSession {
  const start = local(from, offset);
  const end = to ? local(to, offset) : null;
  const events = [evt('USER_CLOCK_IN', start, offset), ...between];
  if (end) events.push(evt('USER_CLOCK_OUT', end, offset));
  // Number them in order: clock-in, what happened, clock-out.
  events.forEach((e, i) => ((e as { sequenceNumber: number }).sequenceNumber = i + 1));
  const built = buildSession(session(id, start, end), events, now);
  if (!built) throw new Error('no clock-in');
  return built;
}

describe('buildSession', () => {
  it('replays calls, breaks, prompts and away into desktop segment kinds', () => {
    const o = IST;
    const s = shift('s1', '2026-09-25T09:00:00', '2026-09-25T13:00:00', o, [
      evt('MEDIA_DEVICE_STATE', local('2026-09-25T09:30:00', o), o, {
        in_use: true,
        call_type: 'teams',
      }),
      evt('MEDIA_DEVICE_STATE', local('2026-09-25T10:00:00', o), o, { in_use: false }),
      evt('USER_START_BREAK', local('2026-09-25T10:30:00', o), o, { break_kind: 'bio' }),
      evt('USER_END_BREAK', local('2026-09-25T10:40:00', o), o),
      evt('INPUT_IDLE_5M', local('2026-09-25T11:00:00', o), o, { trigger: 'input_idle' }),
      evt('USER_PROMPT_RESPONSE', local('2026-09-25T11:01:00', o), o, {
        response: 'meal_break',
      }),
      evt('USER_END_BREAK', local('2026-09-25T11:45:00', o), o),
      evt('USER_MARK_AWAY', local('2026-09-25T12:00:00', o), o, { away_reason: 'meeting' }),
      evt('USER_MARK_BACK', local('2026-09-25T12:30:00', o), o),
    ]);
    expect(s.segments.map((g) => [g.kind, isoWithOffset(g.startedAt, o).slice(11, 16)])).toEqual([
      ['working', '09:00'],
      ['call_teams', '09:30'],
      ['working', '10:00'],
      ['bio_break', '10:30'],
      ['working', '10:40'],
      ['prompt', '11:00'],
      ['meal_break', '11:01'],
      ['working', '11:45'],
      ['away_meeting', '12:00'],
      ['working', '12:30'],
    ]);
    expect(isoWithOffset(s.segments.at(-1)!.endedAt, o)).toBe('2026-09-25T13:00:00.000+05:30');
    const t = totals({ date: '2026-09-25', sessions: [s] });
    expect(t.worked_ms).toBe((4 * 60 - 10 - 44 - 1) * MIN); // minus bio, meal, prompt
    expect(t.calls_ms).toBe(30 * MIN);
    expect(t.meetings_ms).toBe(30 * MIN);
    expect(t.breaks_ms).toBe((10 + 44) * MIN);
    expect(t.prompt_ms).toBe(1 * MIN);
  });

  it('an open session runs to now', () => {
    const now = local('2026-09-25T15:00:00', IST);
    const s = shift('s1', '2026-09-25T09:00:00', null, IST, [], now);
    expect(s.open).toBe(true);
    expect(s.segments).toHaveLength(1);
    expect(s.segments[0]?.endedAt).toEqual(now);
  });
});

describe('workingDays (ADR-0016 §1)', () => {
  it('owner example: an IST night shift across midnight is one day, even with a clock-out at midnight', () => {
    const a = shift('a', '2026-09-25T18:30:00', '2026-09-25T23:30:00', IST);
    const b = shift('b', '2026-09-26T00:15:00', '2026-09-26T03:30:00', IST);
    const next = shift('c', '2026-09-26T18:30:00', '2026-09-27T03:30:00', IST);
    const days = workingDays([next, b, a]);
    expect(days.map((d) => [d.date, d.sessions.map((s) => s.session.id)])).toEqual([
      ['2026-09-25', ['a', 'b']],
      ['2026-09-26', ['c']],
    ]);
  });

  it('a lunch clock-out keeps one day; the next morning is a new day', () => {
    const days = workingDays([
      shift('a', '2026-09-25T09:00:00', '2026-09-25T13:00:00', IST),
      shift('b', '2026-09-25T14:00:00', '2026-09-25T18:00:00', IST),
      shift('c', '2026-09-26T09:00:00', '2026-09-26T18:00:00', IST),
    ]);
    expect(days.map((d) => d.sessions.length)).toEqual([2, 1]);
  });

  it('a New York and a Hyderabad employee each get their own local date', () => {
    const ny = shift('ny', '2026-09-25T09:00:00', '2026-09-25T17:00:00', EST);
    const hyd = shift('hyd', '2026-09-25T09:00:00', '2026-09-25T17:00:00', IST);
    // Two employees, one in each office: each day is dated locally.
    expect(workingDays([ny])[0]?.date).toBe('2026-09-25');
    expect(workingDays([hyd])[0]?.date).toBe('2026-09-25');
    expect(isoWithOffset(ny.clockIn, EST)).toBe('2026-09-25T09:00:00.000-04:00');
  });

  it('a gap of just over 6 hours starts a new day; 6 hours exactly does not', () => {
    const a = shift('a', '2026-09-25T08:00:00', '2026-09-25T10:00:00', IST);
    const b = shift('b', '2026-09-25T16:00:00', '2026-09-25T17:00:00', IST);
    const c = shift('c', '2026-09-25T23:00:01', '2026-09-25T23:30:00', IST);
    expect(workingDays([a, b, c]).map((d) => d.sessions.map((s) => s.session.id))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });
});

describe('localDate / isoWithOffset', () => {
  it('use the recorded offset, not the server zone', () => {
    const at = local('2026-09-26T00:30:00', IST);
    expect(localDate(at, IST)).toBe('2026-09-26');
    expect(localDate(at, EST)).toBe('2026-09-25');
    expect(isoWithOffset(at, IST)).toBe('2026-09-26T00:30:00.000+05:30');
  });
});
