import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatus, EnrollmentStatus, StateView } from './api.js';
import { App } from './App.js';
import { localDateOf, shiftDate, type DayResult } from './dayHistory.js';
import type { DaysResult } from './dayPickerModel.js';
import { light } from './ui/theme.js';

const mocks = vi.hoisted(() => ({
  getState: vi.fn<() => Promise<StateView>>(),
  clockIn: vi.fn<() => Promise<StateView>>(),
  clockOut: vi.fn<() => Promise<StateView>>(),
  installUpdateNow: vi.fn<() => Promise<void>>(),
  startBreak: vi.fn<(kind: string, planned?: number | null) => Promise<StateView>>(),
  endBreak: vi.fn<() => Promise<StateView>>(),
  markBack: vi.fn<() => Promise<StateView>>(),
  markAway: vi.fn<(reason: 'meeting' | 'training') => Promise<StateView>>(),
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
  onBreakPicker: vi.fn<(cb: () => void) => Promise<() => void>>(),
  ackLongShift: vi.fn<() => Promise<StateView>>(),
  enrollmentStatus: vi.fn<() => Promise<EnrollmentStatus>>(),
  onEnrollment: vi.fn<(cb: (s: EnrollmentStatus) => void) => Promise<() => void>>(),
  getDay: vi.fn<(date: string) => Promise<DayResult>>(),
  getDays: vi.fn<(from: string, to: string) => Promise<DaysResult>>(),
  clockInFromSignIn: vi.fn<() => Promise<StateView>>(),
  myCapabilities: vi.fn<() => Promise<string[]>>(),
  adminDepartments: vi.fn<() => Promise<{ departments: { id: string; name: string }[] }>>(),
  adminPolicyGet: vi.fn(),
  adminPeople: vi.fn(),
  adminPeopleSearch: vi.fn(),
  adminPeopleSetRoles: vi.fn(),
  adminWelcomePreview: vi.fn(),
  adminWelcomeSend: vi.fn(),
  adminPolicyPut: vi.fn(),
  dismissClockInPrompt: vi.fn<() => Promise<StateView>>(),
  explainIdle: vi.fn<(explanation: string, note: string | null) => Promise<StateView>>(),
  dismissIdleReturn: vi.fn<() => Promise<StateView>>(),
  pinWindow: vi.fn<() => Promise<boolean>>(),
  unpinWindow: vi.fn<() => Promise<boolean>>(),
  pinStatus: vi.fn<() => Promise<boolean>>(),
  onPinned: vi.fn<(cb: (pinned: boolean) => void) => Promise<() => void>>(),
  startDragging: vi.fn<() => Promise<void>>(),
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
    longDayMs: 8 * 3_600_000,
    idleSince: null,
    idleReturn: null,
    autoClockOutReason: null,
    signedInAt: null,
    clockInPrompt: false,
    breakOptions: [
      { id: 'bio', label: 'Bio break', maxMinutes: 10 },
      { id: 'meal', label: 'Meal break', maxMinutes: 60 },
      { id: 'rest', label: 'Tea break', maxMinutes: 15 },
      { id: 'personal', label: 'Personal', maxMinutes: 30 },
    ],
    offerTraining: true,
    plannedBreakMinutes: null,
    appVersion: '0.1.4',
    updateReady: null,
    ...over,
  };
}

let pushState: (v: StateView) => void = () => undefined;
let pushAuth: (s: AuthStatus) => void = () => undefined;
let pressClose: () => void = () => undefined;
let pushEnrollment: (s: EnrollmentStatus) => void = () => undefined;
let pushPinned: (p: boolean) => void = () => undefined;
let trayTakeBreak: () => void = () => undefined;

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
  mocks.pinStatus.mockResolvedValue(false);
  mocks.myCapabilities.mockResolvedValue([]);
  mocks.adminDepartments.mockResolvedValue({ departments: [] });
  mocks.adminWelcomePreview.mockResolvedValue({
    from: 'noreply@aptask.com',
    to: 'someone@aptask.com',
    cc: [],
    subject: 'Welcome to CloudPunch: how to get started',
  });
  mocks.pinWindow.mockResolvedValue(true);
  mocks.unpinWindow.mockResolvedValue(false);
  mocks.startDragging.mockResolvedValue(undefined);
  mocks.onBreakPicker.mockImplementation((cb) => {
    trayTakeBreak = cb;
    return Promise.resolve(() => undefined);
  });
  mocks.onPinned.mockImplementation((cb) => {
    pushPinned = cb;
    return Promise.resolve(() => undefined);
  });
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
    // Clock out always asks first.
    expect(mocks.clockOut).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Yes, clock out' }));
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

  it('signed out shows the logo once, under "Welcome to", with no window header', async () => {
    mocks.authStatus.mockResolvedValue(SIGNED_OUT);
    render(<App />);
    await screen.findByRole('button', { name: 'Sign in with Microsoft' });
    expect(screen.getAllByRole('img', { name: 'CloudPunch' })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Welcome to' })).toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
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
    expect(actionButtons()).toEqual(['Clock out', 'Take a break', 'In a meeting', 'In training']);
  });

  it('Training is an away tag when offered (ADR-0023)', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active' }));
    mocks.markAway.mockResolvedValue(view({ status: 'away', awayReason: 'training' }));
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await user.click(await screen.findByRole('button', { name: 'In training' }));
    expect(mocks.markAway).toHaveBeenCalledWith('training');
    unmount();
    mocks.getState.mockResolvedValue(view({ status: 'active', offerTraining: false }));
    render(<App />);
    await screen.findByRole('button', { name: 'In a meeting' });
    expect(screen.queryByRole('button', { name: 'In training' })).not.toBeInTheDocument();
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

  it('Take a break: the policy types, Back in? on the limit, then Start (ADR-0023)', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active' }));
    mocks.startBreak.mockResolvedValue(view({ status: 'on_break', breakKind: 'meal' }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Take a break' }));
    const picker = screen.getByRole('dialog', { name: 'take-a-break' });
    const types = within(within(picker).getByRole('radiogroup', { name: 'break type' }));
    expect(types.getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'Bio break',
      'Meal break',
      'Tea break',
      'Personal',
    ]);
    const backIn = within(within(picker).getByRole('radiogroup', { name: 'back in' }));
    // Bio starts on its 10-minute limit; Meal on 60.
    expect(backIn.getByRole('radio', { name: '10 min' })).toHaveAttribute('aria-checked', 'true');
    await user.click(types.getByRole('radio', { name: 'Meal break' }));
    expect(backIn.getByRole('radio', { name: '60 min' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(picker).getByRole('button', { name: 'Start break' }));
    expect(mocks.startBreak).toHaveBeenCalledWith('meal', 60);
    expect(statusText()).toBe('On a meal break');
    expect(actionButtons()).toEqual(['End break', 'Clock out']);
  });

  it('Back in 20 on a Personal break; Not sure sends no plan', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active' }));
    mocks.startBreak.mockResolvedValue(
      view({
        status: 'on_break',
        breakKind: 'personal',
        plannedBreakMinutes: 20,
        sessionStartedAt: 0,
        timeline: [
          {
            kind: 'personal_break',
            startedAt: new Date(2026, 8, 29, 10, 25).getTime(),
            endedAt: null,
            session: 1,
          },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Take a break' }));
    const picker = screen.getByRole('dialog', { name: 'take-a-break' });
    await user.click(within(picker).getByRole('radio', { name: 'Personal' }));
    await user.click(within(picker).getByRole('radio', { name: '20 min' }));
    await user.click(within(picker).getByRole('button', { name: 'Start break' }));
    expect(mocks.startBreak).toHaveBeenCalledWith('personal', 20);
    expect(await screen.findByText(/Personal · back by/)).toBeInTheDocument();

    mocks.startBreak.mockClear();
    mocks.startBreak.mockResolvedValue(view({ status: 'on_break', breakKind: 'rest' }));
    act(() => pushState(view({ status: 'active' })));
    await user.click(await screen.findByRole('button', { name: 'Take a break' }));
    const again = screen.getByRole('dialog', { name: 'take-a-break' });
    await user.click(within(again).getByRole('radio', { name: 'Tea break' }));
    await user.click(within(again).getByRole('radio', { name: 'Not sure' }));
    await user.click(within(again).getByRole('button', { name: 'Start break' }));
    expect(mocks.startBreak).toHaveBeenCalledWith('rest', null);
  });

  it('HR names show in the picker and the status (ADR-0023 §5)', async () => {
    mocks.getState.mockResolvedValue(
      view({
        status: 'on_break',
        breakKind: 'rest',
        breakOptions: [
          { id: 'bio', label: 'Bio break', maxMinutes: 10 },
          { id: 'rest', label: 'Chai break', maxMinutes: 20 },
        ],
      }),
    );
    render(<App />);
    expect(await screen.findByText('On a chai break')).toBeInTheDocument();
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
    expect(actionButtons()).toEqual(['Clock out', 'Take a break']);
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
    // Sessions and totals live under Details (the dial is the summary).
    await userEvent.setup().click(await screen.findByRole('button', { name: /Details/ }));
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
    await user.click(await screen.findByRole('button', { name: /Details/ }));
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
    await userEvent.setup().click(await screen.findByRole('button', { name: /Details/ }));
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
    expect(
      await screen.findByRole('img', { name: 'Today on a clock: nothing tracked yet' }),
    ).toBeInTheDocument();
    // Nothing to detail yet: no stats strip, no Details.
    expect(screen.queryByRole('region', { name: 'day-stats' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Details/ })).not.toBeInTheDocument();
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

describe('clock button colours (owner request)', () => {
  it('Clock in is green and Clock out is red', async () => {
    const { unmount } = render(<App />);
    expect(await screen.findByRole('button', { name: 'Clock in' })).toHaveStyle({
      background: '#15803d',
    });
    unmount();

    mocks.getState.mockResolvedValue(view({ status: 'active' }));
    const active = render(<App />);
    expect(await screen.findByRole('button', { name: 'Clock out' })).toHaveStyle({
      background: '#c62828',
    });
    active.unmount();

    // On a break, End break leads; Clock out is a red outline.
    mocks.getState.mockResolvedValue(view({ status: 'on_break', breakKind: 'bio' }));
    render(<App />);
    const out = await screen.findByRole('button', { name: 'Clock out' });
    expect(out).toHaveStyle({ color: '#c62828', border: '1px solid #c62828' });
  });
});

describe('clock out asks first (owner request)', () => {
  it('while working it offers a break instead; cancel keeps working', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active' }));
    mocks.startBreak.mockResolvedValue(view({ status: 'on_break', breakKind: 'bio' }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Clock out' }));
    const dialog = screen.getByRole('dialog', { name: 'clock-out-dialog' });
    expect(dialog).toHaveTextContent('Clock out now?');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel, keep working' }));
    expect(screen.queryByRole('dialog', { name: 'clock-out-dialog' })).not.toBeInTheDocument();
    expect(mocks.clockOut).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Clock out' }));
    await user.click(screen.getByRole('button', { name: 'Take a break instead' }));
    const picker = screen.getByRole('dialog', { name: 'take-a-break' });
    await user.click(within(picker).getByRole('button', { name: 'Start break' }));
    expect(mocks.startBreak).toHaveBeenCalledWith('bio', 10);
    expect(mocks.clockOut).not.toHaveBeenCalled();
  });

  it('on a break it just confirms', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'on_break', breakKind: 'meal' }));
    mocks.clockOut.mockResolvedValue(view());
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Clock out' }));
    expect(screen.queryByRole('button', { name: 'Take a break instead' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, clock out' }));
    expect(mocks.clockOut).toHaveBeenCalledOnce();
  });
});

describe('clocked-out text knows about the day (owner request)', () => {
  it('before any work today it invites you to start', async () => {
    render(<App />);
    expect(await screen.findByText('Not clocked in')).toBeInTheDocument();
    expect(screen.getByText('Ready to start? Clock in when you begin work.')).toBeInTheDocument();
  });

  it('after working today it shows the time worked and when you clocked out', async () => {
    const now = Date.now();
    const start = now - 3 * 3_600_000;
    const end = now - 30 * 60_000;
    mocks.getState.mockResolvedValue(
      view({
        timeline: [{ kind: 'working', startedAt: start, endedAt: end, session: 1 }],
      }),
    );
    render(<App />);
    expect(await screen.findByText('Clocked out')).toBeInTheDocument();
    expect(
      screen.getByText(/2h 30m worked today · clocked out at .+\. Clock in again to continue\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/start tracking your day/)).not.toBeInTheDocument();
  });
});

describe('day dial (owner request: your day on a clock)', () => {
  it('draws the day, shows the timer inside, and a stats strip', async () => {
    const now = Date.now();
    const MIN = 60_000;
    mocks.getState.mockResolvedValue(
      view({
        status: 'active',
        sessionStartedAt: now - 60 * MIN,
        timeline: [
          { kind: 'working', startedAt: now - 60 * MIN, endedAt: now - 20 * MIN, session: 1 },
          { kind: 'call_teams', startedAt: now - 20 * MIN, endedAt: now - 10 * MIN, session: 1 },
          { kind: 'working', startedAt: now - 10 * MIN, endedAt: null, session: 1 },
        ],
      }),
    );
    render(<App />);
    const dial = await screen.findByRole('img', { name: /Today on a clock: Working, Teams call/ });
    expect(dial.querySelectorAll('[data-arc]')).toHaveLength(3);
    // Seconds ring: 60 min into the session → the minute mark (or its first seconds).
    const ring = within(dial).getByLabelText('led-ring');
    expect(['60', '1', '2']).toContain(ring.getAttribute('data-lit'));
    expect(ring).toHaveAttribute('data-band', 'normal');
    expect(within(dial).getByLabelText('needle')).toBeInTheDocument();
    const status = screen.getByRole('region', { name: 'current-status' });
    // The seven-segment timer keeps its text for screen readers.
    expect(within(status).getByLabelText('session-timer')).toHaveTextContent(/^01:00:0\d$/);
    const stats = screen.getByRole('region', { name: 'day-stats' });
    expect(stats).toHaveTextContent('1h 00mWorked');
    expect(stats).toHaveTextContent('10mCalls');
    expect(stats).toHaveTextContent('0mBreaks');
  });
});

describe('dial face tint (owner request)', () => {
  const tintOf = async (): Promise<string | null> =>
    (await screen.findByLabelText('dial-face')).getAttribute('data-tint');

  it('green while clocked in, amber on a break, grey when clocked out', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active', sessionStartedAt: Date.now() }));
    const { unmount } = render(<App />);
    expect(await tintOf()).toBe(light.tint.working);
    act(() => pushState(view({ status: 'on_break', breakKind: 'bio', sessionStartedAt: 1 })));
    expect(await tintOf()).toBe(light.tint.break);
    act(() => pushState(view()));
    expect(await tintOf()).toBe(light.tint.off);
    unmount();
  });
});

describe('past days (ADR-0016)', () => {
  /** ISO with this computer's own offset, as the backend returns it. */
  function iso(date: string, hhmm: string): string {
    const local = new Date(`${date}T${hhmm}:00`);
    const off = -local.getTimezoneOffset();
    const abs = Math.abs(off);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${date}T${hhmm}:00.000${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }
  const today = localDateOf(Date.now());
  const yesterday = shiftDate(today, -1);
  function result(over: Partial<DayResult> = {}, device = 'this-pc', tz = 'Local/Zone'): DayResult {
    return {
      day: {
        date: yesterday,
        sessions: [
          {
            session_id: 's1',
            device_id: device,
            tz_iana: tz,
            clock_in: iso(yesterday, '09:00'),
            clock_out: iso(yesterday, '17:00'),
            close_reason: 'user_clock_out',
            reconstructed: false,
            open: false,
            segments: [
              {
                kind: 'working',
                started_at: iso(yesterday, '09:00'),
                ended_at: iso(yesterday, '12:30'),
              },
              {
                kind: 'meal_break',
                started_at: iso(yesterday, '12:30'),
                ended_at: iso(yesterday, '13:00'),
              },
              {
                kind: 'working',
                started_at: iso(yesterday, '13:00'),
                ended_at: iso(yesterday, '17:00'),
              },
            ],
          },
        ],
      },
      thisDevice: 'this-pc',
      stale: false,
      ...over,
    };
  }

  it('steps back to yesterday and shows that day on the dial, then returns to today', async () => {
    mocks.getDay.mockResolvedValue(result());
    const user = userEvent.setup();
    render(<App />);
    const nav = await screen.findByLabelText('day-navigation');
    expect(within(nav).getByRole('button', { name: 'Next day' })).toBeDisabled();
    await user.click(within(nav).getByRole('button', { name: 'Previous day' }));
    expect(mocks.getDay).toHaveBeenCalledWith(yesterday);
    expect(await screen.findByLabelText('past-worked')).toHaveTextContent('7h 30m');
    const status = screen.getByRole('region', { name: 'current-status' });
    // A past day: seconds ring dark, no needle.
    expect(within(status).getByLabelText('led-ring')).toHaveAttribute('data-lit', '0');
    expect(within(status).queryByLabelText('needle')).not.toBeInTheDocument();
    expect(status).toHaveTextContent('09:00 – 17:00');
    expect(
      within(status).getByRole('img', { name: /Yesterday on a clock: Working, Meal break/ }),
    ).toBeInTheDocument();
    // No live timer or clocked-out hint on a past day.
    expect(within(status).queryByLabelText('session-timer')).not.toBeInTheDocument();
    expect(status).not.toHaveTextContent('Ready to start?');
    expect(screen.getByRole('region', { name: 'day-stats' })).toHaveTextContent('30mBreaks');
    // A past day has no clock or break actions (owner request).
    expect(screen.queryByRole('button', { name: 'Clock in' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to today' })).toBeInTheDocument();

    await user.click(within(nav).getByRole('button', { name: 'Next day' }));
    expect(await screen.findByRole('img', { name: /Today on a clock/ })).toBeInTheDocument();
    expect(within(nav).getByLabelText('day-shown')).toHaveTextContent('Today');
  });

  it('says where the day was recorded when it was another computer or zone', async () => {
    mocks.getDay.mockResolvedValue(result({ stale: true }, 'laptop-2', 'Asia/Kolkata'));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Previous day' }));
    const status = screen.getByRole('region', { name: 'current-status' });
    expect(
      await within(status).findByText('Includes time from another computer'),
    ).toBeInTheDocument();
    expect(status).toHaveTextContent('Offline · showing what was loaded earlier');
  });

  it('offline with nothing loaded explains instead', async () => {
    mocks.getDay.mockRejectedValue('offline');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Previous day' }));
    expect(await screen.findByText(/Past days show when you're online/)).toBeInTheDocument();
  });

  it('goes back at most 30 days', async () => {
    mocks.getDay.mockResolvedValue(result());
    const user = userEvent.setup();
    render(<App />);
    const prev = await screen.findByRole('button', { name: 'Previous day' });
    for (let i = 0; i < 30; i += 1) await user.click(prev);
    expect(prev).toBeDisabled();
    expect(mocks.getDay).toHaveBeenLastCalledWith(shiftDate(today, -30));
  });
  it('a past day hides the long-shift banner; it is back on today', async () => {
    mocks.getState.mockResolvedValue(
      view({ status: 'active', sessionStartedAt: Date.now() - 10 * 3_600_000, longShift: true }),
    );
    mocks.getDay.mockResolvedValue(result());
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('alertdialog', { name: 'long-shift' });
    await user.click(screen.getByRole('button', { name: 'Previous day' }));
    await screen.findByLabelText('past-worked');
    expect(screen.queryByRole('alertdialog', { name: 'long-shift' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to today' }));
    expect(await screen.findByRole('alertdialog', { name: 'long-shift' })).toBeInTheDocument();
  });

  it('clocked in on a past day: only Back to today, showing the live status', async () => {
    mocks.getState.mockResolvedValue(
      view({ status: 'on_break', breakKind: 'meal', sessionStartedAt: Date.now() - 3_600_000 }),
    );
    mocks.getDay.mockResolvedValue(result());
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Previous day' }));
    const actions = screen.getByRole('region', { name: 'actions' });
    for (const name of ['Clock out', 'End break', 'Bio break', 'Meal break', 'In a meeting']) {
      expect(within(actions).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(within(actions).getByLabelText('live-status')).toHaveTextContent(
      /On a meal break · 01:00:0\d/,
    );
    await user.click(within(actions).getByRole('button', { name: 'Back to today' }));
    expect(await screen.findByRole('button', { name: 'End break' })).toBeInTheDocument();
    expect(screen.getByLabelText('day-shown')).toHaveTextContent('Today');
  });

  describe('day picker', () => {
    const H = 3_600_000;
    function days(entries: [number, number][], stale = false): DaysResult {
      return {
        days: {
          days: entries.map(([ago, hours]) => ({
            date: shiftDate(today, -ago),
            sessions: 1,
            worked_ms: hours * H,
            calls_ms: 0,
            meetings_ms: 0,
            breaks_ms: 0,
            prompt_ms: 0,
          })),
        },
        stale,
      };
    }
    const cell = (date: string): HTMLElement => {
      const el = document.querySelector<HTMLElement>(`[data-date="${date}"]`);
      if (!el) throw new Error(`no cell ${date}`);
      return el;
    };

    it('opens from the date, shades worked days, greys empty ones, and jumps on a tap', async () => {
      mocks.getDays.mockResolvedValue(
        days([
          [1, 7.5],
          [3, 9],
        ]),
      );
      mocks.getDay.mockResolvedValue(result());
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByLabelText('day-shown'));
      const picker = screen.getByRole('dialog', { name: 'day-picker' });
      expect(mocks.getDays).toHaveBeenCalledWith(shiftDate(today, -30), today);
      expect(await within(picker).findByLabelText('lookback-summary')).toHaveTextContent(
        '2 days · 16h 30m · avg 8h 15m',
      );
      expect(cell(shiftDate(today, -2))).toHaveAttribute('aria-disabled', 'true');
      expect(cell(today)).toHaveAttribute('aria-disabled', 'false');
      expect(cell(shiftDate(today, -3))).toHaveAccessibleName(/· 9h 00m$/);
      // The dial is replaced while the picker is open.
      expect(screen.queryByRole('img', { name: /Today on a clock/ })).not.toBeInTheDocument();

      // Hover: the day's hours, a breakdown, and a hint to click.
      await user.hover(cell(shiftDate(today, -3)));
      const tip = screen.getByRole('tooltip', { name: 'day-tooltip' });
      expect(tip).toHaveTextContent('9h 00m worked');
      expect(tip).toHaveTextContent('1 session');
      expect(tip).toHaveTextContent('Click for details');
      // An empty day says so, and a click does nothing.
      await user.hover(cell(shiftDate(today, -2)));
      expect(screen.getByRole('tooltip')).toHaveTextContent('Nothing tracked');
      expect(screen.getByRole('tooltip')).not.toHaveTextContent('Click for details');
      await user.click(cell(shiftDate(today, -2)));
      expect(screen.getByRole('dialog', { name: 'day-picker' })).toBeInTheDocument();

      // A click opens that day with its details.
      await user.click(cell(yesterday));
      expect(screen.queryByRole('dialog', { name: 'day-picker' })).not.toBeInTheDocument();
      expect(mocks.getDay).toHaveBeenCalledWith(yesterday);
      expect(await screen.findByLabelText('past-worked')).toHaveTextContent('7h 30m');
      expect(screen.getByRole('region', { name: 'past-day' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Hide details' })).toBeInTheDocument();
    });

    it('moves with the arrow keys, skipping empty days, and closes on Escape', async () => {
      mocks.getDays.mockResolvedValue(
        days([
          [1, 4],
          [8, 6],
        ]),
      );
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByLabelText('day-shown'));
      await screen.findByText(/2 days/);
      expect(cell(today)).toHaveFocus();
      await user.keyboard('{ArrowLeft}');
      expect(cell(yesterday)).toHaveFocus();
      expect(screen.getByRole('tooltip')).toHaveTextContent('Yesterday4h 00m worked');
      // Days 2–7 ago are empty: the next step left lands on 8 days ago.
      await user.keyboard('{ArrowLeft}');
      expect(cell(shiftDate(today, -8))).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: 'day-picker' })).not.toBeInTheDocument();
    });

    it('offline: every day stays pickable and says why there is no shading', async () => {
      mocks.getDays.mockRejectedValue('offline');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByLabelText('day-shown'));
      expect(
        await screen.findByText(/Offline · hours show when you're online/),
      ).toBeInTheDocument();
      expect(cell(shiftDate(today, -30))).toHaveAttribute('aria-disabled', 'false');
      expect(document.querySelector(`[data-date="${shiftDate(today, -31)}"]`)).toBeNull();
    });
  });
});

describe('pinned mini strip (ADR-0017)', () => {
  it('the header pin shrinks to the strip; ⤢ goes back', async () => {
    mocks.getState.mockResolvedValue(
      view({ status: 'active', sessionStartedAt: Date.now() - 3_600_000 }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Pin to desktop' }));
    expect(mocks.pinWindow).toHaveBeenCalledOnce();
    const strip = await screen.findByRole('region', { name: 'pinned-strip' });
    expect(within(strip).getByLabelText('strip-timer')).toHaveTextContent(/01:00:0\d/);
    expect(within(strip).getByLabelText('strip-status')).toHaveTextContent('Clocked in');
    // Nothing of the full window, and no Clock out on the strip.
    expect(screen.queryByRole('region', { name: 'current-status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clock out' })).not.toBeInTheDocument();

    await user.click(within(strip).getByRole('button', { name: 'Unpin' }));
    expect(mocks.unpinWindow).toHaveBeenCalledOnce();
    expect(await screen.findByRole('region', { name: 'current-status' })).toBeInTheDocument();
  });

  it('follows the agent: minimising pins it; double-click unpins', async () => {
    mocks.getState.mockResolvedValue(view());
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Clock in' });
    act(() => pushPinned(true));
    const strip = screen.getByRole('region', { name: 'pinned-strip' });
    expect(strip).toHaveTextContent('Not clocked in · worked today');
    await user.dblClick(within(strip).getByLabelText('strip-timer'));
    expect(mocks.unpinWindow).toHaveBeenCalled();
  });

  it('one contextual action; hover offers the break choice', async () => {
    mocks.getState.mockResolvedValue(
      view({ status: 'active', sessionStartedAt: Date.now() - 60_000 }),
    );
    mocks.startBreak.mockResolvedValue(
      view({ status: 'on_break', breakKind: 'meal', sessionStartedAt: Date.now() - 60_000 }),
    );
    mocks.pinStatus.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<App />);
    const strip = await screen.findByRole('region', { name: 'pinned-strip' });
    await user.hover(strip);
    expect(within(strip).getByLabelText('strip-totals')).toHaveTextContent('Today ·');
    // The picker needs room: Take a break goes back to the full window.
    await user.click(within(strip).getByRole('button', { name: 'Take a break' }));
    expect(mocks.unpinWindow).toHaveBeenCalled();
    const picker = await screen.findByRole('dialog', { name: 'take-a-break' });
    await user.click(within(picker).getByRole('radio', { name: 'Meal break' }));
    await user.click(within(picker).getByRole('button', { name: 'Start break' }));
    expect(mocks.startBreak).toHaveBeenCalledWith('meal', 60);
  });

  it('hover offers In a meeting while clocked in, but not during a call', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active', sessionStartedAt: Date.now() }));
    mocks.markAway.mockResolvedValue(
      view({ status: 'away', awayReason: 'meeting', sessionStartedAt: Date.now() }),
    );
    mocks.pinStatus.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<App />);
    const strip = await screen.findByRole('region', { name: 'pinned-strip' });
    await user.hover(strip);
    await user.click(within(strip).getByRole('button', { name: 'In a meeting' }));
    expect(mocks.markAway).toHaveBeenCalledWith('meeting');
    expect(await within(strip).findByRole('button', { name: "I'm back" })).toBeInTheDocument();

    act(() =>
      pushState(view({ status: 'on_call', callType: 'teams', sessionStartedAt: Date.now() })),
    );
    expect(within(strip).getByRole('button', { name: 'Take a break' })).toBeInTheDocument();
    expect(within(strip).queryByRole('button', { name: 'In a meeting' })).not.toBeInTheDocument();
  });

  it('dragging moves the window only after the mouse travels', async () => {
    mocks.getState.mockResolvedValue(view());
    mocks.pinStatus.mockResolvedValue(true);
    render(<App />);
    const strip = await screen.findByRole('region', { name: 'pinned-strip' });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.mouseDown(strip, { button: 0, screenX: 100, screenY: 100 });
    fireEvent.mouseMove(strip, { buttons: 1, screenX: 101, screenY: 100 });
    expect(mocks.startDragging).not.toHaveBeenCalled();
    fireEvent.mouseMove(strip, { buttons: 1, screenX: 106, screenY: 100 });
    expect(mocks.startDragging).toHaveBeenCalledOnce();
  });

  it('closing while pinned unpins so the question can be asked', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active', sessionStartedAt: Date.now() }));
    mocks.pinStatus.mockResolvedValue(true);
    render(<App />);
    await screen.findByRole('region', { name: 'pinned-strip' });
    act(() => pressClose());
    expect(mocks.unpinWindow).toHaveBeenCalled();
    act(() => pushPinned(false));
    expect(screen.getByRole('dialog', { name: 'close-dialog' })).toBeInTheDocument();
  });
});

describe('end-of-day summary (ADR-0013 §8)', () => {
  const H = 3_600_000;
  function day(workedHours: number, status: StateView['status'] = 'active'): StateView {
    const now = Date.now();
    const start = now - workedHours * H - 30 * 60_000;
    return view({
      status,
      sessionStartedAt: status === 'clocked_out' ? null : start,
      timeline: [
        { kind: 'working', startedAt: start, endedAt: now - 30 * 60_000 - H, session: 1 },
        { kind: 'meal_break', startedAt: now - 30 * 60_000 - H, endedAt: now - H, session: 1 },
        { kind: 'call_teams', startedAt: now - H, endedAt: now - 30 * 60_000, session: 1 },
        {
          kind: 'working',
          startedAt: now - 30 * 60_000,
          endedAt: status === 'clocked_out' ? now : null,
          session: 1,
        },
      ],
    });
  }

  it('a long day: Trip complete with the totals, and the needle parks', async () => {
    mocks.getState.mockResolvedValue(day(8.5));
    render(<App />);
    await screen.findByRole('button', { name: 'Clock out' });
    act(() => pushState(day(8.5, 'clocked_out')));
    const trip = await screen.findByRole('dialog', { name: 'trip-complete' });
    expect(within(trip).getByLabelText('odometer')).toHaveTextContent('08:30');
    expect(within(trip).getByLabelText('trip-line')).toHaveTextContent(
      '8h 30m worked · 30m break · 1 call',
    );
    expect(trip).toHaveTextContent('See you tomorrow');
    expect(screen.getByLabelText('needle')).toHaveAttribute('data-parked', 'true');
    // Clocking in again clears it.
    act(() => pushState(day(8.5)));
    expect(screen.queryByRole('dialog', { name: 'trip-complete' })).not.toBeInTheDocument();
  });

  it('a shorter day: a quiet summary, no animation', async () => {
    mocks.getState.mockResolvedValue(day(3));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Clock out' });
    act(() => pushState(day(3, 'clocked_out')));
    const card = await screen.findByRole('status', { name: 'day-summary' });
    expect(card).toHaveTextContent('Clocked out · 3h 00m worked · 30m break · 1 call today');
    expect(screen.queryByRole('dialog', { name: 'trip-complete' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('needle')).toHaveAttribute('data-parked', 'false');
    await user.click(within(card).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status', { name: 'day-summary' })).not.toBeInTheDocument();
  });

  it('the long day follows policy', async () => {
    mocks.getState.mockResolvedValue({ ...day(3), longDayMs: 2 * H });
    render(<App />);
    await screen.findByRole('button', { name: 'Clock out' });
    act(() => pushState({ ...day(3, 'clocked_out'), longDayMs: 2 * H }));
    expect(await screen.findByRole('dialog', { name: 'trip-complete' })).toBeInTheDocument();
  });

  it('not after the idle auto clock-out, and not on first load', async () => {
    mocks.getState.mockResolvedValue(day(9, 'clocked_out'));
    render(<App />);
    await screen.findByRole('button', { name: 'Clock in' });
    expect(screen.queryByRole('dialog', { name: 'trip-complete' })).not.toBeInTheDocument();
    act(() => pushState(day(9)));
    act(() => pushState({ ...day(9, 'clocked_out'), autoClockedOutAt: Date.now() }));
    expect(screen.queryByRole('dialog', { name: 'trip-complete' })).not.toBeInTheDocument();
  });

  it('sign-out shows the day on the sign-in screen', async () => {
    mocks.getState.mockResolvedValue(day(9, 'clocked_out'));
    mocks.signOut.mockResolvedValue(SIGNED_OUT);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    const trip = await screen.findByRole('dialog', { name: 'trip-complete' });
    expect(trip).toHaveTextContent('Signed out · See you tomorrow');
  });
});

describe('break during a call asks first (owner request)', () => {
  const onCall = (): StateView =>
    view({ status: 'on_call', callType: 'teams', sessionStartedAt: Date.now() - 60_000 });

  it('the picker says what happens to the call; Stay on the call does nothing', async () => {
    mocks.getState.mockResolvedValue(onCall());
    mocks.startBreak.mockResolvedValue(view({ status: 'on_break', breakKind: 'bio' }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Take a break' }));
    const dialog = screen.getByRole('dialog', { name: 'take-a-break' });
    expect(dialog).toHaveTextContent("You're on a Teams call");
    expect(dialog).toHaveTextContent('it counts as a call again');
    await user.click(within(dialog).getByRole('button', { name: 'Stay on the call' }));
    expect(mocks.startBreak).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'take-a-break' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Take a break' }));
    await user.click(screen.getByRole('radio', { name: 'Meal break' }));
    await user.click(screen.getByRole('button', { name: "Start break: I've left the call" }));
    expect(mocks.startBreak).toHaveBeenCalledWith('meal', 60);
  });

  it('not on a call: no call wording', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'active', sessionStartedAt: Date.now() }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Take a break' }));
    const dialog = screen.getByRole('dialog', { name: 'take-a-break' });
    expect(dialog).not.toHaveTextContent("You're on a");
    expect(within(dialog).getByRole('button', { name: 'Start break' })).toBeInTheDocument();
  });

  it('the tray opens the picker in the window, and it goes when the break starts elsewhere', async () => {
    mocks.getState.mockResolvedValue(onCall());
    render(<App />);
    await screen.findByRole('button', { name: 'Take a break' });
    act(() => trayTakeBreak());
    expect(screen.getByRole('dialog', { name: 'take-a-break' })).toHaveTextContent(
      "You're on a Teams call",
    );
    expect(mocks.unpinWindow).toHaveBeenCalled();
    act(() =>
      pushState(view({ status: 'on_break', breakKind: 'bio', sessionStartedAt: Date.now() })),
    );
    expect(screen.queryByRole('dialog', { name: 'take-a-break' })).not.toBeInTheDocument();
  });

  it('clock out on a call says the call time is kept', async () => {
    mocks.getState.mockResolvedValue(onCall());
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Clock out' }));
    expect(screen.getByRole('dialog', { name: 'clock-out-dialog' })).toHaveTextContent(
      "You're on a Teams call. Clocking out ends your shift now",
    );
  });

  it('the pinned strip opens the full window, which asks', async () => {
    mocks.getState.mockResolvedValue(onCall());
    mocks.startBreak.mockResolvedValue(view({ status: 'on_break', breakKind: 'bio' }));
    mocks.pinStatus.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<App />);
    const strip = await screen.findByRole('region', { name: 'pinned-strip' });
    await user.hover(strip);
    await user.click(within(strip).getByRole('button', { name: 'Take a break' }));
    const ask = await screen.findByRole('dialog', { name: 'take-a-break' });
    expect(ask).toHaveTextContent("You're on a Teams call");
    expect(mocks.startBreak).not.toHaveBeenCalled();
    await user.click(within(ask).getByRole('button', { name: "Start break: I've left the call" }));
    expect(mocks.startBreak).toHaveBeenCalledWith('bio', 10);
  });
});

describe('version and Restart to update (owner request)', () => {
  it('shows the version, and Restart to update only while clocked out', async () => {
    mocks.getState.mockResolvedValue(view({ updateReady: '0.1.5' }));
    mocks.installUpdateNow.mockRejectedValueOnce('not_clocked_out');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByLabelText('app-version')).toHaveTextContent('CloudPunch 0.1.4');
    const banner = screen.getByRole('status', { name: 'update-ready' });
    expect(banner).toHaveTextContent('CloudPunch 0.1.5 is ready.');
    await user.click(within(banner).getByRole('button', { name: 'Restart to update' }));
    expect(mocks.installUpdateNow).toHaveBeenCalledOnce();
    expect(
      await within(banner).findByText('Clock out first, then restart to update.'),
    ).toBeInTheDocument();

    act(() => pushState(view({ status: 'active', updateReady: '0.1.5' })));
    expect(screen.queryByRole('status', { name: 'update-ready' })).not.toBeInTheDocument();
  });
});

describe('logged idle (ADR-0018)', () => {
  const MIN = 60_000;

  it('shows idle since when, and only Clock out', async () => {
    const since = Date.now() - 10 * MIN;
    mocks.getState.mockResolvedValue(
      view({
        status: 'idle',
        idleSince: since,
        sessionStartedAt: since - 60 * MIN,
        timeline: [
          { kind: 'working', startedAt: since - 60 * MIN, endedAt: since, session: 1 },
          { kind: 'idle', startedAt: since, endedAt: null, session: 1 },
        ],
      }),
    );
    render(<App />);
    const status = await screen.findByRole('region', { name: 'current-status' });
    const d = new Date(since);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(status).toHaveTextContent(`Idle since ${hhmm}`);
    const actions = screen.getByRole('region', { name: 'actions' });
    expect(
      within(actions)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Clock out']);
    // The trip meter shows idle apart from worked time.
    const stats = screen.getByRole('region', { name: 'day-stats' });
    expect(stats).toHaveTextContent('1h 00mWorked');
    expect(stats).toHaveTextContent('10mIdle');
  });

  it('welcome back: pick what you were doing, add a note, send', async () => {
    const until = Date.now();
    const since = until - 23 * MIN;
    mocks.getState.mockResolvedValue(
      view({ status: 'active', sessionStartedAt: since - MIN, idleReturn: { since, until } }),
    );
    mocks.explainIdle.mockResolvedValue(view({ status: 'active', sessionStartedAt: since - MIN }));
    const user = userEvent.setup();
    render(<App />);
    const dialog = await screen.findByRole('dialog', { name: 'idle-return' });
    expect(dialog).toHaveTextContent('(23 min). What were you doing?');
    const send = within(dialog).getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await user.click(within(dialog).getByRole('radio', { name: 'In a meeting' }));
    await user.type(within(dialog).getByLabelText('idle-note'), '  standup  ');
    await user.click(send);
    expect(mocks.explainIdle).toHaveBeenCalledWith('meeting', 'standup');
    expect(screen.queryByRole('dialog', { name: 'idle-return' })).not.toBeInTheDocument();
  });

  it('welcome back can be skipped', async () => {
    const until = Date.now();
    mocks.getState.mockResolvedValue(
      view({
        status: 'active',
        sessionStartedAt: until - 60 * MIN,
        idleReturn: { since: until - 5 * MIN, until },
      }),
    );
    mocks.dismissIdleReturn.mockResolvedValue(
      view({ status: 'active', sessionStartedAt: until - 60 * MIN }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    expect(mocks.dismissIdleReturn).toHaveBeenCalledOnce();
    expect(mocks.explainIdle).not.toHaveBeenCalled();
  });

  it('the idle cap explains the clock-out', async () => {
    mocks.getState.mockResolvedValue(
      view({ autoClockedOutAt: Date.UTC(2026, 8, 28, 14, 5), autoClockOutReason: 'idle_cap' }),
    );
    render(<App />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      /after a long idle stretch\. The idle time is kept for your manager to review/,
    );
  });
});

describe('daily clock-in popup (ADR-0018 §4)', () => {
  const hhmm = (ms: number): string => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  it('offers to start from the computer sign-in, or now, or not now', async () => {
    const signedInAt = Date.now() - 25 * 60_000;
    mocks.getState.mockResolvedValue(view({ clockInPrompt: true, signedInAt }));
    mocks.clockInFromSignIn.mockResolvedValue(
      view({ status: 'active', sessionStartedAt: signedInAt }),
    );
    const user = userEvent.setup();
    render(<App />);
    const prompt = await screen.findByRole('dialog', { name: 'clock-in-prompt' });
    expect(prompt).toHaveTextContent(`You signed in to your computer at ${hhmm(signedInAt)}`);
    expect(prompt).not.toHaveTextContent('Good morning');
    expect(within(prompt).getByRole('button', { name: 'Clock in now' })).toBeInTheDocument();
    expect(within(prompt).getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    await user.click(
      within(prompt).getByRole('button', { name: `Clock in from ${hhmm(signedInAt)}` }),
    );
    expect(mocks.clockInFromSignIn).toHaveBeenCalledOnce();
    expect(mocks.clockIn).not.toHaveBeenCalled();
  });

  it('without a usable sign-in time it just offers Clock in; Not now closes it', async () => {
    mocks.getState.mockResolvedValue(view({ clockInPrompt: true }));
    mocks.dismissClockInPrompt.mockResolvedValue(view());
    const user = userEvent.setup();
    render(<App />);
    const prompt = await screen.findByRole('dialog', { name: 'clock-in-prompt' });
    expect(prompt).toHaveTextContent('Ready to start your day?');
    expect(within(prompt).queryByRole('button', { name: /Clock in from/ })).not.toBeInTheDocument();
    await user.click(within(prompt).getByRole('button', { name: 'Not now' }));
    expect(mocks.dismissClockInPrompt).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'clock-in-prompt' })).not.toBeInTheDocument();
  });

  it('the home screen also offers the sign-in start under Clock in', async () => {
    const signedInAt = Date.now() - 10 * 60_000;
    mocks.getState.mockResolvedValue(view({ signedInAt }));
    mocks.clockInFromSignIn.mockResolvedValue(
      view({ status: 'active', sessionStartedAt: signedInAt }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole('button', {
        name: `or clock in from ${hhmm(signedInAt)}, when you signed in`,
      }),
    );
    expect(mocks.clockInFromSignIn).toHaveBeenCalledOnce();
  });
});

describe('Settings for HR and Administrators (ADR-0018 §5)', () => {
  const DEPT = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const effective = {
    idle: { threshold_seconds: 120, grace_seconds: 30, max_idle_minutes: 120 },
    reminders: {
      clock_in_prompt_at: '08:00',
      clock_in_prompt_tz: 'America/New_York',
      long_day_hours: 8,
      long_shift_hours: 9,
    },
  };

  it('is not offered to employees', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Clock in' });
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('an Administrator edits the company-wide values; other override keys are kept', async () => {
    mocks.myCapabilities.mockResolvedValue(['admin.policy.write']);
    mocks.adminDepartments.mockResolvedValue({ departments: [{ id: DEPT, name: 'Recruiting' }] });
    mocks.adminPolicyGet.mockResolvedValue({
      override: { document: { break: { bio: { max_minutes: 15 } } } },
      // The effective policy includes the override.
      effective: { policy: { ...effective, break: { bio: { max_minutes: 15 } } } },
    });
    mocks.adminPolicyPut.mockImplementation((_s: string, _i: string | null, document: unknown) =>
      Promise.resolve({ override: { document }, effective: { policy: effective } }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const settings = screen.getByRole('region', { name: 'settings' });
    expect(mocks.adminPolicyGet).toHaveBeenCalledWith('global', null);
    const prompt = await within(settings).findByLabelText('idle-prompt');
    expect(prompt).toHaveValue(2);
    const save = within(settings).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await user.clear(prompt);
    await user.type(prompt, '3');
    await user.click(within(settings).getByLabelText('idle-cap-on'));
    await user.type(within(settings).getByLabelText('reason'), 'pilot feedback');
    await user.click(save);
    expect(mocks.adminPolicyPut).toHaveBeenCalledWith(
      'global',
      null,
      expect.objectContaining({
        idle: { threshold_seconds: 180, grace_seconds: 30, max_idle_minutes: null },
        reminders: {
          clock_in_prompt_at: '08:00',
          clock_in_prompt_tz: 'America/New_York',
          long_day_hours: 8,
          long_shift_hours: 9,
        },
      }),
      'pilot feedback',
    );
    const sent = mocks.adminPolicyPut.mock.calls[0]?.[2] as { break: Record<string, unknown> };
    expect(sent.break['bio']).toMatchObject({ max_minutes: 15, enabled: true });
    expect(await within(settings).findByRole('status')).toHaveTextContent('within 15 minutes');
  });

  it('Breaks: rename, switch off and re-rule a type; all off blocks Save (ADR-0023 §5)', async () => {
    mocks.myCapabilities.mockResolvedValue(['admin.policy.write']);
    mocks.adminPolicyGet.mockResolvedValue({ override: null, effective: { policy: effective } });
    mocks.adminPolicyPut.mockImplementation((_s: string, _i: string | null, document: unknown) =>
      Promise.resolve({ override: { document }, effective: { policy: effective } }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const settings = screen.getByRole('region', { name: 'settings' });
    const name = await within(settings).findByLabelText('rest-label');
    expect(name).toHaveValue('Tea break');
    await user.clear(name);
    await user.type(name, 'Chai break');
    await user.selectOptions(within(settings).getByLabelText('rest-pay'), 'paid');
    await user.click(within(settings).getByLabelText('personal-enabled'));
    await user.click(within(settings).getByLabelText('offer-training'));
    await user.click(within(settings).getByRole('button', { name: 'Save' }));
    const sent = mocks.adminPolicyPut.mock.calls[0]?.[2] as {
      break: Record<string, Record<string, unknown>>;
      away: Record<string, unknown>;
    };
    expect(sent.break['rest']).toEqual({
      enabled: true,
      label: 'Chai break',
      pay: 'paid',
      max_minutes: 15,
    });
    expect(sent.break['personal']?.['enabled']).toBe(false);
    expect(sent.away).toEqual({ offer_training: false });

    for (const id of ['bio', 'meal', 'rest']) {
      await user.click(within(settings).getByLabelText(`${id}-enabled`));
    }
    expect(within(settings).getByText('Keep at least one break type on')).toBeInTheDocument();
    expect(within(settings).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('HR edits a department, and bad values block Save', async () => {
    mocks.myCapabilities.mockResolvedValue(['hr.policy.write']);
    mocks.adminDepartments.mockResolvedValue({ departments: [{ id: DEPT, name: 'Recruiting' }] });
    mocks.adminPolicyGet.mockResolvedValue({ override: null, effective: { policy: effective } });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const settings = screen.getByRole('region', { name: 'settings' });
    const longDay = await within(settings).findByLabelText('long-day');
    expect(mocks.adminPolicyGet).toHaveBeenCalledWith('department', DEPT);
    expect(
      within(settings).queryByRole('option', { name: /company-wide/ }),
    ).not.toBeInTheDocument();
    await user.clear(longDay);
    await user.type(longDay, '20');
    expect(settings).toHaveTextContent('Between 4 and 16 hours');
    expect(within(settings).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('a refused save says why', async () => {
    mocks.myCapabilities.mockResolvedValue(['admin.policy.write']);
    mocks.adminPolicyGet.mockResolvedValue({ override: null, effective: { policy: effective } });
    mocks.adminPolicyPut.mockRejectedValue('forbidden');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const settings = screen.getByRole('region', { name: 'settings' });
    const wait = await within(settings).findByLabelText('prompt-wait');
    await user.clear(wait);
    await user.type(wait, '45');
    await user.click(within(settings).getByRole('button', { name: 'Save' }));
    expect(await within(settings).findByRole('alert')).toHaveTextContent(
      "Your role can't change this.",
    );
  });
});

describe('People (ADR-0020)', () => {
  const FARHEEN = '8afe98ae-5b43-4c12-86c5-b4473225f7f0';
  const NILESH = '026e2734-c0e4-4d70-9d19-6beafa588629';

  it('an Administrator adds someone from the directory with a role', async () => {
    mocks.myCapabilities.mockResolvedValue(['admin.role.assign', 'admin.policy.write']);
    mocks.adminPolicyGet.mockResolvedValue({ override: null, effective: { policy: {} } });
    mocks.adminPeople.mockResolvedValue({
      people: [
        {
          oid: NILESH,
          name: 'Nilesh Darekar',
          roles: ['Employee', 'Administrator'],
          has_employee_record: true,
        },
      ],
    });
    mocks.adminPeopleSearch.mockResolvedValue({
      users: [{ oid: FARHEEN, name: 'Farheen Khanam', email: 'farheen@aptask.com' }],
    });
    mocks.adminPeopleSetRoles.mockResolvedValue({ changed: true });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('tab', { name: 'People' }));
    const people = screen.getByRole('region', { name: 'people' });
    expect(await within(people).findByText('Employee · Administrator')).toBeInTheDocument();
    await user.type(within(people).getByLabelText('people-search'), 'farh');
    await user.click(await within(people).findByRole('button', { name: /Farheen Khanam/ }));
    const roles = within(people).getByRole('group', { name: 'edit-roles' });
    // A new person starts with Employee ticked.
    expect(within(roles).getByLabelText('role-Employee')).toBeChecked();
    expect(within(roles).getByLabelText('role-Administrator')).toBeEnabled();
    await user.click(within(roles).getByLabelText('role-Manager'));
    await user.type(within(roles).getByLabelText('people-reason'), 'pilot');
    await user.click(within(roles).getByRole('button', { name: 'Save' }));
    expect(mocks.adminPeopleSetRoles).toHaveBeenCalledWith(
      FARHEEN,
      ['Employee', 'Manager'],
      'pilot',
    );
    expect(await within(people).findByRole('status')).toHaveTextContent(
      'Farheen Khanam gets the new roles at their next sign-in',
    );
  });

  it('HR sees People only, and can tick Employee and Manager only', async () => {
    mocks.myCapabilities.mockResolvedValue(['hr.employee.write']);
    mocks.adminPeople.mockResolvedValue({
      people: [
        { oid: FARHEEN, name: 'Farheen Khanam', roles: ['Employee'], has_employee_record: true },
      ],
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(screen.queryByRole('tab', { name: 'Rules' })).not.toBeInTheDocument();
    const people = screen.getByRole('region', { name: 'people' });
    await user.click(await within(people).findByRole('button', { name: /Farheen Khanam/ }));
    const roles = within(people).getByRole('group', { name: 'edit-roles' });
    expect(within(roles).getByLabelText('role-Manager')).toBeEnabled();
    for (const r of ['HR', 'Payroll', 'Auditor', 'Administrator']) {
      expect(within(roles).getByLabelText(`role-${r}`)).toBeDisabled();
    }
    expect(within(roles).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('explains a server refusal in plain words', async () => {
    mocks.myCapabilities.mockResolvedValue(['admin.role.assign']);
    mocks.adminPeople.mockResolvedValue({
      people: [
        {
          oid: NILESH,
          name: 'Nilesh Darekar',
          roles: ['Administrator'],
          has_employee_record: true,
        },
      ],
    });
    mocks.adminPeopleSetRoles.mockRejectedValue('last_administrator');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const people = screen.getByRole('region', { name: 'people' });
    await user.click(await within(people).findByRole('button', { name: /Nilesh Darekar/ }));
    await user.click(within(people).getByLabelText('role-Administrator'));
    await user.click(within(people).getByRole('button', { name: 'Save' }));
    expect(await within(people).findByRole('alert')).toHaveTextContent(
      'CloudPunch needs at least one Administrator.',
    );
  });
});

describe('welcome email (ADR-0021)', () => {
  const FARHEEN = '8afe98ae-5b43-4c12-86c5-b4473225f7f0';
  const preview = {
    from: 'noreply@aptask.com',
    to: 'farheen@aptask.com',
    cc: ['support@aptask.com', 'abdulla@aptask.com', 'nileshd@aptask.com'],
    subject: 'Welcome to CloudPunch: how to get started',
  };

  it('giving someone Employee offers the welcome email, with a preview and a note', async () => {
    mocks.myCapabilities.mockResolvedValue(['admin.role.assign']);
    mocks.adminPeople.mockResolvedValue({ people: [] });
    mocks.adminPeopleSearch.mockResolvedValue({
      users: [{ oid: FARHEEN, name: 'Farheen Khanam', email: 'farheen@aptask.com' }],
    });
    mocks.adminPeopleSetRoles.mockResolvedValue({ changed: true });
    mocks.adminWelcomePreview.mockResolvedValue(preview);
    mocks.adminWelcomeSend.mockResolvedValue({ to: preview.to, cc: preview.cc });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const people = screen.getByRole('region', { name: 'people' });
    await user.type(within(people).getByLabelText('people-search'), 'farh');
    await user.click(await within(people).findByRole('button', { name: /Farheen Khanam/ }));
    await user.click(within(people).getByRole('button', { name: 'Save' }));
    const panel = await within(people).findByRole('group', { name: 'welcome-email' });
    expect(panel).toHaveTextContent('Send Farheen Khanam a welcome email?');
    expect(
      await within(panel).findByText('ApTask CloudPunch <noreply@aptask.com>'),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent('support@aptask.com, abdulla@aptask.com, nileshd@aptask.com');
    await user.type(within(panel).getByLabelText('welcome-note'), 'Welcome aboard!');
    await user.click(within(panel).getByRole('button', { name: 'Send welcome email' }));
    expect(mocks.adminWelcomeSend).toHaveBeenCalledWith(FARHEEN, 'Welcome aboard!');
    expect(await within(people).findByRole('status')).toHaveTextContent(
      'Welcome email sent to farheen@aptask.com',
    );
  });

  it('a refused send says why and keeps the panel open', async () => {
    mocks.myCapabilities.mockResolvedValue(['hr.employee.write']);
    mocks.adminPeople.mockResolvedValue({
      people: [
        { oid: FARHEEN, name: 'Farheen Khanam', roles: ['Employee'], has_employee_record: true },
      ],
    });
    mocks.adminWelcomePreview.mockResolvedValue(preview);
    mocks.adminWelcomeSend.mockRejectedValue('welcome_not_permitted');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const people = screen.getByRole('region', { name: 'people' });
    await user.click(await within(people).findByRole('button', { name: /Farheen Khanam/ }));
    await user.click(within(people).getByRole('button', { name: 'Send welcome email' }));
    const panel = await within(people).findByRole('group', { name: 'welcome-email' });
    await within(panel).findByText('ApTask CloudPunch <noreply@aptask.com>');
    await user.click(within(panel).getByRole('button', { name: 'Send welcome email' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Exchange refused');
  });
});
