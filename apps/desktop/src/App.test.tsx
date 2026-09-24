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
  respondToPrompt: vi.fn(),
  onState: vi.fn<(cb: (v: StateView) => void) => Promise<() => void>>(),
}));

vi.mock('./api.js', () => ({ api: mocks, STATE_EVENT: 'cp://state' }));

function view(over: Partial<StateView> = {}): StateView {
  return {
    status: 'clocked_out',
    breakKind: null,
    awayReason: null,
    promptDeadline: null,
    promptOptions: [],
    noteRequiredFor: [],
    autoClockedOutAt: null,
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
    /clocked in|on a|away|not clocked/i,
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
    expect(actionButtons()).toEqual(['Clock out', 'Bio break', 'Meal break']);
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

  it('on a call reads as clocked in (ADR-0003 §1)', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'on_call' }));
    render(<App />);
    expect(await screen.findByText('Clocked in')).toBeInTheDocument();
  });

  it('away offers I’m back', async () => {
    mocks.getState.mockResolvedValue(view({ status: 'away', awayReason: 'phone_call' }));
    mocks.markBack.mockResolvedValue(view({ status: 'active' }));
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('Away — on a phone call')).toBeInTheDocument();
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

  it('shows a rejection instead of changing state', async () => {
    mocks.clockIn.mockRejectedValue('invalid_transition');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Clock in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("isn't available");
    expect(statusText()).toBe('Not clocked in');
  });
});
