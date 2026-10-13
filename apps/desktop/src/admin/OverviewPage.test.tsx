import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Overview, OverviewPerson } from '../api.js';
import { csvName, csvOf, hrs, rangeIssue, rangeOf, refusalText } from './overviewModel.js';
import { Reports } from './ReportsPage.js';

const mocks = vi.hoisted(() => ({
  reportDay: vi.fn(),
  reportOverview: vi.fn(),
  saveCsv: vi.fn(),
  teamDay: vi.fn(),
}));
vi.mock('../api.js', () => ({ api: mocks }));

const H = 3_600_000;

const person = (name: string, over: Partial<OverviewPerson> = {}): OverviewPerson => ({
  employee_id: `id-${name}`,
  name,
  days_worked: 4,
  shift_days: 5,
  shift_days_worked: 4,
  attendance: 0.8,
  worked_ms: 32 * H,
  scheduled_ms: 45 * H,
  late_starts: 2,
  avg_minutes_late: 25,
  missed_starts: 1,
  idle_ms: 2 * H,
  idle_share: 2 / 34,
  breaks_ms: 2 * H,
  break_ms_per_day: 30 * 60_000,
  breaks_over_limit: 1,
  away_ms: H,
  ...over,
});

const OVERVIEW: Overview = {
  from: '2026-10-05',
  to: '2026-10-11',
  totals: { people: 2, ...person('x'), attendance: 0.9, shift_days: 10, shift_days_worked: 9 },
  people: [person('Roshni Test'), person('=Farheen', { attendance: 1, missed_starts: 0 })],
  weeks: [
    {
      week: '2026-10-05',
      shift_days: 10,
      shift_days_worked: 9,
      late_starts: 2,
      missed_starts: 1,
      worked_ms: 64 * H,
      idle_ms: 4 * H,
    },
  ],
  health: {
    active_people: 3,
    with_app: 2,
    clocked_in: 2,
    never_clocked_in: [{ employee_id: 'n', name: 'Nilesh Test' }],
    versions: [
      { version: '0.1.36', computers: 3 },
      { version: '0.1.27', computers: 1 },
    ],
    newest_version: '0.1.36',
    computers_behind: 1,
    corrections_waiting: 2,
    refused: [
      {
        employee_id: 'e-m',
        name: 'Masrat Afzal',
        os: 'windows',
        reason: 'clock_ahead',
        events: 40,
        ahead_seconds: 150,
        last_at: '2026-10-13T09:00:00Z',
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reportDay.mockResolvedValue({
    date: '2026-10-12',
    counts: {
      worked: 0,
      late: 0,
      not_clocked_in: 0,
      not_working: 0,
      holiday: 0,
      in_office: 0,
      off: 0,
    },
    people: [],
  });
  mocks.reportOverview.mockResolvedValue(OVERVIEW);
  mocks.saveCsv.mockImplementation(async (name: string) => `C:\\Users\\x\\Downloads\\${name}`);
});

describe('overview model (ADR-0040 §3)', () => {
  it('ranges: weeks start Monday, months from the 1st; up to 93 days', () => {
    // Tuesday 13 Oct 2026.
    expect(rangeOf('this_week', '2026-10-13')).toEqual({ from: '2026-10-12', to: '2026-10-13' });
    expect(rangeOf('last_week', '2026-10-13')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(rangeOf('this_month', '2026-10-13')).toEqual({ from: '2026-10-01', to: '2026-10-13' });
    expect(rangeOf('last_month', '2026-10-13')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(rangeOf('last_week', '2026-10-11')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(rangeIssue('2026-07-13', '2026-10-13')).toBeNull();
    expect(rangeIssue('2026-07-12', '2026-10-13')).toBe('At most 93 days');
    expect(rangeIssue('2026-10-14', '2026-10-13')).toBe('The start is after the end');
    expect(hrs(32 * H)).toBe('32h');
    expect(hrs(1.25 * H)).toBe('1.3h');
    expect(refusalText('clock_ahead', 150)).toBe("computer's clock is ahead by 2 min 30 s");
    expect(refusalText('clock_ahead', 120)).toBe("computer's clock is ahead by 2 min");
    expect(refusalText('device_signed_out', null)).toBe('computer signed out by an Administrator');
  });

  it('CSV as the server writes it, formula-safe', () => {
    const lines = csvOf(OVERVIEW, 'hours').split('\r\n');
    expect(lines[0]).toBe(
      'Person,Days worked,Shift days,Shift days worked,Attendance %,Hours worked,Hours scheduled',
    );
    expect(lines[1]).toBe('Roshni Test,4,5,4,80.0,32.00,45.00');
    expect(lines[2]).toBe("'=Farheen,4,5,4,100.0,32.00,45.00");
    expect(csvName(OVERVIEW, 'lateness')).toBe('cloudpunch-lateness-2026-10-05-to-2026-10-11.csv');
  });
});

describe('Reports → Overview (ADR-0040 §3)', () => {
  it('last week by default: totals, charts, a table per area, health; CSV saved', async () => {
    const user = userEvent.setup();
    render(<Reports canOpenDays />);
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    const totals = await screen.findByLabelText('overview-totals');
    expect(mocks.reportOverview).toHaveBeenCalledTimes(1);
    expect(totals).toHaveTextContent('Attendance90%9 of 10 shift days');
    expect(screen.getByRole('img', { name: '5 Oct: 90%' })).toBeTruthy();
    expect(screen.getByRole('img', { name: '5 Oct: 2 / 1' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'overview-hours' })).toHaveTextContent('80% (4/5)');

    await user.click(screen.getByRole('tab', { name: 'Lateness' }));
    const late = screen.getByRole('table', { name: 'overview-lateness' });
    expect(within(late).getAllByText('25m')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(mocks.saveCsv).toHaveBeenCalledWith(
      'cloudpunch-lateness-2026-10-05-to-2026-10-11.csv',
      expect.stringMatching(/^Person,Late starts/),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Saved C:\\Users\\x\\Downloads\\');

    const health = screen.getByLabelText('overview-health');
    expect(health).toHaveTextContent('With the app signed in2 of 3');
    expect(health).toHaveTextContent('Nilesh Test');
    expect(within(health).getByRole('img', { name: '0.1.27: 1' })).toBeTruthy();
    expect(health).toHaveTextContent('1 behind 0.1.36');
    expect(within(health).getByLabelText('uploads-refused')).toHaveTextContent(
      "Masrat Afzal (Windows): computer's clock is ahead by 2 min 30 s · 40 events",
    );
  });

  it('a range over 93 days is not asked for', async () => {
    const user = userEvent.setup();
    render(<Reports canOpenDays />);
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    await screen.findByLabelText('overview-totals');
    const from = screen.getByLabelText('overview-from');
    await user.clear(from);
    await user.type(from, '2026-01-01');
    expect(await screen.findByText('At most 93 days')).toBeTruthy();
    expect(mocks.reportOverview).toHaveBeenCalledTimes(1);
  });
});
