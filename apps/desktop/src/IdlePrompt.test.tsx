import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdlePrompt, NOTE_MAX_LENGTH, PROMPT_RESPONSES } from './IdlePrompt';

const T0 = Date.parse('2026-09-24T11:10:00Z');

/** Far enough out that interaction tests never hit expiry. */
const future = (): number => Date.now() + 30_000;

function optionLabels(): string[] {
  return within(screen.getByRole('group', { name: 'prompt-options' }))
    .getAllByRole('button')
    .map((b) => b.textContent ?? '');
}

describe('IdlePrompt — options and responses', () => {
  it('response list matches the USER_PROMPT_RESPONSE schema enum', () => {
    const path = resolve(
      __dirname,
      '../../../packages/event-schema/schemas/user-prompt-response.schema.json',
    );
    const schema = JSON.parse(readFileSync(path, 'utf8')) as {
      allOf: [unknown, { properties: { payload: { properties: Record<string, unknown> } } }];
    };
    const payload = schema.allOf[1].properties.payload.properties as {
      response: { enum: string[] };
      note: { maxLength: number };
    };
    expect([...PROMPT_RESPONSES]).toEqual(payload.response.enum);
    expect(NOTE_MAX_LENGTH).toBe(payload.note.maxLength);
  });

  it('shows all six options in policy order, first one focused', () => {
    render(<IdlePrompt deadline={future()} onRespond={vi.fn()} />);
    expect(optionLabels()).toEqual([
      "I'm still working",
      'Bio break',
      'Meal break',
      'On a phone call',
      'Working away from computer',
      'End my shift now',
    ]);
    expect(screen.getByRole('button', { name: "I'm still working" })).toHaveFocus();
  });

  it('honours a restricted idle.prompt_options list', () => {
    render(
      <IdlePrompt
        deadline={future()}
        onRespond={vi.fn()}
        options={['still_working', 'end_shift']}
      />,
    );
    expect(optionLabels()).toEqual(["I'm still working", 'End my shift now']);
  });

  it.each([
    ["I'm still working", 'still_working'],
    ['Bio break', 'bio_break'],
    ['Meal break', 'meal_break'],
    ['On a phone call', 'on_phone_call'],
    ['End my shift now', 'end_shift'],
  ] as const)('"%s" responds immediately with %s and no note', async (label, response) => {
    const onRespond = vi.fn();
    const user = userEvent.setup();
    render(<IdlePrompt deadline={future()} onRespond={onRespond} />);
    await user.click(screen.getByRole('button', { name: label }));
    expect(onRespond).toHaveBeenCalledOnce();
    expect(onRespond).toHaveBeenCalledWith(response, null);
  });

  it('working_away requires a non-blank note, trimmed', async () => {
    const onRespond = vi.fn();
    const user = userEvent.setup();
    render(<IdlePrompt deadline={future()} onRespond={onRespond} />);

    await user.click(screen.getByRole('button', { name: 'Working away from computer' }));
    expect(onRespond).not.toHaveBeenCalled();

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    const note = screen.getByRole('textbox');
    expect(note).toHaveFocus();
    expect(note).toHaveAttribute('maxLength', String(NOTE_MAX_LENGTH));
    expect(confirm).toBeDisabled();

    await user.type(note, '   ');
    expect(confirm).toBeDisabled();

    await user.type(note, 'client site visit  ');
    await user.click(confirm);
    expect(onRespond).toHaveBeenCalledOnce();
    expect(onRespond).toHaveBeenCalledWith('working_away', 'client site visit');
  });

  it('Back from the note form returns to the options and clears the note', async () => {
    const user = userEvent.setup();
    render(<IdlePrompt deadline={future()} onRespond={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Working away from computer' }));
    await user.type(screen.getByRole('textbox'), 'draft');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(optionLabels()).toHaveLength(6);

    await user.click(screen.getByRole('button', { name: 'Working away from computer' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});

describe('IdlePrompt — countdown (core owns the timer, ADR-0008 §2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down from the core-supplied deadline', () => {
    render(<IdlePrompt deadline={T0 + 30_000} onRespond={vi.fn()} />);
    expect(screen.getByText(/clocked out in 30s/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText(/clocked out in 20s/)).toBeInTheDocument();
  });

  it('a new deadline (input reset the grace timer, ADR-0008 §2) resets the display', () => {
    const onRespond = vi.fn();
    const { rerender } = render(<IdlePrompt deadline={T0 + 30_000} onRespond={onRespond} />);
    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(screen.getByText(/clocked out in 5s/)).toBeInTheDocument();

    rerender(<IdlePrompt deadline={T0 + 25_000 + 30_000} onRespond={onRespond} />);
    expect(screen.getByText(/clocked out in 30s/)).toBeInTheDocument();
  });

  it('on expiry disables options and never responds on its own (core owns timeout)', () => {
    const onRespond = vi.fn();
    render(<IdlePrompt deadline={T0 + 30_000} onRespond={onRespond} />);
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(screen.getByText('No response — clocking you out.')).toBeInTheDocument();
    for (const b of within(screen.getByRole('group', { name: 'prompt-options' })).getAllByRole(
      'button',
    )) {
      expect(b).toBeDisabled();
    }
    expect(onRespond).not.toHaveBeenCalled();
  });
});
