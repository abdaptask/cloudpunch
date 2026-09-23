import { describe, expect, it } from 'vitest';
import { derivePeriods, type EventForDerivation } from './derive.js';

const t = (isoOrOffsetMinutes: string | number, base = new Date('2026-09-23T09:00:00Z')): Date => {
  if (typeof isoOrOffsetMinutes === 'string') return new Date(isoOrOffsetMinutes);
  return new Date(base.getTime() + isoOrOffsetMinutes * 60_000);
};

let ulidSeq = 0;
const ulid = (): string => {
  ulidSeq++;
  return `01J8Q0000000000000000000${ulidSeq.toString(16).padStart(2, '0').toUpperCase()}`;
};

const evt = (
  eventType: string,
  minutesAfterStart: number,
  payload: Record<string, unknown> = {},
): EventForDerivation => ({
  eventUlid: ulid(),
  eventType,
  clientTs: t(minutesAfterStart),
  payload,
});

describe('derivePeriods — breaks', () => {
  it('empty stream returns no periods', () => {
    const r = derivePeriods([], null);
    expect(r.breaks).toEqual([]);
    expect(r.idles).toEqual([]);
  });

  it('START_BREAK → END_BREAK produces one closed break', () => {
    ulidSeq = 0;
    const start = evt('USER_START_BREAK', 60, { break_kind: 'bio' });
    const end = evt('USER_END_BREAK', 65);
    const r = derivePeriods([start, end], null);
    expect(r.breaks).toHaveLength(1);
    expect(r.breaks[0]?.breakKind).toBe('bio');
    expect(r.breaks[0]?.startedAt).toEqual(start.clientTs);
    expect(r.breaks[0]?.endedAt).toEqual(end.clientTs);
    expect(r.breaks[0]?.sourceStartEventUlid).toBe(start.eventUlid);
    expect(r.breaks[0]?.sourceEndEventUlid).toBe(end.eventUlid);
  });

  it('unpaired START_BREAK at session close emits open-ended break', () => {
    ulidSeq = 0;
    const start = evt('USER_START_BREAK', 60, { break_kind: 'meal' });
    const closed = t(120);
    const r = derivePeriods([start], closed);
    expect(r.breaks).toHaveLength(1);
    expect(r.breaks[0]?.breakKind).toBe('meal');
    expect(r.breaks[0]?.endedAt).toEqual(closed);
    expect(r.breaks[0]?.sourceEndEventUlid).toBeNull();
  });

  it('unknown/missing break_kind coerces to "other"', () => {
    ulidSeq = 0;
    const start = evt('USER_START_BREAK', 60, {});
    const end = evt('USER_END_BREAK', 65);
    const r = derivePeriods([start, end], null);
    expect(r.breaks[0]?.breakKind).toBe('other');
  });

  it('multiple sequential breaks in one session', () => {
    ulidSeq = 0;
    const s1 = evt('USER_START_BREAK', 60, { break_kind: 'bio' });
    const e1 = evt('USER_END_BREAK', 65);
    const s2 = evt('USER_START_BREAK', 180, { break_kind: 'meal' });
    const e2 = evt('USER_END_BREAK', 240);
    const r = derivePeriods([s1, e1, s2, e2], null);
    expect(r.breaks).toHaveLength(2);
    expect(r.breaks[0]?.breakKind).toBe('bio');
    expect(r.breaks[1]?.breakKind).toBe('meal');
    expect(r.breaks[1]?.endedAt).toEqual(e2.clientTs);
  });
});

describe('derivePeriods — idles', () => {
  it('IDLE_5M → PROMPT_RESPONSE (still_working) produces one user_response idle', () => {
    ulidSeq = 0;
    const idle = evt('INPUT_IDLE_5M', 30);
    const resp = evt('USER_PROMPT_RESPONSE', 30, { response: 'still_working' });
    const r = derivePeriods([idle, resp], null);
    expect(r.idles).toHaveLength(1);
    expect(r.idles[0]?.resolution).toBe('user_response');
    expect(r.idles[0]?.response).toBe('still_working');
    expect(r.idles[0]?.sourceStartEventUlid).toBe(idle.eventUlid);
    expect(r.idles[0]?.sourceEndEventUlid).toBe(resp.eventUlid);
  });

  it('IDLE_5M → PROMPT_TIMEOUT_30S produces a timeout_close idle', () => {
    ulidSeq = 0;
    const idle = evt('INPUT_IDLE_5M', 30);
    const timeout = evt('PROMPT_TIMEOUT_30S', 31);
    const r = derivePeriods([idle, timeout], null);
    expect(r.idles).toHaveLength(1);
    expect(r.idles[0]?.resolution).toBe('timeout_close');
    expect(r.idles[0]?.response).toBeNull();
  });

  it('IDLE_5M → INPUT_ACTIVITY produces an input_dismiss idle', () => {
    ulidSeq = 0;
    const idle = evt('INPUT_IDLE_5M', 30);
    const activity = evt('INPUT_ACTIVITY', 30);
    const r = derivePeriods([idle, activity], null);
    expect(r.idles).toHaveLength(1);
    expect(r.idles[0]?.resolution).toBe('input_dismiss');
  });

  it('open idle at session close emits session_close resolution', () => {
    ulidSeq = 0;
    const idle = evt('INPUT_IDLE_5M', 30);
    const closed = t(35);
    const r = derivePeriods([idle], closed);
    expect(r.idles).toHaveLength(1);
    expect(r.idles[0]?.resolution).toBe('session_close');
    expect(r.idles[0]?.endedAt).toEqual(closed);
    expect(r.idles[0]?.sourceEndEventUlid).toBeNull();
  });
});

