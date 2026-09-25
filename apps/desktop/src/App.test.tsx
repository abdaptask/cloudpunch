import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatus, EnrollmentStatus, StateView } from './api.js';
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
  authStatus: vi.fn<() => Promise<AuthStatus>>(),
  signIn: vi.fn<() => Promise<AuthStatus>>(),
  cancelSignIn: vi.fn<() => Promise<void>>(),
  signOut: vi.fn<() => Promise<AuthStatus>>(),
  onAuth: vi.fn<(cb: (s: AuthStatus) => void) => Promise<() => void>>(),
  hideToTray: vi.fn<() => Promise<void>>(),
  quitApp: vi.fn<() => Promise<void>>(),
  clockOutAndQuit: vi.fn<() => Promise<void>>(),
  onCloseRequested: vi.fn<(cb: () => void) => Promise<() => void>>(),
  ackLongShift: vi.fn<() => Promise<StateView>>(),
  enrollmentStatus: vi.fn<() => Promise<EnrollmentStatus>>(),
  onEnrollment: vi.fn<(cb: (s: EnrollmentStatus) => void) => Promise<() => void>>(),
}));

const SIGNED_IN: AuthStatus = { signedIn: true, name: 'Test User', username: 'test@aptask.com' };
const SIGNED_OUT: AuthStatus = { signedIn: false, name: null, username: null };

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
    longShift: false,
    ...over,
  };
}

let pushState: (v: StateView) => void = () => undefined;
let pushAuth: (s: AuthStatus) => void = () => undefined;
let pressClose: () => void = () => undefined;
let pushEnrollment: (s: EnrollmentStatus) => void = () => undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getState.mockResolvedValue(view());
  mocks.onState.mockImplementation((cb) => {
    pushState = cb;
    return Promise.resolve(() => undefined);
  });
  mocks.authStatus.mockResolvedValue(SIGNED_IN);
  mocks.onAuth.mockImplementation((cb) => {
    pushAuth = cb;
    return Promise.resolve(() => undefined);
  });
  mocks.onCloseRequested.mockImplementation((cb) => {
    pressClose = cb;
    return Promise.resolve(() => undefined);
  });
  mocks.enrollmentStatus.mockResolvedValue({ state: 'enrolled', code: null });
  mocks.onEnrollment.mockImplementation((cb) => {
    pushEnrollment = cb;
    return Promise.resolve(() => undefined);
  });
  mocks.hideToTray.mockResolvedValue(undefined);
  mocks.quitApp.mockResolvedValue(undefined);
  mocks.clockOutAndQuit.mockResolvedValue(undefined);
  window.localStorage.clear();
});

describe('closing the window (ADR-0013)', () => {
  it('clocked in: asks, and Keep running hides to the tray', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active' }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Clock out' });
    act(() => pressClose());
    const dialog = screen.getByRole('dialog', { name: 'close-dialog' });
    expect(dialog).toHaveTextContent("You're still clocked in");
    await user.click(within(dialog).getByRole('button', { name: 'Keep running in tray' }));
    expect(mocks.hideToTray).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clocked in: Clock out & quit clocks out through the agent', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active' }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Clock out' });
    act(() => pressClose());
    await user.click(screen.getByRole('button', { name: 'Clock out & quit' }));
    expect(mocks.clockOutAndQuit).toHaveBeenCalledOnce();
    expect(mocks.quitApp).not.toHaveBeenCalled();
  });

  it('clocked out: offers a plain Quit', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Clock in' });
    act(() => pressClose());
    expect(screen.getByRole('dialog')).toHaveTextContent('Close CloudPunch?');
    await user.click(screen.getByRole('button', { name: 'Quit' }));
    expect(mocks.quitApp).toHaveBeenCalledOnce();
  });

  it("Don't ask again remembers keep-running only", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Clock in' });
    act(() => pressClose());
    await user.click(screen.getByRole('checkbox', { name: "Don't ask again" }));
    await user.click(screen.getByRole('button', { name: 'Keep running in tray' }));
    act(() => pressClose());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.hideToTray).toHaveBeenCalledTimes(2);
  });

  it('Cancel just closes the dialog', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Clock in' });
    act(() => pressClose());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.hideToTray).not.toHaveBeenCalled();
  });
});

describe('long-shift check (ADR-0013)', () => {
  it('shows the banner; Still working acknowledges it', async () => {
    const started = Date.now() - 9 * 3_600_000 - 60_000;
    mocks.getState.mockResolvedValue(
      view({ status: 'active', sessionStartedAt: started, longShift: true }),
    );
    mocks.ackLongShift.mockResolvedValue(view({ status: 'active', sessionStartedAt: started }));
    const user = userEvent.setup();
    render(<App />);
    const banner = await screen.findByRole('alertdialog', { name: 'long-shift' });
    expect(banner).toHaveTextContent("You've been clocked in for 9 hours");
    await user.click(within(banner).getByRole('button', { name: 'Still working' }));
    expect(mocks.ackLongShift).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Clock out from the banner clocks out', async () => {
    const started = Date.now() - 10 * 3_600_000;
    mocks.getState.mockResolvedValue(
      view({ status: 'active', sessionStartedAt: started, longShift: true }),
    );
    mocks.clockOut.mockResolvedValue(view());
    const user = userEvent.setup();
    render(<App />);
    const banner = await screen.findByRole('alertdialog', { name: 'long-shift' });
    await user.click(within(banner).getByRole('button', { name: 'Clock out' }));
    expect(mocks.clockOut).toHaveBeenCalledOnce();
  });
});

