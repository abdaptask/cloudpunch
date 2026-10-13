import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BreakOption } from './api.js';
import { IdleReturnDialog } from './IdleReturnDialog.js';

const BREAKS: BreakOption[] = [
  { id: 'bio', label: 'Bio break', maxMinutes: 10 },
  { id: 'meal', label: 'Meal break', maxMinutes: 60 },
];
const stretch = {
  since: Date.parse('2026-10-13T10:00:00Z'),
  until: Date.parse('2026-10-13T10:25:00Z'),
};

describe('Welcome back (ADR-0018 §2, ADR-0042)', () => {
  it('"On a break" asks which break and sends it', async () => {
    const user = userEvent.setup();
    const onExplain = vi.fn();
    render(
      <IdleReturnDialog stretch={stretch} breaks={BREAKS} onExplain={onExplain} onSkip={vi.fn()} />,
    );
    await user.click(screen.getByRole('radio', { name: 'On a break' }));
    expect(screen.getByText('This time counts as that break.')).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Meal break' }));
    await user.click(send);
    expect(onExplain).toHaveBeenCalledWith('break', null, 'meal');
  });

  it('other answers send no break type and stay a note for the manager', async () => {
    const user = userEvent.setup();
    const onExplain = vi.fn();
    render(
      <IdleReturnDialog stretch={stretch} breaks={BREAKS} onExplain={onExplain} onSkip={vi.fn()} />,
    );
    await user.click(screen.getByRole('radio', { name: 'In a meeting' }));
    expect(screen.queryByRole('radiogroup', { name: 'idle-break-kind' })).toBeNull();
    await user.type(screen.getByLabelText('idle-note'), 'standup');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onExplain).toHaveBeenCalledWith('meeting', 'standup', null);
  });
});
