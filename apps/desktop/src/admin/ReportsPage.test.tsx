import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DayReportRow } from '../api.js';
import {
  along,
  axisOf,
  endText,
  headline,
  hours,
  matches,
  shiftText,
  startText,
  workedText,
} from './dayReportModel.js';
import { ReportsPage } from './ReportsPage.js';

const mocks = vi.hoisted(() => ({
  reportDay: vi.fn(),
  teamDay: vi.fn(),
  adminSetOfficeDay: vi.fn(),
  adminCorrectTime: vi.fn(),
}));
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
  it('tiles, a status bar and filters; the timeline on one clock; a row opens the day', async () => {
    const user = userEvent.setup();
    render(<ReportsPage canOpenDays />);
    const tiles = await screen.findByLabelText('report-tiles');
    expect(mocks.reportDay).toHaveBeenCalledTimes(1);
    expect(tiles).toHaveTextContent('Clocked in1 / 250% of those on shift');
    expect(tiles).toHaveTextContent('Late140m late on average');
    expect(screen.getByRole('button', { name: 'Not clocked in: 1' })).toBeTruthy();

    // The timeline: problems first, "off" left out, India time by default.
    const rows = within(screen.getByRole('list', { name: 'timeline-rows' }));
    expect(rows.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Farheen Test: Not clocked in, — worked',
      'Roshni Test: Late, 8h 00m worked',
    ]);
    expect(screen.getByRole('figure', { name: 'day-timeline' })).toHaveTextContent('09:00');
    expect(screen.getByLabelText('timeline-legend')).toHaveTextContent('Worked');

    // Filters narrow it; the counts are on the chips.
    await user.click(screen.getByRole('tab', { name: 'Breaks over limit 1' }));
    expect(rows.getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('tab', { name: 'Everyone 2' }));

    await user.click(rows.getByRole('button', { name: /^Roshni Test/ }));
    expect(await screen.findByLabelText('report-person-day')).toBeTruthy();
    expect(mocks.teamDay).toHaveBeenCalledWith('e1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('the table view lists the same people with the details', async () => {
    const user = userEvent.setup();
    render(<ReportsPage canOpenDays={false} />);
    await screen.findByLabelText('report-tiles');
    await user.click(screen.getByRole('tab', { name: 'Table' }));
    const table = screen.getByRole('table', { name: 'day-report' });
    expect(within(table).getByText('09:40 (+40m)')).toBeTruthy();
    expect(within(table).getByText('1 waiting')).toBeTruthy();
  });

  it('opens on the day in the address (the email link) and steps by day', async () => {
    const today = new Date();
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    window.history.replaceState(null, '', `/app/admin/?section=reports&date=${iso}`);
    const user = userEvent.setup();
    render(<ReportsPage canOpenDays={false} />);
    await screen.findByLabelText('report-tiles');
    expect(mocks.reportDay).toHaveBeenCalledWith(iso);
    await user.click(screen.getByRole('button', { name: 'next day' }));
    expect(mocks.reportDay).toHaveBeenCalledTimes(2);
    window.history.replaceState(null, '', '/');
  });

  it('a refusal shows in words', async () => {
    mocks.reportDay.mockRejectedValue('forbidden');
    render(<ReportsPage canOpenDays={false} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Your role can't see reports.");
  });
});

describe('timeline maths', () => {
  it('the axis runs over whole hours on the chosen clock; filters match the email', () => {
    const r = row({
      status: 'late',
      segments: [
        { kind: 'work', from: '2026-10-12T04:10:00.000Z', to: '2026-10-12T12:30:00.000Z' },
      ],
    });
    const a = axisOf([r], 'Asia/Kolkata', Date.parse('2026-10-13T00:00:00Z'));
    // 09:00–18:00 IST shift, 09:40 in: 09:00 to 18:00 IST, every hour.
    expect(a?.from).toBe(Date.parse('2026-10-12T03:30:00Z'));
    expect(a?.to).toBe(Date.parse('2026-10-12T12:30:00Z'));
    expect(a?.ticks).toHaveLength(10);
    expect(along(a!, Date.parse('2026-10-12T08:00:00Z'))).toBe(50);
    expect(matches(r, 'late')).toBe(true);
    expect(matches(r, 'attention')).toBe(true);
    expect(matches({ ...r, status: 'worked' }, 'attention')).toBe(false);
    expect(matches({ ...r, status: 'worked', idle_ms: 3_600_000 }, 'long_idle')).toBe(true);
    expect(matches({ ...r, status: 'off' }, 'all')).toBe(false);
  });
});

