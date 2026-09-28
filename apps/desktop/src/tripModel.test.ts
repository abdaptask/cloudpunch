import { describe, expect, it } from 'vitest';
import type { Segment } from './timelineModel.js';
import { odometer, tripLine, tripSummary } from './tripModel.js';

const H = 3_600_000;
const at = (h: number, m = 0): number => new Date(2026, 8, 28, h, m).getTime();
const seg = (kind: Segment['kind'], from: number, to: number): Segment => ({
  kind,
  startedAt: from,
  endedAt: to,
  session: 1,
});

describe('end-of-day summary', () => {
  const day = [
    seg('working', at(9), at(12)),
    seg('bio_break', at(12), at(12, 10)),
    seg('call_zoom', at(12, 10), at(13)),
    seg('meal_break', at(13), at(13, 45)),
    seg('call_teams', at(13, 45), at(14, 30)),
    seg('working', at(14, 30), at(18, 12)),
  ];

  it('totals the day and counts calls and breaks', () => {
    const s = tripSummary(day, at(18, 12), at(0), 8 * H);
    expect(s).toEqual({
      worked: 8 * H + 17 * 60_000,
      calls: 2,
      breaks: 2,
      breakMs: 55 * 60_000,
      idleMs: 0,
      long: true,
    });
    expect(tripLine(s)).toBe('8h 17m worked · 55m breaks · 2 calls');
  });

  it('a short day is not long; zero counts are left out', () => {
    const s = tripSummary([seg('working', at(9), at(12))], at(12), at(0), 8 * H);
    expect(s.long).toBe(false);
    expect(tripLine(s)).toBe('3h 00m worked');
    expect(
      tripLine({
        worked: 45 * 60_000,
        calls: 1,
        breaks: 1,
        breakMs: 10 * 60_000,
        idleMs: 0,
        long: false,
      }),
    ).toBe('45m worked · 10m break · 1 call');
  });

  it('shows the odometer as HH:MM', () => {
    expect(odometer(0)).toBe('00:00');
    expect(odometer(8 * H + 12 * 60_000)).toBe('08:12');
    expect(odometer(150 * H)).toBe('99:00');
  });
});
