import type { StateView } from './api.js';
import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

export type BreakKind = 'bio' | 'meal';

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

/**
 * A break asked for during a detected call (owner request): usually the
 * person has left the call, sometimes it's a mis-click. Say what
 * happens either way.
 */
export function BreakOnCallDialog({
  kind,
  callType,
  onStart,
  onCancel,
}: {
  kind: BreakKind;
  callType: StateView['callType'];
  onStart: () => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTheme();
  const call = callName(callType);
  const brk = kind === 'meal' ? 'meal break' : 'bio break';
  return (
    <section
      role="dialog"
      aria-label="break-on-call"
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
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>You&apos;re on a {call}</h2>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: t.muted }}>
        Take a {brk} anyway? The {call} so far stays counted as a call. If the call is still going
        when you end the break, it counts as a call again.
      </p>
      <Button variant="primary" onClick={onStart}>
        Start {brk}: I&apos;ve left the call
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
        Stay on the call
      </button>
    </section>
  );
}
