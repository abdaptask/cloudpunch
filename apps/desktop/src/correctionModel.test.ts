import { describe, expect, it } from 'vitest';
import type { DayCorrection } from './api.js';
import {
  correctionErrorText,
  correctionSpan,
  offsetAt,
  spanText,
  statusText,
  zoneChoices,
  zonedIso,
} from './correctionModel.js';

describe('zone maths', () => {
  it('knows IST and US Eastern, with daylight saving', () => {
    expect(offsetAt(Date.parse('2026-10-05T12:00:00Z'), 'Asia/Kolkata')).toBe(330);
    expect(offsetAt(Date.parse('2026-10-05T12:00:00Z'), 'America/New_York')).toBe(-240);
    expect(offsetAt(Date.parse('2026-12-05T12:00:00Z'), 'America/New_York')).toBe(-300);
  });

  it('writes a wall time with its offset', () => {
    expect(zonedIso('2026-10-05', '17:30', 'Asia/Kolkata')).toBe('2026-10-05T17:30:00+05:30');
    expect(zonedIso('2026-10-05', '08:00', 'America/New_York')).toBe('2026-10-05T08:00:00-04:00');
    // The morning after US clocks go back (1 Nov 2026).
    expect(zonedIso('2026-11-01', '09:00', 'America/New_York')).toBe('2026-11-01T09:00:00-05:00');
  });

  it('an end before the start is the next morning', () => {
    expect(correctionSpan('2026-10-05', '17:30', '01:30', 'Asia/Kolkata')).toEqual({
      from: '2026-10-05T17:30:00+05:30',
      to: '2026-10-06T01:30:00+05:30',
    });
    expect(correctionSpan('2026-10-05', '09:00', '17:00', 'Asia/Kolkata').to).toBe(
      '2026-10-05T17:00:00+05:30',
    );
  });
});

const c = (over: Partial<DayCorrection>): DayCorrection => ({
  id: 'c1',
  from: '2026-10-05T17:30:00.000+05:30',
  to: '2026-10-06T01:30:00.000+05:30',
  kind: 'working',
  reason: 'not recorded',
  status: 'requested',
  requested_by: 'Abdulla Sheikh',
  requested_at: '2026-10-07T12:00:00Z',
  decisions: [],
  ...over,
});

describe('words', () => {
  it('shows the span in the recorded zone', () => {
    expect(spanText(c({}))).toBe('17:30–01:30 (next day)');
  });

  it('says where a correction stands', () => {
    expect(statusText(c({}))).toBe('Waiting for the manager');
    expect(statusText(c({ status: 'endorsed' }))).toBe("Waiting for an Administrator's approval");
    expect(
      statusText(
        c({
          status: 'approved',
          decisions: [{ decision: 'approved', by: 'Nilesh Darekar', at: 'x', note: null }],
        }),
      ),
    ).toBe('Approved by Nilesh Darekar');
  });

  it('offers this computer first when it is another zone', () => {
    expect(zoneChoices('Asia/Kolkata').map((z) => z.tz)).toEqual([
      'Asia/Kolkata',
      'America/New_York',
    ]);
    expect(zoneChoices('Europe/London')[0]?.label).toBe('This computer (Europe/London)');
  });

  it('turns server codes into plain words', () => {
    expect(correctionErrorText('too_long')).toMatch(/16 hours/);
    expect(correctionErrorText('weird')).toBe('Something went wrong (weird).');
  });
});
