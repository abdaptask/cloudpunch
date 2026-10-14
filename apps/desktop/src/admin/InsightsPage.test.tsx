import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InsightItem, Overview, OverviewPerson, StripDay } from '../api.js';
import { TeamScreen } from '../TeamScreen.js';
import { InsightsInbox } from './InsightsPage.js';
import {
  applyFilter,
  byTeam,
  delta,
  grouped,
  lastStep,
  NO_FILTER,
  previousRange,
  summaryLine,
} from './insightsModel.js';

const mocks = vi.hoisted(() => ({
  insights: vi.fn(),
  insightHistory: vi.fn(),
  insightNudge: vi.fn(),
  insightDismiss: vi.fn(),
  teamNow: vi.fn(),
  teamExceptions: vi.fn(),
}));
vi.mock('../api.js', () => ({ api: mocks }));

const strip: StripDay[] = [
  { date: '2026-10-12', mark: 'late', minutes_late: 25, worked_ms: 0, shift_ms: 0, idle_ms: 0 },
  { date: '2026-10-13', mark: 'on_time', minutes_late: 0, worked_ms: 0, shift_ms: 0, idle_ms: 0 },
];

const item = (over: Partial<InsightItem>): InsightItem => ({
  id: '11111111-1111-4111-8111-111111111111',
  employee_id: 'e1',
  name: 'Roshni Test',
  manager_name: 'Nilesh Test',
  kind: 'late_starts',
  severity: 'warning',
  status: 'open',
  headline: 'Late 4 times in the last 2 weeks, 25 min on average',
  evidence: { strip },
  follow_up_on: null,
  no_change: false,
  opened_at: '2026-10-10T00:00:00Z',
  updated_at: '2026-10-13T00:00:00Z',
  draft: 'Hi Roshni, we noticed a few late starts lately. Is anything getting in the way?',
  last: null,
  ...over,
});

const ROSHNI = item({});
const FARHEEN = item({
  id: '22222222-2222-4222-8222-222222222222',
  employee_id: 'e2',
  name: 'Farheen Test',
  manager_name: 'Masrat Afzal',
  kind: 'missed_starts',
  severity: 'serious',
  status: 'open',
  no_change: true,
  headline: 'No clock-in on 3 shift days',
});
const MASRAT = item({
  id: '33333333-3333-4333-8333-333333333333',
  employee_id: 'e3',
  name: 'Masrat Afzal',
  manager_name: null,
  kind: 'long_idle',
  severity: 'info',
  status: 'nudged',
  follow_up_on: '2026-10-01',
  headline: 'Idle over an hour on 3 days',
  last: { action: 'nudged', at: '2026-09-17T09:00:00Z', by: 'Abdulla Sheikh', note: null },
});

const TODAY = '2026-10-14';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insights.mockImplementation(async (status: string) =>
    status === 'closed'
      ? {
          status,
          insights: [
            item({
              id: '44444444-4444-4444-8444-444444444444',
              status: 'resolved',
              headline: 'Short days',
            }),
          ],
        }
      : { status, insights: [ROSHNI, FARHEEN, MASRAT] },
  );
  mocks.insightHistory.mockResolvedValue({
    events: [
      { action: 'opened', at: '2026-10-10T00:00:00Z', by: null, note: null },
      { action: 'updated', at: '2026-10-13T00:00:00Z', by: null, note: null },
    ],
  });
  mocks.insightNudge.mockResolvedValue({ status: 'nudged', follow_up_on: '2026-10-28' });
  mocks.insightDismiss.mockResolvedValue({ status: 'dismissed' });
  mocks.teamNow.mockResolvedValue({ people: [] });
  mocks.teamExceptions.mockResolvedValue({ exceptions: [] });
});

