import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateView } from './api.js';
import { App } from './App.js';

const mocks = vi.hoisted(() => ({
  getState: vi.fn<() => Promise<StateView>>(),
  clockIn: vi.fn<() => Promise<StateView>>(),
  clockOut: vi.fn<() => Promise<StateView>>(),
  startBreak: vi.fn<(kind: 'bio' | 'meal') => Promise<StateView>>(),
  endBreak: vi.fn<() => Promise<StateView>>(),
  markBack: vi.fn<() => Promise<StateView>>(),
  markAway: vi.fn<(reason: 'meeting') => Promise<StateView>>(),
  respondToPrompt: vi.fn(),
  onState: vi.fn<(cb: (v: StateView) => void) => Promise<() => void>>(),
}));

vi.mock('./api.js', () => ({ api: mocks, STATE_EVENT: 'cp://state' }));

function view(over: Partial<StateView> = {}): StateView {
  return {
    status: 'clocked_out',
    breakKind: null,
    awayReason: null,
    callType: null,
    promptDeadline: null,
    promptOptions: [],
    noteRequiredFor: [],
    autoClockedOutAt: null,
    sessionStartedAt: null,
    timeline: [],
    ...over,
  };
}

let pushState: (v: StateView) => void = () => undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getState.mockResolvedValue(view());
  mocks.onState.mockImplementation((cb) => {
    pushState = cb;
    return Promise.resolve(() => undefined);
  });
});

function statusText(): string | null {
  return within(screen.getByRole('region', { name: 'current-status' })).getByText(
    /clocked in|on a|in a meeting|working away|not clocked/i,
  ).textContent;
}

function actionButtons(): string[] {
  return within(screen.getByRole('region', { name: 'actions' }))
    .getAllByRole('button')
    .map((b) => b.textContent ?? '');
}

