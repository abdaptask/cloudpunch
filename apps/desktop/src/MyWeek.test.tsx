import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyWeek as MyWeekData } from './api.js';
import { dayDetail, MyWeek } from './MyWeek.js';

const mocks = vi.hoisted(() => ({ myInsights: vi.fn(), addInsightContext: vi.fn() }));
vi.mock('./api.js', () => ({ api: mocks }));

const H = 3_600_000;
const marks = [
  'on_time',
  'late',
  'missed',
  'short',
  'off',
  'on_time',
  'holiday',
  'on_time',
  'office',
  'late',
  'on_time',
  'off',
  'worked',
  'late',
] as const;

const DATA: MyWeekData = {
  from: '2026-10-01',
  to: '2026-10-14',
  strip: marks.map((mark, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    mark,
    minutes_late: mark === 'late' ? 25 : null,
    worked_ms: mark === 'missed' || mark === 'off' ? 0 : 8 * H,
    shift_ms: mark === 'off' || mark === 'worked' ? 0 : 9 * H,
    idle_ms: i === 0 ? 40 * 60_000 : 0,
  })),
  totals: {
    on_time: 4,
    shift_days: 8,
    worked_ms: 70 * H,
    scheduled_ms: 81 * H,
    idle_ms: 40 * 60_000,
  },
  findings: [
    {
      id: '0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
      kind: 'late_starts',
      status: 'nudged',
      headline: 'Late 3 times in 14 days',
      dates: ['2026-10-02', '2026-10-10', '2026-10-14'],
      nudges: [
        {
          at: '2026-10-14T05:00:00Z',
          by: 'Mona Test',
          message: 'Hi Isha, is anything making mornings hard?',
        },
      ],
      context: [{ at: '2026-10-14T06:00:00Z', text: 'Bus timings changed' }],
    },
    {
      id: '1f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
      kind: 'long_idle',
      status: 'resolved',
      headline: 'Idle an hour or more on 3 days',
      dates: [],
      nudges: [],
      context: [],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.myInsights.mockResolvedValue(DATA);
  mocks.addInsightContext.mockResolvedValue({ ok: true });
});

describe('My week (ADR-0047 §5)', () => {
  it('the strip: one mark per day with its words; a legend of what appears', async () => {
    render(<MyWeek onClose={() => undefined} />);
    const days = within(await screen.findByRole('list', { name: 'my-days' })).getAllByRole(
      'listitem',
    );
    expect(days).toHaveLength(14);
    expect(days[1]).toHaveAccessibleName('Fri 2 Oct: Late · 25 min late · 8h 00m of 9h 00m');
    expect(days[2]).toHaveAccessibleName('Sat 3 Oct: No clock-in');
    expect(days[0]).toHaveAccessibleName('Thu 1 Oct: On time · 8h 00m of 9h 00m · idle 40m');
    expect(days[12]).toHaveAccessibleName('Tue 13 Oct: Worked, no shift · 8h 00m');
    expect(screen.getByLabelText('my-days-legend')).toHaveTextContent(
      '✓On time!Late✕No clock-in◐Short day–Off–Holiday–In office•Worked, no shift',
    );
    expect(screen.getByLabelText('my-totals')).toHaveTextContent('On time4 of 8');
    expect(screen.getByLabelText('my-totals')).toHaveTextContent('of 81h 00m scheduled');
  });

  it('a finding shows what was said, my context, and takes more', async () => {
    const user = userEvent.setup();
    render(<MyWeek />);
    const card = await screen.findByRole('article', { name: 'finding Late 3 times in 14 days' });
    expect(card).toHaveTextContent('Fri 2 Oct · Sat 10 Oct · Wed 14 Oct');
    expect(card).toHaveTextContent('Mona Test');
    expect(card).toHaveTextContent('Hi Isha, is anything making mornings hard?');
    expect(card).toHaveTextContent('Bus timings changed');
    // Closed ones are only listed.
    expect(
      screen.getByText(/Closed in the last 30 days: Idle an hour or more on 3 days/),
    ).toBeTruthy();

    const box = within(card).getByLabelText('context for Late 3 times in 14 days');
    expect(within(card).getByRole('button', { name: 'Add context' })).toBeDisabled();
    await user.type(box, 'New school run from Monday');
    await user.click(within(card).getByRole('button', { name: 'Add context' }));
    expect(mocks.addInsightContext).toHaveBeenCalledWith(
      '0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
      'New school run from Monday',
    );
    // Reloaded to show it.
    expect(mocks.myInsights).toHaveBeenCalledTimes(2);
  });

  it('nothing open: a positive line; an error in words', async () => {
    mocks.myInsights.mockResolvedValueOnce({ ...DATA, findings: [] });
    const { unmount } = render(<MyWeek />);
    expect(await screen.findByText('Nothing needs your attention. Keep it up.')).toBeTruthy();
    unmount();
    mocks.myInsights.mockRejectedValueOnce('offline');
    render(<MyWeek />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach CloudPunch right now.");
  });

  it('day words', () => {
    expect(
      dayDetail({
        date: '2026-10-05',
        mark: 'short',
        minutes_late: null,
        worked_ms: 6 * H,
        shift_ms: 9 * H,
        idle_ms: 0,
      }),
    ).toBe('Mon 5 Oct: Short day · 6h 00m of 9h 00m');
  });
});