describe('insights model (ADR-0047 §4)', () => {
  it('views, filters, groups and the summary line', () => {
    const all = [ROSHNI, FARHEEN, MASRAT];
    expect(applyFilter(all, { ...NO_FILTER, view: 'serious' }, TODAY)).toEqual([FARHEEN]);
    expect(applyFilter(all, { ...NO_FILTER, view: 'no_change' }, TODAY)).toEqual([FARHEEN]);
    expect(applyFilter(all, { ...NO_FILTER, view: 'due' }, TODAY)).toEqual([MASRAT]);
    expect(applyFilter(all, { ...NO_FILTER, view: 'due' }, '2026-09-30')).toEqual([]);
    expect(applyFilter(all, { ...NO_FILTER, manager: 'No manager' }, TODAY)).toEqual([MASRAT]);
    expect(applyFilter(all, { ...NO_FILTER, q: 'masrat' }, TODAY)).toEqual([FARHEEN, MASRAT]);
    expect(grouped(all).map(([s]) => s)).toEqual(['serious', 'warning', 'info']);
    expect(summaryLine(all, TODAY)).toBe(
      '2 open · 1 no change after nudge · 1 nudged, 1 follow-up due',
    );
    expect(summaryLine([], TODAY)).toBe('Nothing needs attention.');
    expect(lastStep(MASRAT, Date.parse('2026-09-19T09:00:00Z'))).toBe(
      'Nudged by Abdulla Sheikh 2 days ago · follow-up 1 Oct',
    );
  });

  it('trends: the period before, the change and its tone, by team', () => {
    expect(previousRange('2026-10-05', '2026-10-11')).toEqual({
      from: '2026-09-28',
      to: '2026-10-04',
    });
    expect(previousRange('2026-10-01', '2026-10-31')).toEqual({
      from: '2026-08-31',
      to: '2026-09-30',
    });
    expect(delta(18, 12, false)).toEqual({ text: 'up 6', tone: 'bad' });
    expect(delta(0.88, 0.9, true, true)).toEqual({ text: 'down 2 pts', tone: 'bad' });
    expect(delta(0.92, 0.9, true, true)).toEqual({ text: 'up 2 pts', tone: 'good' });
    expect(delta(3, 3, false)).toEqual({ text: 'no change', tone: 'neutral' });
    expect(delta(3, null, false)).toEqual({ text: '', tone: 'neutral' });

    const p = (id: string, late: number, missed: number, worked: number): OverviewPerson =>
      ({
        employee_id: id,
        name: id,
        late_starts: late,
        missed_starts: missed,
        shift_days: 5,
        shift_days_worked: worked,
      }) as OverviewPerson;
    const o = { people: [p('a', 1, 0, 5), p('b', 2, 1, 4), p('c', 0, 0, 5)] } as Overview;
    expect(
      byTeam(
        o,
        new Map([
          ['a', 'Nilesh'],
          ['b', 'Nilesh'],
          ['c', null],
        ]),
      ),
    ).toEqual([
      {
        team: 'Nilesh',
        people: 2,
        late: 3,
        missed: 1,
        shiftDays: 10,
        shiftDaysWorked: 9,
        attendance: 0.9,
      },
      {
        team: 'No manager',
        people: 1,
        late: 0,
        missed: 0,
        shiftDays: 5,
        shiftDaysWorked: 5,
        attendance: 1,
      },
    ]);
  });
});

