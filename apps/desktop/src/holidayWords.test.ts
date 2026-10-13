import { describe, expect, it } from 'vitest';
import { holidayDateText } from './admin/holidayPaste.js';
import { startsText, statusText } from './teamModel.js';

describe('holiday words', () => {
  it('shows the day of the date itself, in any zone', () => {
    expect(holidayDateText('2026-11-09')).toBe('Mon, 9 Nov 2026');
  });

  it('Team says whose shift is a holiday', () => {
    const p = {
      employee_id: 'e1',
      name: 'Roshni Sahani',
      status: 'holiday' as const,
      kind: null,
      since: null,
      back_by: null,
      worked_ms: 0,
      holiday: 'Diwali',
    };
    expect(statusText(p)).toBe('Holiday: Diwali');
  });

  it('Team says how often someone missed the start (ADR-0037 §4)', () => {
    const p = {
      employee_id: 'e1',
      name: 'Roshni Sahani',
      status: 'clocked_out' as const,
      kind: null,
      since: null,
      back_by: null,
      worked_ms: 0,
    };
    expect(startsText(p)).toBeNull();
    expect(
      startsText({ ...p, starts: { missed: 4, not_working: 1, days: 30, regular: true } }),
    ).toBe('Missed starts: 4 in 30 days · Not working today: 1');
    expect(
      startsText({ ...p, starts: { missed: 1, not_working: 0, days: 30, regular: false } }),
    ).toBe('Missed starts: 1 in 30 days');
  });
});
