import { describe, expect, it } from 'vitest';
import { parseHolidayList } from './holidayPaste.js';

const TODAY = '2026-10-12';
const existing = [
  { date: '2026-10-20', name: 'Diwali' },
  { date: '2026-12-25', name: 'Christmas' },
];

describe('pasting a holiday list (ADR-0038 §9)', () => {
  it('reads the usual ways of writing a date, with the next year when none is given', () => {
    const lines = parseHolidayList(
      [
        '26 Jan, Republic Day',
        '15 August 2027 - Independence Day',
        '2026-11-15 Bhai Dooj',
        'Oct 2: Gandhi Jayanti',
        '',
        '1st Nov Kannada Rajyotsava',
      ].join('\n'),
      existing,
      TODAY,
    );
    expect(lines.map((l) => (l.status === 'invalid' ? l.why : [l.date, l.name, l.status]))).toEqual(
      [
        ['2027-01-26', 'Republic Day', 'new'],
        ['2027-08-15', 'Independence Day', 'new'],
        ['2026-11-15', 'Bhai Dooj', 'new'],
        // 2 Oct 2026 has passed: next year's.
        ['2027-10-02', 'Gandhi Jayanti', 'new'],
        ['2026-11-01', 'Kannada Rajyotsava', 'new'],
      ],
    );
    // Blank lines are skipped but line numbers stay true.
    expect(lines.at(-1)?.line).toBe(6);
  });

  it('says what it would rename or leave as it is', () => {
    const lines = parseHolidayList('20 Oct, Deepavali\n25 Dec Christmas', existing, TODAY);
    expect(lines).toEqual([
      expect.objectContaining({ date: '2026-10-20', status: 'rename', was: 'Diwali' }),
      expect.objectContaining({ date: '2026-12-25', status: 'same' }),
    ]);
  });

  it('explains lines it cannot read', () => {
    const lines = parseHolidayList(
      'Republic Day\n31 Feb, Nonsense\n26 Jan\n26 Jan, Again\n26 Jan, Twice\n',
      existing,
      TODAY,
    );
    expect(lines.map((l) => (l.status === 'invalid' ? l.why : l.status))).toEqual([
      'No date at the start',
      'Not a real date',
      'No name after the date',
      'new',
      'Same date as line 4',
    ]);
  });
});
