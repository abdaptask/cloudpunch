import { useEffect, useId, useState, type CSSProperties } from 'react';
import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

/**
 * Slice 2b.7.2a idle prompt (ADR-0003 §3, amended by ADR-0008).
 *
 * Presentation only. The Rust core owns the grace timer and the
 * auto-clock-out (ADR-0008 §2); `deadline` is whatever it last told
 * us, and the countdown here is cosmetic. When input resets the
 * timer, the core sends a new `deadline` and the display follows.
 *
 * Rendered by `PromptWindow` in the `idle-prompt` window, which the
 * Rust agent opens and closes; `onRespond` goes to the
 * `respond_to_prompt` command.
 */

/**
 * Mirrors the `response` enum in
 * `packages/event-schema/schemas/user-prompt-response.schema.json`.
 * `IdlePrompt.test.tsx` fails if the two drift.
 */
export type PromptResponse =
  'still_working' | 'bio_break' | 'meal_break' | 'on_phone_call' | 'working_away' | 'end_shift';

export const PROMPT_RESPONSES: readonly PromptResponse[] = [
  'still_working',
  'bio_break',
  'meal_break',
  'on_phone_call',
  'working_away',
  'end_shift',
];

/** `payload.note` maxLength in the event schema. */
export const NOTE_MAX_LENGTH = 500;

const OPTION_LABEL: Record<PromptResponse, string> = {
  still_working: "I'm still working",
  bio_break: 'Bio break',
  meal_break: 'Meal break',
  on_phone_call: 'On a phone call',
  working_away: 'Working away from computer',
  end_shift: 'End my shift now',
};

export interface IdlePromptProps {
  /** Epoch ms at which the core will auto-clock-out. */
  deadline: number;
  onRespond: (response: PromptResponse, note: string | null) => void;
  /** `idle.prompt_options`; defaults to all six. */
  options?: readonly PromptResponse[];
  /** Options whose `away.require_note` is true; defaults to `working_away`. */
  noteRequiredFor?: readonly PromptResponse[];
  /** Injected for tests. */
  now?: () => number;
}

function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function IdlePrompt({
  deadline,
  onRespond,
  options = PROMPT_RESPONSES,
  noteRequiredFor = ['working_away'],
  now = Date.now,
}: IdlePromptProps): JSX.Element {
  const t = useTheme();
  const titleId = useId();
  const descId = useId();
  const [remaining, setRemaining] = useState(() => secondsLeft(deadline, now()));
  const [pendingNoteFor, setPendingNoteFor] = useState<PromptResponse | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    setRemaining(secondsLeft(deadline, now()));
    const id = setInterval(() => setRemaining(secondsLeft(deadline, now())), 250);
    return () => clearInterval(id);
  }, [deadline, now]);

  const expired = remaining === 0;

  const choose = (response: PromptResponse): void => {
    if (noteRequiredFor.includes(response)) {
      setPendingNoteFor(response);
      return;
    }
    onRespond(response, null);
  };

  const trimmedNote = note.trim();

  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      style={{
        fontFamily: t.font,
        padding: 22,
        color: t.text,
        background: t.bg,
        minHeight: '100vh',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <h1 id={titleId} style={{ margin: 0, fontSize: 19, fontWeight: 650 }}>
        Are you still there?
      </h1>
      <p id={descId} style={{ margin: 0, fontSize: 14, lineHeight: 1.45, color: t.muted }}>
        {expired
          ? 'No response — clocking you out.'
          : `We haven't seen any activity for a while. You'll be clocked out in ${remaining}s unless you choose an option.`}
      </p>

      {pendingNoteFor === null ? (
        <div role="group" aria-label="prompt-options" style={optionList}>
          {options.map((opt, i) => (
            <Button
              key={opt}
              autoFocus={i === 0}
              disabled={expired}
              variant={opt === 'still_working' ? 'primary' : 'secondary'}
              onClick={() => choose(opt)}
            >
              {OPTION_LABEL[opt]}
            </Button>
          ))}
        </div>
      ) : (
        <form
          aria-label="prompt-note"
          style={optionList}
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmedNote.length > 0) onRespond(pendingNoteFor, trimmedNote);
          }}
        >
          <label style={{ fontSize: 14 }}>
            {OPTION_LABEL[pendingNoteFor]} — add a short note
            <textarea
              autoFocus
              value={note}
              maxLength={NOTE_MAX_LENGTH}
              rows={3}
              disabled={expired}
              onChange={(e) => setNote(e.target.value)}
              style={{
                display: 'block',
                width: '100%',
                marginTop: 6,
                boxSizing: 'border-box',
                padding: 10,
                borderRadius: 10,
                border: `1px solid ${t.border}`,
                background: t.surface,
                color: t.text,
                fontFamily: t.font,
                fontSize: 14,
              }}
            />
          </label>
          <Button type="submit" variant="primary" disabled={expired || trimmedNote.length === 0}>
            Confirm
          </Button>
          <Button
            variant="secondary"
            disabled={expired}
            onClick={() => {
              setPendingNoteFor(null);
              setNote('');
            }}
          >
            Back
          </Button>
        </form>
      )}
    </div>
  );
}

const optionList: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };
