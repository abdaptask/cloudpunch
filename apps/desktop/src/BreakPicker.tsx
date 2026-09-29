import { useState } from 'react';
import type { BreakId, BreakOption, StateView } from './api.js';
import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

/** "Back in?" choices, minutes (ADR-0023 §2; the backend accepts only these). */
export const PLANNED_MINUTES = [5, 10, 15, 20, 30, 45, 60] as const;

/** "Teams call", "Zoom call", "call". */
export function callName(callType: StateView['callType']): string {
  switch (callType) {
    case 'teams':
      return 'Teams call';
    case 'zoom':
      return 'Zoom call';
    default:
      return 'call';
  }
}

/** The "Back in?" choice a type starts on: its limit if that's a choice. */
export function defaultPlanned(option: BreakOption | undefined): number | null {
  const max = option?.maxMinutes ?? null;
  return max !== null && (PLANNED_MINUTES as readonly number[]).includes(max) ? max : null;
}

/**
 * "Take a break" (ADR-0023 §2, §6): the break types the policy offers,
 * then "Back in?" (starting on the type's limit, so Start is one tap),
 * then Start. During a detected call it also says what happens to the
 * call (owner request): usually the person has left it.
 */
export function BreakPicker({
  options,
  call,
  onStart,
  onCancel,
}: {
  options: readonly BreakOption[];
  /** "Teams call" etc. while on a call; null otherwise. */
  call: string | null;
  onStart: (kind: BreakId, plannedMinutes: number | null) => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTheme();
  const first = options[0];
  const [kind, setKind] = useState<BreakId | null>(first?.id ?? null);
  const [planned, setPlanned] = useState<number | null>(defaultPlanned(first));
  const pick = (o: BreakOption): void => {
    setKind(o.id);
    setPlanned(defaultPlanned(o));
  };
  const chip = (selected: boolean): React.CSSProperties => ({
    padding: '6px 10px',
    borderRadius: 999,
    border: `1px solid ${selected ? t.accent : t.border}`,
    background: selected ? t.accent : t.bg,
    color: selected ? t.onAccent : t.text,
    font: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
  });
  return (
    <section
      role="dialog"
      aria-label="take-a-break"
      style={{
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 14,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      }}
    >
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Take a break</h2>
      {call && (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: t.muted }}>
          You&apos;re on a {call}. The {call} so far stays counted as a call. If it&apos;s still
          going when you end the break, it counts as a call again.
        </p>
      )}
      <div
        role="radiogroup"
        aria-label="break type"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
      >
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={kind === o.id}
            onClick={() => pick(o)}
            style={chip(kind === o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 12, color: t.muted }}>Back in?</div>
      <div
        role="radiogroup"
        aria-label="back in"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
      >
        {PLANNED_MINUTES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={planned === m}
            onClick={() => setPlanned(m)}
            style={chip(planned === m)}
          >
            {m} min
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={planned === null}
          onClick={() => setPlanned(null)}
          style={chip(planned === null)}
        >
          Not sure
        </button>
      </div>
      <Button
        variant="primary"
        disabled={kind === null}
        onClick={() => kind !== null && onStart(kind, planned)}
      >
        {call ? "Start break: I've left the call" : 'Start break'}
      </Button>
      <button
        type="button"
        onClick={onCancel}
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
        {call ? 'Stay on the call' : 'Cancel'}
      </button>
    </section>
  );
}
