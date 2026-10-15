import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HabitsReport, PersonHabits } from '../api.js';
import { HabitsPage, hhmm } from './HabitsPage.js';
import { linkedTab, Reports } from './ReportsPage.js';

const mocks = vi.hoisted(() => ({
  reportHabits: vi.fn(),
  insights: vi.fn(),
}));
vi.mock('../api.js', () => ({ api: mocks }));

const person = (over: Partial<PersonHabits>): PersonHabits => ({
  employee_id: 'e1',
  name: 'Roshni Test',
  tz: 'Asia/Kolkata',
  days_worked: 10,
  shift_days: 10,
  start: { median: 545, low: 540, high: 550, spread: 10, n: 10 },
  end: { median: 1080, low: 1075, high: 1085, spread: 10, n: 10 },
  start_by_weekday: [null, null, null, null, null, null, null],
  late_days: 0,
  late_median: null,
  on_time_rate: 1,
  early_leaves: 0,
  left_clocked_in: 0,
  idle_cap_outs: 0,
  locked_outs: 0,
  split_days: 0,
  long_days: 0,
  missed_starts: 0,
  from_sign_in: 0,
  label: 'Steady 09:05–18:00',
  notes: [],
  flags: ['steady'],
  ...over,
});

const report: HabitsReport = {
  from: '2026-10-15',
  to: '2026-10-25',
  people: [
    person({
      employee_id: 'e2',
      name: 'Eela Test',
      label: 'Often leaves clocked in',
      notes: ['Left clocked in on 3 days'],
      flags: ['leaves_clocked_in'],
      on_time_rate: 0.5,
    }),
    person({}),
  ],
  company: {
    people: 2,
    days_worked: 20,
    on_time_rate: 0.75,
    median_start: 545,
    median_end: 1080,
    start_hours: Array.from({ length: 24 }, (_, h) => (h === 9 ? 20 : 0)),
    end_hours: Array.from({ length: 24 }, (_, h) => (h === 18 ? 18 : 0)),
    flags: { steady: 1, leaves_clocked_in: 1 },
    weeks: [
      {
        week_start: '2026-10-12',
        days_worked: 6,
        on_time_rate: 1,
        median_start: 545,
        median_end: 1080,
        late_days: 0,
        left_clocked_in: 1,
        auto_outs: 0,
      },
    ],
    changed: [
      {
        employee_id: 'e2',
        name: 'Eela Test',
        start_shift: 45,
        end_shift: null,
        first_start: 540,
        last_start: 585,
        first_end: 1080,
        last_end: 1080,
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reportHabits.mockResolvedValue(report);
  mocks.insights.mockResolvedValue({ items: [] });
});

describe('Reports → Habits (ADR-0051)', () => {
  it('times read as clock times, after midnight marked', () => {
    expect(hhmm(545)).toBe('09:05');
    expect(hhmm(1470)).toBe('00:30 (+1)');
    expect(hhmm(null)).toBe('—');
  });

  it('shows the headline, who changed, and everyone with their pattern; filters by habit', async () => {
    const user = userEvent.setup();
    render(<HabitsPage />);
    const head = await screen.findByLabelText('habits-headline');
    expect(head).toHaveTextContent('75%');
    expect(head).toHaveTextContent('09:05');
    expect(screen.getByLabelText('habits-changed')).toHaveTextContent(
      'Eela Test: start 09:00 → 09:45 (+45 min)',
    );
    const table = screen.getByRole('table', { name: 'habits' });
    expect(within(table).getByText('Steady 09:05–18:00')).toBeInTheDocument();
    expect(within(table).getByText('Left clocked in on 3 days')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Needs a look · 1' }));
    expect(within(table).queryByText('Roshni Test')).not.toBeInTheDocument();
    expect(within(table).getByText('Eela Test')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Steady · 1' }));
    expect(within(table).getByText('Roshni Test')).toBeInTheDocument();
    expect(within(table).queryByText('Eela Test')).not.toBeInTheDocument();
  });

  it('says so when the role may not see it', async () => {
    mocks.reportHabits.mockRejectedValue('forbidden');
    render(<HabitsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Your role can't see habits.");
  });

  it('is a Reports tab, opened by ?tab=habits from the email', async () => {
    window.history.pushState({}, '', '/app/admin/?section=reports&tab=habits');
    expect(linkedTab()).toBe('habits');
    render(<Reports canOpenDays={false} />);
    expect(screen.getByRole('tab', { name: 'Habits' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByLabelText('habits-headline')).toBeInTheDocument();
    window.history.pushState({}, '', '/');
    expect(linkedTab()).toBe('insights');
  });

  it('has no Habits tab without the role', () => {
    window.history.pushState({}, '', '/');
    render(<Reports canOpenDays={false} canSeeHabits={false} />);
    expect(screen.queryByRole('tab', { name: 'Habits' })).not.toBeInTheDocument();
  });
});
