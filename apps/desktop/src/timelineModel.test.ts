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

  it('totals group kinds and exclude yesterday', () => {
    const segs: Segment[] = [
      { kind: 'working', startedAt: now - 120 * MIN, endedAt: now - 60 * MIN, session: 1 },
      { kind: 'meal_break', startedAt: now - 60 * MIN, endedAt: now - 30 * MIN, session: 1 },
      { kind: 'away_phone', startedAt: now - 30 * MIN, endedAt: now - 20 * MIN, session: 1 },
      { kind: 'prompt', startedAt: now - 20 * MIN, endedAt: now - 19 * MIN, session: 1 },
      { kind: 'working', startedAt: now - 19 * MIN, endedAt: null, session: 1 },
    ];
    expect(totals(segs, now)).toEqual({
      working: 79 * MIN,
      break: 30 * MIN,
      away: 10 * MIN,
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
    expect(groupOf('away_working')).toBe('away');
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
