import type { CSSProperties } from 'react';
import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

/**
 * "Are you sure?" before clocking out (owner request). People often
 * mean "I'm stepping away", so while working it offers a break instead.
 * On a break or away it just confirms.
 */
export function ClockOutDialog({
  offerBreaks,
  onClockOut,
  onBreak,
  onCancel,
}: {
  /** True while working (Active / on a call): offer a break instead. */
  offerBreaks: boolean;
  onClockOut: () => void;
  onBreak: (kind: 'bio' | 'meal') => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTheme();
  const text: CSSProperties = { margin: 0, fontSize: 14, lineHeight: 1.5, color: t.muted };
  return (
    <section
      role="dialog"
      aria-label="clock-out-dialog"
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
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Clock out now?</h2>
      <p style={text}>
        {offerBreaks
          ? 'This ends your shift. Stepping away for a bit? Take a break instead, and your day stays in one session.'
          : 'This ends your shift for now. You can clock in again at any time.'}
      </p>
      {offerBreaks && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="chip" onClick={() => onBreak('bio')}>
            Take a bio break
          </Button>
          <Button variant="chip" onClick={() => onBreak('meal')}>
            Take a meal break
          </Button>
        </div>
      )}
      <Button variant="stop" onClick={onClockOut}>
        Yes, clock out
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
        Cancel, keep working
      </button>
    </section>
  );
}
