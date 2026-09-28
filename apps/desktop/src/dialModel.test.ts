import { describe, expect, it } from 'vitest';
import type { Segment } from './timelineModel.js';
import {
  LED_COUNT,
  WINDOW_MS,
  arcPath,
  clockAngle,
  dialArcs,
  ledBand,
  secondsLit,
  polar,
} from './dialModel.js';

const at = (h: number, m = 0): number => new Date(2026, 8, 25, h, m, 0).getTime();
const seg = (kind: Segment['kind'], from: number, to: number | null): Segment => ({
  kind,
  startedAt: from,
  endedAt: to,
  session: 1,
});

describe('clockAngle', () => {
  it('maps wall-clock time onto a 12-hour face', () => {
    expect(clockAngle(at(12))).toBe(0);
    expect(clockAngle(at(3))).toBe(90);
    expect(clockAngle(at(15))).toBe(90);
    expect(clockAngle(at(9, 30))).toBe(285);
  });
});

describe('dialArcs', () => {
  it('places each segment at its real time with a proportional sweep', () => {
    const now = at(16);
    const arcs = dialArcs(
      [
        seg('working', at(9), at(12)),
        seg('meal_break', at(12), at(13)),
        seg('working', at(13), null),
      ],
      now,
    );
    expect(arcs.map((a) => [a.kind, a.from, Math.round(a.sweep), a.open])).toEqual([
      ['working', 270, 90, false],
      ['meal_break', 0, 30, false],
      ['working', 30, 90, true],
    ]);
  });

  it('clips anything older than 12 hours and keeps slivers visible', () => {
    const now = at(20);
    const arcs = dialArcs(
      [
        seg('working', now - WINDOW_MS - 3_600_000, now - WINDOW_MS + 3_600_000),
        seg('bio_break', at(19), at(19) + 5_000),
      ],
      now,
    );
    expect(arcs[0]?.from).toBe(clockAngle(now - WINDOW_MS));
    expect(Math.round(arcs[0]?.sweep ?? 0)).toBe(30);
    expect(arcs[1]?.sweep).toBeGreaterThanOrEqual(1.2);
    expect(dialArcs([seg('working', now - 2 * WINDOW_MS, now - WINDOW_MS - 1)], now)).toEqual([]);
  });
});

describe('arc geometry', () => {
  it('starts at 12 o’clock and draws large arcs with the large-arc flag', () => {
    const [x, y] = polar(100, 100, 50, 0);
    expect([Math.round(x), Math.round(y)]).toEqual([100, 50]);
    expect(arcPath(100, 100, 50, 0, 90)).toMatch(
      /^M 100\.00 50\.00 A 50 50 0 0 1 150\.00 100\.00$/,
    );
    expect(arcPath(100, 100, 50, 0, 270)).toContain(' 0 1 1 ');
    // A full turn stays drawable.
    expect(arcPath(100, 100, 50, 0, 360)).not.toContain('NaN');
  });
});

describe('seconds ring', () => {
  it('lights one LED per second of the minute, the whole ring on the minute', () => {
    expect(secondsLit(0)).toBe(0);
    expect(secondsLit(999)).toBe(0);
    expect(secondsLit(1_000)).toBe(1);
    expect(secondsLit(59_999)).toBe(59);
    expect(secondsLit(60_000)).toBe(LED_COUNT);
    expect(secondsLit(61_000)).toBe(1);
    expect(secondsLit(3_600_000 + 30_000)).toBe(30);
    expect(secondsLit(Number.NaN)).toBe(0);
  });

  it('turns amber past 8 hours worked and red past 10', () => {
    const H = 3_600_000;
    expect([0, 7.99 * H, 8 * H, 9.99 * H, 10 * H].map(ledBand)).toEqual([
      'normal',
      'normal',
      'over',
      'over',
      'red',
    ]);
  });
});
