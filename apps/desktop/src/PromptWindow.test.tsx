import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateView } from './api.js';
import { PROMPT_RESPONSES } from './IdlePrompt.js';
import { PromptWindow } from './PromptWindow.js';

const mocks = vi.hoisted(() => ({
  getState: vi.fn<() => Promise<StateView>>(),
  respondToPrompt: vi.fn<(r: string, n: string | null) => Promise<StateView>>(),
  onState: vi.fn<(cb: (v: StateView) => void) => Promise<() => void>>(),
}));

vi.mock('./api.js', () => ({ api: mocks, STATE_EVENT: 'cp://state' }));

function pending(over: Partial<StateView> = {}): StateView {
  return {
    status: 'idle_pending',
    breakKind: null,
    awayReason: null,
    callType: null,
    promptDeadline: Date.now() + 30_000,
    promptOptions: [...PROMPT_RESPONSES],
    noteRequiredFor: ['working_away'],
    autoClockedOutAt: null,
    sessionStartedAt: null,
    timeline: [],
    longShift: false,
    ...over,
  };
}

let pushState: (v: StateView) => void = () => undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getState.mockResolvedValue(pending());
  mocks.onState.mockImplementation((cb) => {
    pushState = cb;
    return Promise.resolve(() => undefined);
  });
});

describe('PromptWindow', () => {
  it('renders the prompt with the policy options', async () => {
    mocks.getState.mockResolvedValue(pending({ promptOptions: ['still_working', 'end_shift'] }));
    render(<PromptWindow />);
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      "I'm still working",
      'End my shift now',
    ]);
  });

  it('sends the response to the agent', async () => {
    mocks.respondToPrompt.mockResolvedValue(pending({ status: 'active', promptDeadline: null }));
    const user = userEvent.setup();
    render(<PromptWindow />);
    await user.click(await screen.findByRole('button', { name: 'Bio break' }));
    expect(mocks.respondToPrompt).toHaveBeenCalledWith('bio_break', null);
  });

  it('sends the note for working_away', async () => {
    mocks.respondToPrompt.mockResolvedValue(pending({ status: 'away', promptDeadline: null }));
    const user = userEvent.setup();
    render(<PromptWindow />);
    await user.click(await screen.findByRole('button', { name: 'Working away from computer' }));
    await user.type(screen.getByRole('textbox'), 'client site');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(mocks.respondToPrompt).toHaveBeenCalledWith('working_away', 'client site');
  });

  it('renders nothing once the agent leaves idle_pending', async () => {
    const { container } = render(<PromptWindow />);
    await screen.findByRole('alertdialog');
    act(() => pushState(pending({ status: 'on_call', promptDeadline: null })));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a rejection from the core', async () => {
    mocks.respondToPrompt.mockRejectedValue('invalid_transition');
    const user = userEvent.setup();
    render(<PromptWindow />);
    await user.click(await screen.findByRole('button', { name: "I'm still working" }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already closed');
  });
});
