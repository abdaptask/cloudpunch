import { describe, expect, it } from 'vitest';
import type { OfficeDay, OfficePattern } from '../db/index.js';
import { inOffice, weekdaysOn } from './model.js';

const pattern = (weekdays: number[], effectiveFrom: string, at = '2026-10-01'): OfficePattern => ({
  employeeId: 'e',
  weekdays,
  effectiveFrom,
  reason: null,
  setByUserId: 'u',
  setAt: new Date(`${at}T00:00:00Z`),
});
const day = (date: string, on: boolean, at: string): OfficeDay => ({
  employeeId: 'e',
  date,
  inOffice: on,
  reason: null,
  setByUserId: 'u',
  setAt: new Date(at),
});

describe('in-office days (ADR-0039 §1)', () => {
  // 2026-10-13 is a Tuesday, 2026-10-15 a Thursday.
  const tueThu = [pattern([2, 4], '2026-10-01')];

  it('usual weekdays in force on the date', () => {
    expect(inOffice(tueThu, [], '2026-10-13')).toBe(true);
    expect(inOffice(tueThu, [], '2026-10-14')).toBe(false);
    expect(inOffice(tueThu, [], '2026-09-29')).toBe(false); // before it started
    const changed = [...tueThu, pattern([3], '2026-10-20', '2026-10-10')];
    expect(inOffice(changed, [], '2026-10-20')).toBe(false);
    expect(inOffice(changed, [], '2026-10-21')).toBe(true);
    expect(weekdaysOn(changed, '2026-10-25')).toEqual([3]);
  });

  it('a one-off wins, and the latest one-off for a date wins', () => {
    expect(inOffice(tueThu, [day('2026-10-13', false, '2026-10-12T10:00:00Z')], '2026-10-13')).toBe(
      false,
    );
    expect(inOffice([], [day('2026-10-14', true, '2026-10-12T10:00:00Z')], '2026-10-14')).toBe(
      true,
    );
    const twice = [
      day('2026-10-14', true, '2026-10-12T10:00:00Z'),
      day('2026-10-14', false, '2026-10-12T11:00:00Z'),
    ];
    expect(inOffice([], twice, '2026-10-14')).toBe(false);
  });
});