describe('sign-in recovery when the browser tab was closed', () => {
  it('Open the browser again restarts sign-in; the old attempt is ignored', async () => {
    mocks.authStatus.mockResolvedValue(SIGNED_OUT);
    let rejectFirst: (e: unknown) => void = () => undefined;
    let finishSecond: (s: AuthStatus) => void = () => undefined;
    mocks.signIn
      .mockReturnValueOnce(new Promise((_, reject) => (rejectFirst = reject)))
      .mockReturnValueOnce(new Promise((resolve) => (finishSecond = resolve)));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Sign in with Microsoft' }));
    await user.click(screen.getByRole('button', { name: 'Open the browser again' }));
    expect(mocks.signIn).toHaveBeenCalledTimes(2);

    // The agent cancels the first attempt; that must not show an error
    // or end the waiting state.
    await act(async () => rejectFirst('cancelled'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Microsoft' })).toBeDisabled();

    await act(async () => finishSecond(SIGNED_IN));
    expect(await screen.findByRole('button', { name: 'Clock in' })).toBeInTheDocument();
  });

  it('Cancel stops waiting and re-enables sign-in', async () => {
    mocks.authStatus.mockResolvedValue(SIGNED_OUT);
    mocks.signIn.mockReturnValue(new Promise(() => undefined));
    mocks.cancelSignIn.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Sign in with Microsoft' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.cancelSignIn).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Sign in with Microsoft' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });
});

describe('sign-in (2b.4 F2)', () => {
  it('signed out shows only the sign-in screen', async () => {
    mocks.authStatus.mockResolvedValue(SIGNED_OUT);
    render(<App />);
    expect(
      await screen.findByRole('button', { name: 'Sign in with Microsoft' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clock in' })).not.toBeInTheDocument();
  });

  it('sign in shows a waiting hint, then the home screen', async () => {
    mocks.authStatus.mockResolvedValue(SIGNED_OUT);
    let finish: (s: AuthStatus) => void = () => undefined;
    mocks.signIn.mockReturnValue(new Promise((r) => (finish = r)));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Sign in with Microsoft' }));
    expect(screen.getByRole('button', { name: 'Sign in with Microsoft' })).toBeDisabled();
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent(
      'A browser window has opened',
    );
    await act(async () => finish(SIGNED_IN));
    expect(await screen.findByRole('button', { name: 'Clock in' })).toBeInTheDocument();
    expect(screen.getByText(/Test User/)).toBeInTheDocument();
  });

  it('a failed sign-in explains why', async () => {
    mocks.authStatus.mockResolvedValue(SIGNED_OUT);
    mocks.signIn.mockRejectedValue('timed_out');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Sign in with Microsoft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in timed out');
  });

  it('the silent start-up sign-in arrives on cp://auth', async () => {
    mocks.authStatus.mockResolvedValue(SIGNED_OUT);
    render(<App />);
    await screen.findByRole('button', { name: 'Sign in with Microsoft' });
    act(() => pushAuth(SIGNED_IN));
    expect(await screen.findByRole('button', { name: 'Clock in' })).toBeInTheDocument();
  });

  it('sign out never blocks on unsent time: it says what is kept for later', async () => {
    mocks.signOut.mockResolvedValue({ ...SIGNED_OUT, unsentKept: 3 });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByText(
        'Signed out. 3 events will be sent the next time you sign in on this computer.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Microsoft' })).toBeInTheDocument();
  });

  it('the first clock-in on a computer waits for enrollment', async () => {
    mocks.clockIn.mockRejectedValue('not_enrolled');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Clock in' }));
    expect(await screen.findByText(/Connecting to CloudPunch/)).toBeInTheDocument();
  });

  it('sign out is offered only while clocked out', async () => {
    mocks.signOut.mockResolvedValue(SIGNED_OUT);
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole('button', { name: 'Sign in with Microsoft' }),
    ).toBeInTheDocument();
    unmount();

    mocks.getState.mockResolvedValue(view({ status: 'active' }));
    render(<App />);
    await screen.findByRole('button', { name: 'Clock out' });
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });
});

describe('device enrollment (2b.4 F3b)', () => {
  it('a blocking answer shows why, and clock in says the same once', async () => {
    mocks.clockIn.mockRejectedValue('no_employee');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Clock in' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => pushEnrollment({ state: 'blocked', code: 'no_employee' }));
    expect(await screen.findByRole('alert', { name: 'enrollment' })).toHaveTextContent(
      "isn't linked to an employee record",
    );
    await user.click(screen.getByRole('button', { name: 'Clock in' }));
    expect(mocks.clockIn).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('an unknown code still explains, and offline shows nothing', async () => {
    mocks.enrollmentStatus.mockResolvedValue({ state: 'blocked', code: 'keystore' });
    render(<App />);
    expect(await screen.findByRole('alert', { name: 'enrollment' })).toHaveTextContent(
      "couldn't register this computer (keystore)",
    );
    act(() => pushEnrollment({ state: 'retrying', code: 'unavailable' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is not shown while signed out', async () => {
    mocks.authStatus.mockResolvedValue(SIGNED_OUT);
    mocks.enrollmentStatus.mockResolvedValue({ state: 'blocked', code: 'no_user' });
    render(<App />);
    await screen.findByRole('button', { name: 'Sign in with Microsoft' });
    expect(screen.queryByRole('alert', { name: 'enrollment' })).not.toBeInTheDocument();
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
