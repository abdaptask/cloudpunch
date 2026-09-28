import { formatClock } from './timelineModel.js';
import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

/**
 * The daily clock-in popup (ADR-0018 §4): at the policy time (8:00 in
 * New York by default) for someone at the computer and not clocked in.
 * Offers to start from when they signed in to the computer; never
 * clocks anyone in by itself. No "Good morning": 8 am in New York is
 * evening in India.
 */
export function ClockInPrompt({
  signedInAt,
  onClockInFrom,
  onClockInNow,
  onNotNow,
}: {
  /** Sign-in time a clock-in may start from, or null. */
  signedInAt: number | null;
  onClockInFrom: () => void;
  onClockInNow: () => void;
  onNotNow: () => void;
}): JSX.Element {
  const t = useTheme();
  return (
    <section
      role="dialog"
      aria-label="clock-in-prompt"
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
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Time to clock in</h2>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: t.muted }}>
        {signedInAt !== null
          ? `You signed in to your computer at ${formatClock(signedInAt)}. Start your day from then?`
          : 'Ready to start your day?'}
      </p>
      {signedInAt !== null ? (
        <>
          <Button variant="go" onClick={onClockInFrom}>
            Clock in from {formatClock(signedInAt)}
          </Button>
          <Button variant="secondary" onClick={onClockInNow}>
            Clock in now
          </Button>
        </>
      ) : (
        <Button variant="go" onClick={onClockInNow}>
          Clock in
        </Button>
      )}
      {signedInAt !== null && (
        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.4, color: t.muted }}>
          Your manager sees that this session started from your computer sign-in.
        </p>
      )}
      <button
        type="button"
        onClick={onNotNow}
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
        Not now
      </button>
    </section>
  );
}