describe('marking someone in office from the day summary (owner, 2026-10-14)', () => {
  it('a not-clocked-in person moves to the In office chip; undo brings them back', async () => {
    mocks.adminSetOfficeDay.mockResolvedValue({ date: '2026-10-12', in_office: true });
    const user = userEvent.setup();
    render(<ReportsPage canOpenDays={false} canSetOffice />);
    const rows = within(await screen.findByRole('list', { name: 'timeline-rows' }));
    await user.click(rows.getByRole('button', { name: /^Farheen Test/ }));
    const panel = screen.getByLabelText('report-person-day');
    // No team view for this role: the day itself isn't shown, only the action.
    expect(mocks.teamDay).not.toHaveBeenCalled();
    // After marking, the server says she was in the office.
    const people = (await mocks.reportDay.mock.results[0]?.value) as { people: DayReportRow[] };
    mocks.reportDay.mockResolvedValue({
      date: '2026-10-12',
      counts: { ...counts, not_clocked_in: 0, in_office: 1 },
      people: people.people.map((p) =>
        p.employee_id === 'e2' ? { ...p, status: 'in_office' } : p,
      ),
    });
    await user.click(within(panel).getByRole('button', { name: 'Mark in office on this day' }));
    expect(mocks.adminSetOfficeDay).toHaveBeenCalledWith(
      'e2',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      true,
      'From the day summary',
    );
    expect(await screen.findByRole('status')).toHaveTextContent('listed under In office now');
    const after = within(await screen.findByRole('list', { name: 'timeline-rows' }));
    expect(after.queryByRole('button', { name: /^Farheen Test/ })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'In office 1' }));
    expect(after.getByRole('button', { name: /^Farheen Test/ })).toBeInTheDocument();
  });

  it('someone who clocked in is not offered it; a role without the right sees no button', async () => {
    const user = userEvent.setup();
    render(<ReportsPage canOpenDays canSetOffice />);
    const rows = within(await screen.findByRole('list', { name: 'timeline-rows' }));
    await user.click(rows.getByRole('button', { name: /^Roshni Test/ }));
    const panel = screen.getByLabelText('report-person-day');
    expect(within(panel).queryByRole('button', { name: 'Mark in office on this day' })).toBeNull();
    expect(panel).toHaveTextContent('counts as worked');
  });
});

describe('an Administrator corrects time from the day summary (ADR-0049)', () => {
  it('saves a correction that counts straight away', async () => {
    mocks.adminCorrectTime.mockResolvedValue({ correction: {} });
    const user = userEvent.setup();
    render(<ReportsPage canOpenDays={false} canCorrectTime />);
    const rows = within(await screen.findByRole('list', { name: 'timeline-rows' }));
    await user.click(rows.getByRole('button', { name: /^Roshni Test/ }));
    const panel = screen.getByLabelText('report-person-day');
    await user.click(within(panel).getByRole('button', { name: 'Correct time' }));
    const form = within(screen.getByRole('form', { name: 'correction-form' }));
    expect(form.getByText('Counts straight away, recorded as corrected by you.')).toBeTruthy();
    await user.type(form.getByLabelText('correction-start'), '10:00');
    await user.type(form.getByLabelText('correction-end'), '11:00');
    await user.selectOptions(form.getByLabelText('correction-kind'), 'working');
    await user.type(form.getByLabelText('correction-reason'), 'Forgot to end the bio break');
    await user.click(form.getByRole('button', { name: 'Save correction' }));
    expect(mocks.adminCorrectTime).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 'e1',
        kind: 'working',
        reason: 'Forgot to end the bio break',
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('It counts now');
  });

  it('is not offered without the right', async () => {
    const user = userEvent.setup();
    render(<ReportsPage canOpenDays canSetOffice />);
    const rows = within(await screen.findByRole('list', { name: 'timeline-rows' }));
    await user.click(rows.getByRole('button', { name: /^Roshni Test/ }));
    const panel = screen.getByLabelText('report-person-day');
    expect(within(panel).queryByRole('button', { name: 'Correct time' })).toBeNull();
  });
});
