import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  sessionsToday,
  totalsByKind,
  formatTimer,
  groupOf,
  startOfLocalDay,
  today,
  totals,
  type Segment,
  workingDayStart,
} from './timelineModel.js';

const MIN = 60_000;
// A fixed local afternoon so midnight clipping is deterministic.
const now = new Date(2026, 8, 24, 15, 0, 0).getTime();
const midnight = startOfLocalDay(now);

describe('timelineModel', () => {
  it('startOfLocalDay is local midnight', () => {
    const d = new Date(midnight);
    expect([d.getHours(), d.getMinutes(), d.getDate()]).toEqual([0, 0, 24]);
  });

  it('closes open segments at now and clips to midnight', () => {
    const segs: Segment[] = [
      {
        kind: 'working',
        startedAt: midnight - 120 * MIN,
        endedAt: midnight - 60 * MIN,
        session: 1,
      },
      { kind: 'working', startedAt: midnight - 30 * MIN, endedAt: midnight + 30 * MIN, session: 1 },
      { kind: 'bio_break', startedAt: now - 5 * MIN, endedAt: null, session: 1 },
    ];
    const rows = today(segs, now);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      startedAt: midnight,
      endedAt: midnight + 30 * MIN,
      session: 1,
    });
    expect(rows[1]!.endedAt).toBe(now);
  });

  it('totals count calls, meetings and phone calls as working', () => {
    const segs: Segment[] = [
      { kind: 'working', startedAt: now - 120 * MIN, endedAt: now - 60 * MIN, session: 1 },
      { kind: 'meal_break', startedAt: now - 60 * MIN, endedAt: now - 30 * MIN, session: 1 },
      { kind: 'away_phone', startedAt: now - 30 * MIN, endedAt: now - 20 * MIN, session: 1 },
      { kind: 'prompt', startedAt: now - 20 * MIN, endedAt: now - 19 * MIN, session: 1 },
      { kind: 'working', startedAt: now - 19 * MIN, endedAt: null, session: 1 },
    ];
    expect(totals(segs, now)).toEqual({
      working: 89 * MIN,
      break: 30 * MIN,
      prompt: 1 * MIN,
    });
  });

  it('totalsByKind keeps kinds separate and omits empty ones', () => {
    const segs: Segment[] = [
      { kind: 'working', startedAt: now - 30 * MIN, endedAt: now - 20 * MIN, session: 1 },
      { kind: 'bio_break', startedAt: now - 20 * MIN, endedAt: now - 15 * MIN, session: 1 },
      { kind: 'working', startedAt: now - 15 * MIN, endedAt: null, session: 1 },
    ];
    expect(totalsByKind(segs, now)).toEqual({ working: 25 * MIN, bio_break: 5 * MIN });
  });

  it('sessionsToday groups by clock-in and marks the open one', () => {
    const segs: Segment[] = [
      { kind: 'working', startedAt: now - 120 * MIN, endedAt: now - 90 * MIN, session: 1 },
      { kind: 'bio_break', startedAt: now - 90 * MIN, endedAt: now - 80 * MIN, session: 1 },
      { kind: 'working', startedAt: now - 30 * MIN, endedAt: null, session: 2 },
    ];
    const groups = sessionsToday(segs, now);
    expect(groups.map((g) => [g.session, g.rows.length, g.open])).toEqual([
      [1, 2, false],
      [2, 1, true],
    ]);
    expect(groups[0]).toMatchObject({ startedAt: now - 120 * MIN, endedAt: now - 80 * MIN });
    expect(groups[1]!.endedAt).toBe(now);
  });

  it('groups', () => {
    expect(groupOf('other_break')).toBe('break');
    expect(groupOf('away_working')).toBe('working');
    expect(groupOf('away_meeting')).toBe('working');
    expect(groupOf('call_teams')).toBe('working');
  });

  it('formats durations and timers', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(42_900)).toBe('42s');
    expect(formatDuration(12 * MIN + 4_000)).toBe('12m 04s');
    expect(formatDuration(65 * MIN + 12_000)).toBe('1h 05m 12s');
    expect(formatDuration(-1)).toBe('0s');
    expect(formatTimer(3_723_000)).toBe('01:02:03');
    expect(formatTimer(-5)).toBe('00:00:00');
  });
});

describe('workingDayStart (ADR-0016 §1)', () => {
  const at = (day: number, h: number, m = 0): number => new Date(2026, 8, day, h, m).getTime();
  const seg = (from: number, to: number | null, session: number): Segment => ({
    kind: 'working',
    startedAt: from,
    endedAt: to,
    session,
  });

  it('a night shift across midnight is one day, until 6 hours after clocking out', () => {
    const night = [seg(at(25, 18, 30), at(25, 23, 30), 1), seg(at(26, 0, 15), at(26, 3, 30), 2)];
    expect(workingDayStart(night, at(26, 1))).toBe(at(25, 18, 30));
    expect(workingDayStart(night, at(26, 9, 29))).toBe(at(25, 18, 30));
    expect(workingDayStart(night, at(26, 9, 31))).toBeNull();
    // Totals for "today" at 04:00 include the evening before midnight.
    const since = workingDayStart(night, at(26, 4)) ?? 0;
    expect(totals(night, at(26, 4), since).working).toBe(8 * 3_600_000 + 15 * 60_000);
  });

  it('an open session is always today; nothing tracked is null', () => {
    expect(workingDayStart([seg(at(25, 9), null, 1)], at(25, 23))).toBe(at(25, 9));
    expect(workingDayStart([], at(25, 9))).toBeNull();
  });

  it('a gap over 6 hours starts a new day', () => {
    const segs = [seg(at(25, 8), at(25, 10), 1), seg(at(25, 16, 1), null, 2)];
    expect(workingDayStart(segs, at(25, 17))).toBe(at(25, 16, 1));
  });
});
