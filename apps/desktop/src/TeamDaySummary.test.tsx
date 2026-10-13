import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DayReportRow } from './api.js';
import { TeamScreen } from './TeamScreen.js';

const mocks = vi.hoisted(() => ({
  teamNow: vi.fn(),
  reportDay: vi.fn(),
  teamDay: vi.fn(),
  teamDays: vi.fn(),
  teamExceptions: vi.fn(),
}));
vi.mock('./api.js', () => ({ api: mocks }));

const row = (over: Partial<DayReportRow>): DayReportRow => ({
  employee_id: 'e1',
  name: 'Roshni Test',
  manager_id: 'm',
  date: '2026-10-12',
  status: 'worked',
  shift: { start: '2026-10-12T03:30:00.000Z', end: '2026-10-12T12:30:00.000Z' },
  tz: 'Asia/Kolkata',
  clock_in: '2026-10-12T03:35:00.000Z',
  clock_out: '2026-10-12T12:30:00.000Z',
  still_in: false,
  minutes_late: 5,
  worked_ms: 8 * 3_600_000,
  shift_ms: 9 * 3_600_000,
  idle_ms: 0,
  breaks_ms: 0,
  breaks_over_limit: 0,
  away_ms: 0,
  corrections_waiting: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teamNow.mockResolvedValue({ people: [] });
  mocks.teamDays.mockResolvedValue({ name: 'x', days: [] });
  mocks.teamDay.mockResolvedValue({
    date: '2026-10-13',
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
  mocks.reportDay.mockResolvedValue({
    date: '2026-10-12',
    counts: {
      worked: 1,
      late: 1,
      not_clocked_in: 1,
      not_working: 0,
      holiday: 0,
      in_office: 0,
      off: 1,
    },
    people: [
      row({
        employee_id: 'e2',
        name: 'Farheen Test',
        status: 'not_clocked_in',
        clock_in: null,
        clock_out: null,
        minutes_late: null,
        worked_ms: 0,
      }),
      row({
        employee_id: 'e3',
        name: 'Amit Test',
        status: 'late',
        clock_in: '2026-10-12T04:10:00.000Z',
        minutes_late: 40,
        corrections_waiting: 1,
      }),
      row({}),
      row({ employee_id: 'e4', name: 'Nilesh Test', status: 'off', shift: null }),
    ],
  });
});

describe('Team → Day summary (ADR-0040 §2)', () => {
  it("yesterday's team day, problems first, off on request; a name opens their days", async () => {
    const user = userEvent.setup();
    render(<TeamScreen />);
    await user.click(screen.getByRole('tab', { name: 'Day summary' }));
    const list = await screen.findByRole('list', { name: 'day-summary' });
    expect(mocks.reportDay).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(screen.getByLabelText('summary-headline')).toHaveTextContent(
      '1 not clocked in · 1 late · 1 worked',
    );
    const items = within(list).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual([
      'Farheen TestNot clocked in',
      'Amit TestLate · 09:40 (+40m)–18:00 · 1 correction waiting8h 00m / 9h 00m',
      'Roshni TestWorked · 09:05 (+5m)–18:008h 00m / 9h 00m',
    ]);
    await user.click(screen.getByRole('button', { name: 'Show the 1 off that day' }));
    expect(within(list).getAllByRole('button')).toHaveLength(4);
    await user.click(within(list).getByRole('button', { name: /^Amit Test/ }));
    expect(screen.getByRole('heading', { name: 'Amit Test' })).toBeInTheDocument();
  });
});
