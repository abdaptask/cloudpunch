import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DayReportRow } from '../api.js';
import { endText, headline, hours, shiftText, startText, workedText } from './dayReportModel.js';
import { ReportsPage } from './ReportsPage.js';

const mocks = vi.hoisted(() => ({ reportDay: vi.fn(), teamDay: vi.fn() }));
vi.mock('../api.js', () => ({ api: mocks }));

const row = (over: Partial<DayReportRow>): DayReportRow => ({
  employee_id: 'e1',
  name: 'Roshni Test',
  manager_id: null,
  date: '2026-10-12',
  status: 'worked',
  shift: { start: '2026-10-12T03:30:00.000Z', end: '2026-10-12T12:30:00.000Z' },
  tz: 'Asia/Kolkata',
  clock_in: '2026-10-12T04:10:00.000Z',
  clock_out: '2026-10-12T12:30:00.000Z',
  still_in: false,
  minutes_late: 40,
  worked_ms: 8 * 3_600_000,
  shift_ms: 9 * 3_600_000,
  idle_ms: 0,
  breaks_ms: 20 * 60_000,
  breaks_over_limit: 0,
  away_ms: 0,
  corrections_waiting: 0,
  ...over,
});

const counts = {
  worked: 0,
  late: 1,
  not_clocked_in: 1,
  not_working: 0,
  holiday: 0,
  in_office: 0,
  off: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reportDay.mockResolvedValue({
    date: '2026-10-12',
    counts,
    people: [
      row({
        employee_id: 'e2',
        name: 'Farheen Test',
        status: 'not_clocked_in',
        clock_in: null,
        clock_out: null,
        minutes_late: null,
        worked_ms: 0,
        breaks_ms: 0,
      }),
      row({ status: 'late', breaks_over_limit: 1, corrections_waiting: 1 }),
      row({ employee_id: 'e3', name: 'Nilesh Test', status: 'off', shift: null }),
    ],
  });
  mocks.teamDay.mockResolvedValue({
    date: '2026-10-12',
    sessions: [],
    corrections: [],
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
  });
});

describe('day summary words (ADR-0040)', () => {
  it('times on the shift clock, lateness, hours against the shift', () => {
    const r = row({ status: 'late' });
    expect(shiftText(r)).toBe('09:00–18:00');
    expect(startText(r)).toBe('09:40 (+40m)');
    expect(endText(r)).toBe('18:00');
    expect(endText({ ...r, still_in: true })).toBe('Still in');
    expect(workedText(r)).toBe('8h 00m / 9h 00m');
    expect(workedText({ ...r, shift_ms: 0 })).toBe('8h 00m');
    expect(hours(0)).toBe('—');
    expect(headline(counts)).toBe('1 not clocked in · 1 late');
    expect(headline({ ...counts, late: 0, not_clocked_in: 0 })).toBe('Nobody had a shift');
  });
});

describe('Reports → Day summary (ADR-0040 §2)', () => {
  it('yesterday by default, problems first, "off" hidden until asked for; a click opens the day', async () => {
    const user = userEvent.setup();
    render(<ReportsPage canOpenDays />);
    const table = await screen.findByRole('table', { name: 'day-report' });
    expect(mocks.reportDay).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('report-headline')).toHaveTextContent('1 not clocked in · 1 late');
    const names = () =>
      within(screen.getByRole('table', { name: 'day-report' }))
        .getAllByRole('row')
        .slice(1)
        .map((r) => within(r).getAllByRole('cell')[0]?.textContent);
    expect(names()).toEqual(['Farheen Test', 'Roshni Test']);
    expect(within(table).getByText('09:40 (+40m)')).toBeTruthy();
    expect(within(table).getByText('1 waiting')).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('filter-status'), 'off');
    expect(names()).toEqual(['Nilesh Test']);
    await user.selectOptions(screen.getByLabelText('filter-status'), 'problems');
    expect(names()).toEqual(['Farheen Test', 'Roshni Test']);

    await user.click(screen.getByText('Roshni Test'));
    expect(await screen.findByLabelText('report-person-day')).toBeTruthy();
    expect(mocks.teamDay).toHaveBeenCalledWith('e1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('a refusal shows in words', async () => {
    mocks.reportDay.mockRejectedValue('forbidden');
    render(<ReportsPage canOpenDays={false} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Your role can't see reports.");
  });
});
