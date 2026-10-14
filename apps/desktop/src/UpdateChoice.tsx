import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

/** "6:00 pm" on this computer's clock. */
function timeText(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Clocking in with an update ready (ADR-0046 §2), like Windows Update:
 * update first and clock in on the new version (about 20 seconds), or
 * clock in now. After a pushed update's deadline, only the first.
 */
export function UpdateChoice({
  version,
  requiredBy,
  now,
  onUpdateAndClockIn,
  onClockInNow,
  onCancel,
}: {
  version: string;
  /** A pushed update's deadline, epoch ms. */
  requiredBy: number | null;
  now: number;
  onUpdateAndClockIn: () => void;
  onClockInNow: () => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTheme();
  const overdue = requiredBy !== null && now >= requiredBy;
  return (
    <section
      role="dialog"
      aria-label="update-choice"
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
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>CloudPunch {version} is ready</h2>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: t.muted }}>
        {overdue
          ? 'Your company needs everyone on this version now. It takes about 20 seconds, and you’re clocked in as soon as it starts.'
          : requiredBy !== null
            ? `Update now: it takes about 20 seconds, and you’re clocked in as soon as it starts. It’s needed by ${timeText(requiredBy)}.`
            : 'Update now: it takes about 20 seconds, and you’re clocked in as soon as it starts.'}
      </p>
      <Button variant="go" onClick={onUpdateAndClockIn}>
        Update and clock in
      </Button>
      {!overdue && (
        <Button variant="secondary" onClick={onClockInNow}>
          Clock in now, update later
        </Button>
      )}
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
        Cancel
      </button>
    </section>
  );
}
