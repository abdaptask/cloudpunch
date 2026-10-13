import { useState } from 'react';
import type { BreakId, BreakOption, IdleExplanation, IdleReturn } from './api.js';
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
 * "On a break" asks which break and makes the time that break
 * (ADR-0042). Other answers are attached for the manager and the time
 * stays idle unless they correct it. Skipping leaves it unexplained.
 */
export function IdleReturnDialog({
  stretch,
  breaks,
  onExplain,
  onSkip,
}: {
  stretch: IdleReturn;
  /** The break types on the menu. */
  breaks: readonly BreakOption[];
  onExplain: (explanation: IdleExplanation, note: string | null, breakKind: BreakId | null) => void;
  onSkip: () => void;
}): JSX.Element {
  const t = useTheme();
  const [choice, setChoice] = useState<IdleExplanation | null>(null);
  const [breakKind, setBreakKind] = useState<BreakId | null>(null);
  const [note, setNote] = useState('');
  const needsBreak = choice === 'break' && breaks.length > 0 && breakKind === null;
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
      {choice === 'break' && breaks.length > 0 && (
        <div
          role="radiogroup"
          aria-label="idle-break-kind"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
        >
          <span style={{ width: '100%', fontSize: 13, color: t.muted }}>Which break?</span>
          {breaks.map((b) => (
            <Button
              key={b.id}
              role="radio"
              aria-checked={breakKind === b.id}
              variant="chip"
              onClick={() => setBreakKind(b.id)}
              style={
                breakKind === b.id
                  ? { background: t.accent, color: t.onAccent, borderColor: t.accent }
                  : undefined
              }
            >
              {b.label}
            </Button>
          ))}
        </div>
      )}
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
        {choice === 'break'
          ? 'This time counts as that break.'
          : 'Your manager sees this next to the idle time when approving your timesheet.'}
      </p>
      <Button
        variant="primary"
        disabled={choice === null || needsBreak}
        onClick={() =>
          choice &&
          onExplain(
            choice,
            note.trim() === '' ? null : note.trim(),
            choice === 'break' ? breakKind : null,
          )
        }
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
