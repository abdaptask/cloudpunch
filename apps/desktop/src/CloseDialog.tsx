import { useState, type CSSProperties } from 'react';
import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

/** localStorage key: "tray" means skip the dialog and keep running. */
export const CLOSE_PREF_KEY = 'cloudpunch.onClose';

export function rememberedKeepRunning(): boolean {
  try {
    return window.localStorage.getItem(CLOSE_PREF_KEY) === 'tray';
  } catch {
    return false;
  }
}

function rememberKeepRunning(): void {
  try {
    window.localStorage.setItem(CLOSE_PREF_KEY, 'tray');
  } catch {
    // Storage unavailable: the dialog just shows again next time.
  }
}

/**
 * Shown when the window's close button is pressed (ADR-0013 §1). Only
 * "Keep running in tray" can be remembered; quitting always asks.
 */
export function CloseDialog({
  clockedIn,
  onKeepRunning,
  onQuit,
  onCancel,
}: {
  clockedIn: boolean;
  onKeepRunning: () => void;
  onQuit: () => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTheme();
  const [remember, setRemember] = useState(false);
  const text: CSSProperties = { margin: 0, fontSize: 14, lineHeight: 1.5, color: t.muted };
  return (
    <section
      role="dialog"
      aria-label="close-dialog"
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
        {clockedIn ? "You're still clocked in" : 'Close CloudPunch?'}
      </h2>
      <p style={text}>
        {clockedIn
          ? 'CloudPunch will keep tracking your time from the system tray. You can reopen it from the tray icon at any time.'
          : 'CloudPunch can keep running in the system tray so it’s ready when you clock in.'}
      </p>
      <Button
        variant="primary"
        onClick={() => {
          if (remember) rememberKeepRunning();
          onKeepRunning();
        }}
      >
        Keep running in tray
      </Button>
      <Button variant={clockedIn ? 'stopOutline' : 'secondary'} onClick={onQuit}>
        {clockedIn ? 'Clock out & quit' : 'Quit'}
      </Button>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.muted }}
        >
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Don&apos;t ask again
        </label>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: 0,
            border: 'none',
            background: 'none',
            color: t.accent,
            font: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

/** "Still working?" after a long session (ADR-0013 §5). */
export function LongShiftBanner({
  hours,
  onStillWorking,
  onClockOut,
}: {
  hours: string;
  onStillWorking: () => void;
  onClockOut: () => void;
}): JSX.Element {
  const t = useTheme();
  return (
    <section
      role="alertdialog"
      aria-label="long-shift"
      style={{
        background: t.warnBg,
        color: t.warnText,
        borderRadius: 14,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.45, fontWeight: 600 }}>
        You&apos;ve been clocked in for {hours} — still working?
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" onClick={onStillWorking}>
          Still working
        </Button>
        <Button variant="stopOutline" onClick={onClockOut}>
          Clock out
        </Button>
      </div>
    </section>
  );
}
