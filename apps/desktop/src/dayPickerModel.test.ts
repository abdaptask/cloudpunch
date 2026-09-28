import { describe, expect, it } from 'vitest';
import {
  cellReadout,
  cellTooltip,
  heatLevel,
  lookbackSummary,
  pickerRange,
  pickerWeeks,
  rangeTitle,
  type DaySummary,
} from './dayPickerModel.js';

const H = 3_600_000;

function summary(date: string, hours: number): DaySummary {
  return {
    date,
    sessions: 1,
    worked_ms: hours * H,
    calls_ms: 0,
    meetings_ms: 0,
    breaks_ms: 0,
    prompt_ms: 0,
  };
}

describe('day picker model', () => {
  it('covers today and the previous 30 days in Monday-first weeks', () => {
    // Mon 28 Sep 2026: the range starts Sat 29 Aug.
    expect(pickerRange('2026-09-28')).toEqual({ from: '2026-08-29', to: '2026-09-28' });
    const weeks = pickerWeeks('2026-09-28', [summary('2026-09-25', 8)]);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0]?.[0]?.date).toBe('2026-08-24');
    const inside = weeks.flat().filter((c) => !c.outside);
    expect(inside).toHaveLength(31);
    expect(inside[0]?.date).toBe('2026-08-29');
    expect(inside.at(-1)?.date).toBe('2026-09-28');
    // Today is a Monday: the last row is that week, the rest are gaps.
    expect(
      weeks
        .at(-1)
        ?.filter((c) => !c.outside)
        .map((c) => c.date),
    ).toEqual(['2026-09-28']);
    expect(inside.find((c) => c.date === '2026-09-25')?.summary?.worked_ms).toBe(8 * H);
    expect(inside.find((c) => c.date === '2026-09-24')?.summary).toBeNull();
  });

  it('a Sunday today ends a full week', () => {
    const weeks = pickerWeeks('2026-09-27', []);
    expect(weeks.at(-1)?.at(-1)).toMatchObject({ date: '2026-09-27', outside: false });
  });

  it('shades by hours worked', () => {
    expect([0, 1, 2, 4.9, 5, 7.99, 8, 12].map((h) => heatLevel(h * H))).toEqual([
      0, 1, 2, 2, 3, 3, 4, 4,
    ]);
  });

  it('reads a cell and sums the look-back', () => {
    const [cell] = pickerWeeks('2026-09-28', [summary('2026-09-22', 8 + 12 / 60 + 1e-9)])
      .flat()
      .filter((c) => c.date === '2026-09-22');
    expect(cellReadout(cell!, '2026-09-28')).toBe('Tue 22 Sep · 8h 12m');
    const empty = pickerWeeks('2026-09-28', [])
      .flat()
      .find((c) => c.date === '2026-09-27')!;
    expect(cellReadout(empty, '2026-09-28')).toBe('Yesterday · Nothing tracked');
    expect(lookbackSummary([])).toBe('Nothing tracked in the last 30 days');
    expect(
      lookbackSummary([
        summary('2026-09-22', 8),
        summary('2026-09-23', 0),
        summary('2026-09-24', 6),
      ]),
    ).toBe('2 days · 14h 00m · avg 7h 00m');
  });

  it('titles the range, across a year end too', () => {
    expect(rangeTitle('2026-09-28')).toBe('Aug – Sep 2026');
    expect(rangeTitle('2026-01-10')).toBe('Dec 2025 – Jan 2026');
    expect(rangeTitle('2026-03-31')).toBe('Mar 2026');
  });

  it('builds the hover card', () => {
    const cells = pickerWeeks('2026-09-28', [
      { ...summary('2026-09-22', 8), sessions: 2, breaks_ms: 45 * 60_000, calls_ms: 70 * 60_000 },
    ]).flat();
    const day = cells.find((c) => c.date === '2026-09-22')!;
    expect(cellTooltip(day, '2026-09-28', true)).toEqual({
      title: 'Tue 22 Sep',
      worked: '8h 00m worked',
      detail: '2 sessions · 45m breaks · 1h 10m calls',
    });
    const empty = cells.find((c) => c.date === '2026-09-23')!;
    expect(cellTooltip(empty, '2026-09-28', true)).toMatchObject({ worked: 'Nothing tracked' });
    expect(cellTooltip(day, '2026-09-28', false)).toMatchObject({
      worked: 'Hours unavailable offline',
      detail: null,
    });
  });
});
