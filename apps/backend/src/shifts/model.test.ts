import { describe, expect, it } from 'vitest';
import type { ShiftAssignment } from '../db/index.js';
import { activeWindow, isoWeekday, shiftOn, wallToUtc, windowOn } from './model.js';

const row = (over: Partial<ShiftAssignment> = {}): ShiftAssignment => ({
  id: 'r',
  employeeId: 'e',
  days: [1, 2, 3, 4, 5],
  start: '08:00',
  end: '17:00',
  tzIana: 'America/New_York',
  effectiveFrom: '2026-10-01',
  reason: null,
  assignedByUserId: 'u',
  assignedAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
});

describe('shift model (ADR-0031)', () => {
  it('weekdays and wall times in the shift zone', () => {
    expect(isoWeekday('2026-10-05')).toBe(1);
    expect(isoWeekday('2026-10-11')).toBe(7);
    expect(wallToUtc('2026-10-05', '08:00', 'America/New_York').toISOString()).toBe(
      '2026-10-05T12:00:00.000Z',
    );
    expect(wallToUtc('2026-12-07', '08:00', 'America/New_York').toISOString()).toBe(
      '2026-12-07T13:00:00.000Z',
    );
    expect(wallToUtc('2026-10-05', '12:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-05T06:30:00.000Z',
    );
  });

  it('the latest row on or before a date applies; an empty one means no shift', () => {
    const rows = [
      row({ id: 'clear', days: [], start: null, end: null, effectiveFrom: '2026-10-20' }),
      row({ id: 'new', start: '09:00', effectiveFrom: '2026-10-10' }),
      row({ id: 'old' }),
    ];
    expect(shiftOn(rows, '2026-10-05')?.id).toBe('old');
    expect(shiftOn(rows, '2026-10-12')?.id).toBe('new');
    expect(shiftOn(rows, '2026-10-21')).toBeNull();
    expect(shiftOn(rows, '2026-09-30')).toBeNull();
  });

  it('a window opens at the start, in its zone, only on shift days', () => {
    const rows = [row()];
    expect(activeWindow(rows, new Date('2026-10-05T11:59:00Z'))).toBeNull();
    const w = activeWindow(rows, new Date('2026-10-05T12:00:00Z'));
    expect(w?.date).toBe('2026-10-05');
    expect(w?.end.toISOString()).toBe('2026-10-05T21:00:00.000Z');
    // Saturday: no shift.
    expect(activeWindow(rows, new Date('2026-10-10T14:00:00Z'))).toBeNull();
  });

  it('an overnight shift belongs to the day it started', () => {
    const rows = [row({ start: '17:30', end: '02:30', tzIana: 'Asia/Kolkata' })];
    // Tue 6 Oct 01:00 IST: still Monday's shift.
    const w = activeWindow(rows, new Date('2026-10-05T19:30:00Z'));
    expect(w?.date).toBe('2026-10-05');
    expect(windowOn(rows, '2026-10-05')?.end.toISOString()).toBe('2026-10-05T21:00:00.000Z');
    // Sat 10 Oct 01:00 IST: Friday's shift, even though Saturday isn't a shift day.
    expect(activeWindow(rows, new Date('2026-10-09T19:30:00Z'))?.date).toBe('2026-10-09');
  });
});