describe('derivePeriods — prompt response opens a break', () => {
  it('PROMPT_RESPONSE with bio_break: closes idle AND opens a bio break', () => {
    ulidSeq = 0;
    const idle = evt('INPUT_IDLE_5M', 30);
    const resp = evt('USER_PROMPT_RESPONSE', 30, { response: 'bio_break' });
    const end = evt('USER_END_BREAK', 38);
    const r = derivePeriods([idle, resp, end], null);
    expect(r.idles).toHaveLength(1);
    expect(r.idles[0]?.resolution).toBe('user_response');
    expect(r.idles[0]?.response).toBe('bio_break');
    expect(r.breaks).toHaveLength(1);
    expect(r.breaks[0]?.breakKind).toBe('bio');
    expect(r.breaks[0]?.sourceStartEventUlid).toBe(resp.eventUlid);
  });

  it('PROMPT_RESPONSE with meal_break at session close emits open-ended break', () => {
    ulidSeq = 0;
    const idle = evt('INPUT_IDLE_5M', 30);
    const resp = evt('USER_PROMPT_RESPONSE', 30, { response: 'meal_break' });
    const closed = t(90);
    const r = derivePeriods([idle, resp], closed);
    expect(r.breaks).toHaveLength(1);
    expect(r.breaks[0]?.breakKind).toBe('meal');
    expect(r.breaks[0]?.endedAt).toEqual(closed);
  });

  it('PROMPT_RESPONSE with still_working does NOT open a break', () => {
    ulidSeq = 0;
    const idle = evt('INPUT_IDLE_5M', 30);
    const resp = evt('USER_PROMPT_RESPONSE', 30, { response: 'still_working' });
    const r = derivePeriods([idle, resp], null);
    expect(r.breaks).toHaveLength(0);
  });
});

describe('derivePeriods — Alice full workday', () => {
  it('reconstructs breaks and idles from the ADR-0003 worked example', () => {
    ulidSeq = 0;
    // Alice from docs/architecture/state-machine.md:
    // 09:00 clock in → 11:10 idle prompt → 11:10:20 dismiss (input)
    // 13:00 meal break (explicit start) → 14:02 end break
    // 17:00 clock out
    const clockIn = evt('USER_CLOCK_IN', 0);
    const idle = evt('INPUT_IDLE_5M', 130);
    const dismiss = evt('INPUT_ACTIVITY', 130);
    const startMeal = evt('USER_START_BREAK', 240, { break_kind: 'meal' });
    const endMeal = evt('USER_END_BREAK', 302);
    const clockOut = evt('USER_CLOCK_OUT', 480);
    const r = derivePeriods(
      [clockIn, idle, dismiss, startMeal, endMeal, clockOut],
      clockOut.clientTs,
    );

    expect(r.breaks).toHaveLength(1);
    expect(r.breaks[0]?.breakKind).toBe('meal');
    expect(r.breaks[0]?.endedAt).toEqual(endMeal.clientTs);

    expect(r.idles).toHaveLength(1);
    expect(r.idles[0]?.resolution).toBe('input_dismiss');
    expect(r.idles[0]?.endedAt).toEqual(dismiss.clientTs);
  });
});

describe('derivePeriods — anomaly guards', () => {
  it('double START_BREAK without END emits the first as open-ended, then tracks the second', () => {
    ulidSeq = 0;
    const s1 = evt('USER_START_BREAK', 30, { break_kind: 'bio' });
    const s2 = evt('USER_START_BREAK', 90, { break_kind: 'meal' });
    const e2 = evt('USER_END_BREAK', 150);
    const r = derivePeriods([s1, s2, e2], null);
    expect(r.breaks).toHaveLength(2);
    expect(r.breaks[0]?.breakKind).toBe('bio');
    expect(r.breaks[0]?.endedAt).toBeNull();
    expect(r.breaks[1]?.breakKind).toBe('meal');
    expect(r.breaks[1]?.endedAt).toEqual(e2.clientTs);
  });

  it('double IDLE_5M without close emits the first as open-ended, then tracks the second', () => {
    ulidSeq = 0;
    const i1 = evt('INPUT_IDLE_5M', 30);
    const i2 = evt('INPUT_IDLE_5M', 45);
    const dismiss = evt('INPUT_ACTIVITY', 60);
    const r = derivePeriods([i1, i2, dismiss], null);
    expect(r.idles).toHaveLength(2);
    expect(r.idles[0]?.resolution).toBe('session_close');
    expect(r.idles[0]?.endedAt).toBeNull();
    expect(r.idles[1]?.resolution).toBe('input_dismiss');
  });
});
