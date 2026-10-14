import type { ClockSkew } from './api.js';
import { useTheme } from './ui/theme.js';

/**
 * This computer's clock is off from the server's (owner, 2026-10-14).
 * A clock running fast gets uploads refused; one far behind dates the
 * day early. The banner says by how much and how to fix it, and goes
 * once the next check finds the clock right.
 */

/** "2 min 30 s", "45 s", "1 h 02 min". */
export function skewAmount(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Where to fix it on this computer. */
export function syncHint(mac: boolean): string {
  return mac
    ? 'Sync it: System Settings → General → Date & Time, turn on "Set time and date automatically".'
    : 'Sync it: Settings → Time & language → Date & time → Sync now.';
}

export function skewText(skew: ClockSkew): string {
  return `Your computer's clock is ${skewAmount(skew.seconds)} ${skew.ahead ? 'fast' : 'slow'}.`;
}

const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

export function ClockSkewBanner({ skew }: { skew: ClockSkew }): JSX.Element {
  const t = useTheme();
  return (
    <section
      role="alert"
      aria-label="clock-skew"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '10px 12px',
        borderRadius: 12,
        background: t.warnBg,
        color: t.warnText,
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      <strong style={{ fontWeight: 650 }}>{skewText(skew)}</strong>
      <span>
        {skew.ahead
          ? 'CloudPunch may not be able to save your time until it is right. '
          : 'Your times will show early until it is right. '}
        {syncHint(isMac())}
      </span>
    </section>
  );
}
