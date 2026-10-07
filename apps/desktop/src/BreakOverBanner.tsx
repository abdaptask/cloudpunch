import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

/**
 * A planned break that ran past its end (ADR-0031 §3): a red, blinking
 * banner at the top with the choices. The agent also brings the window
 * forward, flashes the taskbar / Dock and turns the tray red, every two
 * minutes until one of these is chosen.
 */

/** "3 min over", "1 h 05 min over". */
export function overText(sinceMs: number, nowMs: number): string {
  const min = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  if (min < 60) return `${min} min over`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min over`;
}

export function BreakOverBanner({
  breakName,
  since,
  now,
  onBack,
  onMore,
}: {
  /** "Tea break". */
  breakName: string;
  since: number;
  now: number;
  onBack: () => void;
  onMore: (minutes: 5 | 10) => void;
}): JSX.Element {
  const t = useTheme();
  return (
    <section
      role="alert"
      aria-label="break-over"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 12,
        border: `2px solid ${t.danger}`,
        background: t.surface,
        animation: 'cp-break-over 1s ease-in-out infinite',
      }}
    >
      <style>{`
        @keyframes cp-break-over {
          0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.55); border-color: ${t.danger}; }
          50% { box-shadow: 0 0 0 6px rgba(220, 38, 38, 0); border-color: transparent; }
        }
        @media (prefers-reduced-motion: reduce) {
          [aria-label="break-over"] { animation: none !important; }
        }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 15, color: t.danger }}>
          Your {breakName.toLowerCase()} is over
        </strong>
        <span style={{ fontSize: 13, color: t.muted }}>{overText(since, now)}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="go" onClick={onBack}>
          I'm back
        </Button>
        <Button variant="chip" onClick={() => onMore(5)}>
          5 more min
        </Button>
        <Button variant="chip" onClick={() => onMore(10)}>
          10 more min
        </Button>
      </div>
    </section>
  );
}