describe('Insights inbox (ADR-0047 §4)', () => {
  it('serious first; views, kind, team and search narrow it', async () => {
    const user = userEvent.setup();
    render(<InsightsInbox />);
    expect(await screen.findByLabelText('insights-summary')).toHaveTextContent('2 open');
    const groups = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(groups.filter((g) => g?.startsWith('severity'))).toEqual([
      'severity serious',
      'severity warning',
      'severity info',
    ]);
    const card = screen.getByLabelText(/^finding Farheen Test/);
    expect(card).toHaveTextContent("Farheen Test · Masrat Afzal's team");
    expect(card).toHaveTextContent('no change after nudge');
    expect(
      within(screen.getByLabelText(/^finding Roshni Test/))
        .getByRole('img')
        .getAttribute('aria-label'),
    ).toBe('Last 2 days: 1 late, 1 on time');

    await user.click(screen.getByRole('tab', { name: 'Follow-up due 1' }));
    expect(screen.queryByLabelText(/^finding Roshni Test/)).toBeNull();
    expect(screen.getByLabelText(/^finding Masrat Afzal/)).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: 'All open 3' }));
    await user.selectOptions(screen.getByLabelText('insight-kind'), 'missed_starts');
    expect(screen.getAllByRole('listitem').map((l) => l.getAttribute('aria-label'))).toEqual([
      'finding Farheen Test: No clock-in on 3 shift days',
    ]);
    await user.selectOptions(screen.getByLabelText('insight-kind'), '');
    await user.selectOptions(screen.getByLabelText('insight-team'), 'Nilesh Test');
    expect(screen.getByLabelText(/^finding Roshni Test/)).toBeTruthy();
    expect(screen.queryByLabelText(/^finding Farheen Test/)).toBeNull();
    await user.selectOptions(screen.getByLabelText('insight-team'), '');
    await user.type(screen.getByLabelText('insight-search'), 'zzz');
    expect(screen.getByText('Nothing matches these filters.')).toBeTruthy();
  });

  it('nudge: the draft, edited and sent; the card shows the follow-up', async () => {
    const user = userEvent.setup();
    render(<InsightsInbox />);
    const card = await screen.findByLabelText(/^finding Roshni Test/);
    await user.click(within(card).getByRole('button', { name: 'Nudge' }));
    const box = within(card).getByLabelText('nudge-message');
    expect(box).toHaveValue(ROSHNI.draft);
    await user.clear(box);
    await user.type(box, 'short');
    expect(within(card).getByRole('button', { name: 'Send nudge' })).toBeDisabled();
    await user.type(box, ' but now long enough');
    await user.click(within(card).getByRole('button', { name: 'Send nudge' }));
    expect(mocks.insightNudge).toHaveBeenCalledWith(ROSHNI.id, 'short but now long enough');
    const done = await screen.findByLabelText(/^finding Roshni Test/);
    expect(done).toHaveTextContent('Sent to Roshni Test. CloudPunch checks again on 28 Oct.');
    expect(done).toHaveTextContent('follow-up 28 Oct');
    expect(within(done).getByRole('button', { name: 'Nudge again' })).toBeTruthy();
  });

  it('nudge refused: says why', async () => {
    mocks.insightNudge.mockRejectedValue('mail_not_configured');
    const user = userEvent.setup();
    render(<InsightsInbox />);
    const card = await screen.findByLabelText(/^finding Roshni Test/);
    await user.click(within(card).getByRole('button', { name: 'Nudge' }));
    await user.click(within(card).getByRole('button', { name: 'Send nudge' }));
    expect(await within(card).findByRole('alert')).toBeTruthy();
  });

  it('dismiss needs a reason; history lists the steps; closed ones read-only', async () => {
    const user = userEvent.setup();
    render(<InsightsInbox />);
    const card = await screen.findByLabelText(/^finding Roshni Test/);
    await user.click(within(card).getByRole('button', { name: 'History' }));
    const history = await within(card).findByLabelText('history Roshni Test');
    expect(history).toHaveTextContent('Found');
    expect(history).toHaveTextContent('Updated');
    expect(mocks.insightHistory).toHaveBeenCalledWith(ROSHNI.id);

    await user.click(within(card).getByRole('button', { name: 'Dismiss' }));
    const group = within(card).getByRole('group', { name: 'dismiss Roshni Test' });
    const go = within(group).getByRole('button', { name: 'Dismiss' });
    expect(go).toBeDisabled();
    await user.type(within(group).getByLabelText('dismiss-reason'), 'approved leave');
    await user.click(go);
    expect(mocks.insightDismiss).toHaveBeenCalledWith(ROSHNI.id, 'approved leave');

    await user.click(screen.getByRole('button', { name: 'Show closed' }));
    const closed = await screen.findByLabelText('closed-findings');
    expect(within(closed).queryByRole('button', { name: 'Nudge' })).toBeNull();
    expect(within(closed).getByRole('button', { name: 'History' })).toBeTruthy();
  });
});

describe('Team → Insights (ADR-0047 §4)', () => {
  it("a manager's findings in the Team window", async () => {
    const user = userEvent.setup();
    render(<TeamScreen />);
    await user.click(screen.getByRole('tab', { name: 'Insights' }));
    expect(await screen.findByLabelText(/^finding Roshni Test/)).toBeTruthy();
    expect(mocks.insights).toHaveBeenCalledWith('live');
    // Compact: no heading, no team select.
    expect(screen.queryByRole('heading', { name: 'Insights' })).toBeNull();
    expect(screen.queryByLabelText('insight-team')).toBeNull();
  });
});
