import type { CSSProperties } from 'react';
import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

/**
 * "Are you sure?" before clocking out (owner request). People often
 * mean "I'm stepping away", so while working it offers a break instead.
 * On a break or away it just confirms. With `signOut` it's "Clock out
 * and sign out" (owner request): no break offer, it ends the shift and
 * signs out.
 */
export function ClockOutDialog({
  offerBreaks,
  call = null,
  signOut = false,
  onClockOut,
  onBreak,
  onCancel,
}: {
  /** True while working (Active / on a call): offer a break instead. */
  offerBreaks: boolean;
  /** "Teams call" while on a detected call, else null. */
  call?: string | null;
  /** Clock out and sign out, from the header link. */
  signOut?: boolean;
  onClockOut: () => void;
  /** Opens "Take a break" (ADR-0023). */
  onBreak: () => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTheme();
  const text: CSSProperties = { margin: 0, fontSize: 14, lineHeight: 1.5, color: t.muted };
  const breaks = offerBreaks && !signOut;
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
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>
        {signOut ? 'Clock out and sign out?' : 'Clock out now?'}
      </h2>
      {call && (
        <p style={{ ...text, color: t.text }}>
          You&apos;re on a {call}. Clocking out ends your shift now; the call time so far is kept.
        </p>
      )}
      <p style={text}>
        {signOut
          ? 'This ends your shift now and signs you out of CloudPunch. Your day so far is kept.'
          : breaks
            ? 'This ends your shift. Stepping away for a bit? Take a break instead, and your day stays in one session.'
            : 'This ends your shift for now. You can clock in again at any time.'}
      </p>
      {breaks && (
        <Button variant="chip" onClick={onBreak}>
          Take a break instead
        </Button>
      )}
      <Button variant="stop" onClick={onClockOut}>
        {signOut ? 'Yes, clock out and sign out' : 'Yes, clock out'}
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
