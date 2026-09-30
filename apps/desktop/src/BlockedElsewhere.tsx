import type { BlockedElsewhere } from './api.js';
import { formatClock } from './timelineModel.js';
import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

/**
 * "Your other Windows computer" / "your other Mac". The server keeps
 * only a hash of the other computer's name, so it is never named.
 */
function otherComputer(os: BlockedElsewhere['os']): string {
  if (os === 'windows') return 'your other Windows computer';
  if (os === 'macos') return 'your other Mac';
  return 'your other computer';
}

/** Pure: the blocked screen's message (ADR-0028 §2). */
export function blockedText(b: BlockedElsewhere): string {
  const since = b.openedAt !== null ? ` since ${formatClock(b.openedAt)}` : '';
  return `You're clocked in on ${otherComputer(b.os)}${since}. Clock out there first, or ask an admin to sign you out of it.`;
}

/**
 * One machine at a time (ADR-0028): shown instead of Clock in while the
 * person is clocked in on another computer. Nothing is recorded here
 * meanwhile. Only Check again and Sign out are offered.
 */
export function BlockedElsewherePanel({
  blocked,
  onCheckAgain,
  onSignOut,
}: {
  blocked: BlockedElsewhere;
  onCheckAgain: () => void;
  onSignOut: () => void;
}): JSX.Element {
  const t = useTheme();
  return (
    <section
      role="alert"
      aria-label="blocked-elsewhere"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 12,
        background: t.warnBg,
        color: t.warnText,
      }}
    >
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{blockedText(blocked)}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Button variant="primary" onClick={onCheckAgain}>
          Check again
        </Button>
        <Button variant="secondary" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </section>
  );
}
