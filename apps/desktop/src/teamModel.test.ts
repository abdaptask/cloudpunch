import { describe, expect, it } from 'vitest';
import type { TeamDay, TeamException, TeamPerson } from './api.js';
import { dayRows, exceptionText, hm, overdue, statusText } from './teamModel.js';
import { formatClock } from './timelineModel.js';

const at = (h: number, m: number): string => new Date(2026, 8, 29, h, m).toISOString();
const person = (over: Partial<TeamPerson>): TeamPerson => ({
  employee_id: 'e',
  name: 'Farheen Test',
  status: 'working',
  kind: 'working',
  since: at(9, 2),
  back_by: null,
  worked_ms: 0,
  ...over,
});

describe('Team today wording (ADR-0025)', () => {
  it('says what each person is doing', () => {
    expect(statusText(person({}))).toBe(`Working since ${formatClock(Date.parse(at(9, 2)))}`);
    expect(
      statusText(
        person({
          status: 'on_break',
          kind: 'personal_break',
          since: at(10, 25),
          back_by: at(10, 45),
        }),
      ),
    ).toBe(`Personal · back by ${formatClock(Date.parse(at(10, 45)))}`);
    expect(statusText(person({ status: 'away', kind: 'away_training' }))).toMatch(
      /^Training since/,
    );
    expect(statusText(person({ status: 'clocked_out', kind: null, since: null }))).toBe(
      'Not clocked in',
    );
    expect(statusText(person({ status: 'clocked_out', kind: null }))).toMatch(/^Clocked out at/);
  });

  it('flags a break past its back-by time', () => {
    const p = person({ status: 'on_break', kind: 'rest_break', back_by: at(10, 45) });
    expect(overdue(p, Date.parse(at(10, 44)))).toBe(false);
    expect(overdue(p, Date.parse(at(10, 46)))).toBe(true);
    expect(overdue(person({}), Date.parse(at(23, 0)))).toBe(false);
  });

  it('formats minutes', () => {
    expect(hm(20)).toBe('20 min');
    expect(hm(72)).toBe('1h 12m');
  });
});

describe('exceptions wording', () => {
  const base: TeamException = {
    employee_id: 'e',
    name: 'Farheen Test',
    date: '2026-09-29',
    kind: 'break_over_planned',
    at: at(11, 0),
    minutes: 35,
    over_minutes: 15,
    segment: 'personal_break',
    explanation: null,
  };
  it('breaks over plan and limit, idle with what they said, long shifts', () => {
    expect(exceptionText(base).text).toBe('Personal 35 min · planned 20 min (+15 min)');
    expect(exceptionText({ ...base, kind: 'break_over_limit', over_minutes: 5 }).text).toBe(
      'Personal 35 min · limit 30 min (+5 min)',
    );
    const idle = exceptionText({
      ...base,
      kind: 'long_idle',
      minutes: 22,
      over_minutes: null,
      segment: 'idle',
      explanation: { explanation: 'meeting', note: 'standup' },
    });
    expect(idle.text).toMatch(/^Idle 22 min from/);
    expect(idle.said).toBe('Said: In a meeting · “standup”');
    expect(
      exceptionText({ ...base, kind: 'long_idle', explanation: null, over_minutes: null }).said,
    ).toBe('No explanation given');
    expect(
      exceptionText({ ...base, kind: 'long_shift', minutes: 612, over_minutes: 72, segment: null })
        .text,
    ).toBe('Worked 10h 12m (1h 12m over the long-shift mark)');
  });
});

describe('a team member day as rows', () => {
  it('shows planned vs taken and the idle account', () => {
    const day: TeamDay = {
      name: 'Farheen Test',
      date: '2026-09-29',
      sessions: [
        {
          session_id: 's',
          device_id: 'd',
          tz_iana: 'Asia/Kolkata',
          clock_in: '2026-09-29T09:00:00.000+05:30',
          clock_out: null,
          close_reason: null,
          reconstructed: false,
          open: true,
          started_from_sign_in: false,
          segments: [
            {
              kind: 'personal_break',
              started_at: '2026-09-29T10:00:00.000+05:30',
              ended_at: '2026-09-29T10:24:00.000+05:30',
              planned_minutes: 20,
            },
            {
              kind: 'idle',
              started_at: '2026-09-29T11:00:00.000+05:30',
              ended_at: '2026-09-29T11:20:00.000+05:30',
            },
          ],
        },
      ],
      totals: {
        worked_ms: 0,
        calls_ms: 0,
        meetings_ms: 0,
        breaks_ms: 0,
        paid_break_ms: 0,
        unpaid_break_ms: 0,
        prompt_ms: 0,
        idle_ms: 0,
      },
    };
    const rows = dayRows(day);
    expect(rows[0]).toMatchObject({
      label: 'Personal',
      detail: 'Planned 20 min · took 24 min',
      late: true,
    });
    expect(new Date(rows[0]?.from ?? 0).getHours()).toBe(10); // the employee's clock
    expect(rows[1]).toMatchObject({ label: 'Idle', detail: 'No explanation given', late: false });
  });
});

describe('presence checks in the Team views (ADR-0024)', () => {
  it('says whether it was answered', () => {
    const base: TeamException = {
      employee_id: 'e',
      name: 'Farheen Test',
      date: '2026-09-29',
      kind: 'presence_check',
      at: new Date(2026, 8, 29, 11, 0).toISOString(),
      minutes: null,
      over_minutes: null,
      segment: 'prompt',
      explanation: null,
      pattern: 'periodic',
      answered: true,
    };
    expect(exceptionText(base).text).toMatch(
      /Presence check at .* \(input in a fixed rhythm\): answered/,
    );
    expect(
      exceptionText({
        ...base,
        pattern: 'continuous',
        answered: false,
        minutes: 25,
        segment: 'idle',
      }).text,
    ).toMatch(/^Presence check \(non-stop input with no pauses\): not answered · idle 25 min/);
  });
});

describe('long aways (ADR-0027)', () => {
  it('says how long and how it ended', () => {
    const e: TeamException = {
      employee_id: 'e',
      name: 'Roshni Test',
      date: '2026-09-29',
      kind: 'long_away',
      at: new Date(2026, 8, 29, 21, 35).toISOString(),
      minutes: 126,
      over_minutes: null,
      segment: 'away_phone',
      explanation: null,
      ended_by: 'input',
    };
    expect(exceptionText(e).text).toMatch(
      /^On a phone call 2h 06m from .* · ended when they were back at the computer$/,
    );
  });
});
