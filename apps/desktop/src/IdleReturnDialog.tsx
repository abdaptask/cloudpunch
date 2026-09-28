import { useState } from 'react';
import type { IdleExplanation, IdleReturn } from './api.js';
import { formatClock } from './timelineModel.js';
import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

const OPTIONS: [IdleExplanation, string][] = [
  ['working_away', 'Working away from the computer'],
  ['meeting', 'In a meeting'],
  ['phone_call', 'On a phone call'],
  ['break', 'On a break'],
  ['idle', 'Nothing, I was idle'],
];

/** "23 min", "1 h 05 min". */
function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}

/**
 * Welcome back after logged idle (ADR-0018 §2): what were you doing?
 * The answer is attached for the manager; the time stays idle unless
 * they accept it at approval. Skipping leaves it unexplained.
 */
export function IdleReturnDialog({
  stretch,
  onExplain,
  onSkip,
}: {
  stretch: IdleReturn;
  onExplain: (explanation: IdleExplanation, note: string | null) => void;
  onSkip: () => void;
}): JSX.Element {
  const t = useTheme();
  const [choice, setChoice] = useState<IdleExplanation | null>(null);
  const [note, setNote] = useState('');
  return (
    <section
      role="dialog"
      aria-label="idle-return"
      style={{
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 14,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      }}
    >
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Welcome back</h2>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: t.muted }}>
        You were idle {formatClock(stretch.since)}–{formatClock(stretch.until)} (
        {minutes(stretch.until - stretch.since)}). What were you doing?
      </p>
      <div role="radiogroup" aria-label="idle-explanation" style={{ display: 'grid', gap: 6 }}>
        {OPTIONS.map(([value, label]) => (
          <Button
            key={value}
            role="radio"
            aria-checked={choice === value}
            variant="secondary"
            onClick={() => setChoice(value)}
            style={{
              textAlign: 'left',
              padding: '9px 12px',
              fontSize: 13,
              borderColor: choice === value ? t.accent : undefined,
              boxShadow: choice === value ? `inset 0 0 0 1px ${t.accent}` : undefined,
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <input
        aria-label="idle-note"
        placeholder="Add a note (optional)"
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
        style={{
          font: 'inherit',
          fontSize: 13,
          padding: '8px 10px',
          borderRadius: 8,
          border: `1px solid ${t.border}`,
          background: t.bg,
          color: t.text,
        }}
      />
      <p style={{ margin: 0, fontSize: 11, lineHeight: 1.4, color: t.muted }}>
        Your manager sees this next to the idle time when approving your timesheet.
      </p>
      <Button
        variant="primary"
        disabled={choice === null}
        onClick={() => choice && onExplain(choice, note.trim() === '' ? null : note.trim())}
      >
        Send
      </Button>
      <button
        type="button"
        onClick={onSkip}
        style={{
          alignSelf: 'center',
          padding: 0,
          border: 'none',
          background: 'none',
          color: t.accent,
          font: 'inherit',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        Skip
      </button>
    </section>
  );
}