describe('App home UI', () => {
  it('shows the agent state from get_state', async () => {
    render(<App />);
    expect(await screen.findByText('Not clocked in')).toBeInTheDocument();
    expect(actionButtons()).toEqual(['Clock in']);
  });

  it('clock in invokes the command and adopts the returned view', async () => {
    mocks.clockIn.mockResolvedValue(view({ status: 'active' }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Clock in' }));
    expect(mocks.clockIn).toHaveBeenCalledOnce();
    expect(statusText()).toBe('Clocked in');
    expect(actionButtons()).toEqual(['Clock out', 'Bio break', 'Meal break', 'In a meeting']);
  });

  it('away tags call mark_away with their reason (ADR-0011)', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active' }));
    mocks.markAway.mockResolvedValue(view({ status: 'away', awayReason: 'meeting' }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'In a meeting' }));
    expect(mocks.markAway).toHaveBeenCalledWith('meeting');
    expect(statusText()).toBe('In a meeting');
    expect(actionButtons()).toEqual(["I'm back", 'Clock out']);
  });

  it('breaks pass their kind', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active' }));
    mocks.startBreak.mockResolvedValue(view({ status: 'on_break', breakKind: 'meal' }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Meal break' }));
    expect(mocks.startBreak).toHaveBeenCalledWith('meal');
    expect(statusText()).toBe('On a meal break');
    expect(actionButtons()).toEqual(['End break', 'Clock out']);
  });

  it('on a call shows the kind of call (ADR-0012)', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'on_call', callType: 'teams' }));
    render(<App />);
    expect(await screen.findByText('On a Teams call')).toBeInTheDocument();
  });

  it('there is no manual phone-call tag', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active' }));
    render(<App />);
    await screen.findByRole('button', { name: 'In a meeting' });
    expect(screen.queryByRole('button', { name: 'On a phone call' })).not.toBeInTheDocument();
  });

  it('on a call with no known kind shows On a call', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'on_call' }));
    render(<App />);
    expect(await screen.findByText('On a call')).toBeInTheDocument();
    expect(actionButtons()).toEqual(['Clock out', 'Bio break', 'Meal break']);
  });

  it('away offers I’m back', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'away', awayReason: 'phone_call' }));
    mocks.markBack.mockResolvedValue(view({ status: 'active' }));
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('On a phone call')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "I'm back" }));
    expect(mocks.markBack).toHaveBeenCalledOnce();
  });

  it('prompt pending offers only Clock out', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'idle_pending', promptDeadline: 1 }));
    render(<App />);
    await screen.findByText('Clocked in — are you still there?');
    expect(actionButtons()).toEqual(['Clock out']);
  });

  it('follows cp://state pushes', async () => {
    render(<App />);
    await screen.findByText('Not clocked in');
    act(() => pushState(view({ status: 'on_break', breakKind: 'bio' })));
    expect(statusText()).toBe('On a bio break');
  });

  it('explains an auto clock-out', async () => {
    mocks.getState.mockResolvedValue(view({ autoClockedOutAt: Date.UTC(2026, 8, 24, 10, 0) }));
    render(<App />);
    expect(await screen.findByRole('status')).toHaveTextContent(/idle prompt wasn't answered/);
  });

  it('shows a live session timer while clocked in', async () => {
    mocks.getState.mockResolvedValue(
      view({ status: 'active', sessionStartedAt: Date.now() - 3_723_000 }),
    );
    render(<App />);
    expect(await screen.findByLabelText('session-timer')).toHaveTextContent(/^01:02:0[34]$/);
  });

  it('renders today’s timeline and tracked totals', async () => {
    const now = Date.now();
    mocks.getState.mockResolvedValue(
      view({
        status: 'on_break',
        breakKind: 'bio',
        sessionStartedAt: now - 60 * 60_000,
        timeline: [
          { kind: 'working', startedAt: now - 60 * 60_000, endedAt: now - 10 * 60_000, session: 1 },
          { kind: 'bio_break', startedAt: now - 10 * 60_000, endedAt: null, session: 1 },
        ],
      }),
    );
    render(<App />);
    const list = await screen.findByRole('list', { name: 'session 1' });
    const items = within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items[0]).toMatch(/Working.*50m 00s/);
    expect(items[1]).toMatch(/Bio break.*10m 0\ds · now/);
    const totalsBox = screen.getByRole('contentinfo', { name: 'totals' });
    const pairs = within(totalsBox)
      .getAllByRole('term')
      .map((dt) => `${dt.textContent} = ${dt.nextElementSibling?.textContent}`);
    expect(pairs[0]).toBe('Working = 50m 00s');
    expect(pairs[1]).toMatch(/^Bio break = 10m 0\ds$/);
    expect(pairs[2]).toMatch(/^On the clock = 1h 00m 0\ds$/);
  });

  it('groups sessions; only the latest starts expanded', async () => {
    const now = Date.now();
    mocks.getState.mockResolvedValue(
      view({
        status: 'active',
        sessionStartedAt: now - 10 * 60_000,
        timeline: [
          { kind: 'working', startedAt: now - 90 * 60_000, endedAt: now - 60 * 60_000, session: 1 },
          { kind: 'working', startedAt: now - 10 * 60_000, endedAt: null, session: 2 },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    const first = await screen.findByRole('button', { name: /Session 1/ });
    const second = screen.getByRole('button', { name: /Session 2/ });
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(first).toHaveTextContent(/30m 00s$/);
    expect(second).toHaveTextContent(/– now/);
    expect(screen.queryByRole('list', { name: 'session 1' })).not.toBeInTheDocument();

    await user.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list', { name: 'session 1' })).toBeInTheDocument();
  });

  it('totals count calls and meetings as Working, with a breakdown', async () => {
    const now = Date.now();
    const MIN = 60_000;
    mocks.getState.mockResolvedValue(
      view({
        status: 'active',
        sessionStartedAt: now - 60 * MIN,
        timeline: [
          { kind: 'working', startedAt: now - 60 * MIN, endedAt: now - 40 * MIN, session: 1 },
          { kind: 'call_teams', startedAt: now - 40 * MIN, endedAt: now - 30 * MIN, session: 1 },
          { kind: 'away_meeting', startedAt: now - 30 * MIN, endedAt: now - 10 * MIN, session: 1 },
          { kind: 'bio_break', startedAt: now - 10 * MIN, endedAt: now - 5 * MIN, session: 1 },
          { kind: 'working', startedAt: now - 5 * MIN, endedAt: now, session: 1 },
        ],
      }),
    );
    render(<App />);
    const totalsBox = await screen.findByRole('contentinfo', { name: 'totals' });
    const pairs = within(totalsBox)
      .getAllByRole('term')
      .map((dt) => `${dt.textContent} = ${dt.nextElementSibling?.textContent}`);
    expect(pairs).toEqual([
      'Working = 55m 00s',
      'At the computer = 25m 00s',
      'Teams calls = 10m 00s',
      'In a meeting = 20m 00s',
      'Bio break = 5m 00s',
      'On the clock = 1h 00m 00s',
    ]);
  });

  it('shows an empty-day hint before anything is tracked', async () => {
    render(<App />);
    expect(await screen.findByText(/Nothing tracked yet today/)).toBeInTheDocument();
    expect(screen.queryByRole('contentinfo', { name: 'totals' })).not.toBeInTheDocument();
  });

  it('shows a rejection instead of changing state', async () => {
    mocks.clockIn.mockRejectedValue('invalid_transition');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Clock in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("isn't available");
    expect(statusText()).toBe('Not clocked in');
  });
});
