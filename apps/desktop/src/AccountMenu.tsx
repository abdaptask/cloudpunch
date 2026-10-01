import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTheme } from './ui/theme.js';

/** "Abdulla Sheikh" → "AS"; one word → its first two letters. */
export function initials(name: string): string {
  const words = name
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  const pair = last ? `${first[0] ?? ''}${last[0] ?? ''}` : first.slice(0, 2);
  return pair.toUpperCase();
}

/**
 * The header's account button (owner request, 2026-09-30): initials in a
 * circle, opening a small menu with the name, the sign-in name and the
 * one sign-out action that fits: "Sign out" while clocked out, "Clock out
 * and sign out" while clocked in. Keeps the header on one line.
 */
export function AccountMenu({
  name,
  username,
  clockedIn,
  onSignOut,
  onClockOutAndSignOut,
  onConnections,
}: {
  name: string | null;
  username: string | null;
  clockedIn: boolean;
  onSignOut: () => void;
  onClockOutAndSignOut: () => void;
  /** "Where you connect from" (ADR-0029 §5); absent hides it. */
  onConnections?: (() => void) | undefined;
}): JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const label = name ?? username ?? 'Account';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const item = (danger: boolean): CSSProperties => ({
    display: 'block',
    width: '100%',
    padding: '8px 12px',
    border: 'none',
    borderRadius: 6,
    background: 'none',
    color: danger ? t.danger : t.text,
    font: 'inherit',
    fontSize: 13,
    textAlign: 'left',
    cursor: 'pointer',
  });

  return (
    <span ref={ref} style={{ position: 'relative', marginLeft: 8, verticalAlign: 'middle' }}>
      <button
        type="button"
        aria-label="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 24,
          height: 24,
          padding: 0,
          border: `1px solid ${open ? t.accent : t.border}`,
          borderRadius: '50%',
          background: open ? t.surfaceAlt : t.surface,
          color: open ? t.accent : t.text,
          font: 'inherit',
          fontSize: 10,
          fontWeight: 650,
          letterSpacing: 0.3,
          cursor: 'pointer',
          verticalAlign: 'middle',
        }}
      >
        {initials(label)}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Account menu"
          style={{
            position: 'absolute',
            right: 0,
            top: 30,
            zIndex: 20,
            minWidth: 220,
            padding: 6,
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
            whiteSpace: 'normal',
            textAlign: 'left',
          }}
        >
          <div style={{ padding: '6px 12px 8px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{label}</div>
            {username && username !== label && (
              <div style={{ fontSize: 12, color: t.muted }}>{username}</div>
            )}
          </div>
          <div style={{ height: 1, background: t.border, margin: '0 6px 4px' }} />
          {onConnections && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onConnections();
              }}
              style={item(false)}
            >
              Where you connect from
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              if (clockedIn) onClockOutAndSignOut();
              else onSignOut();
            }}
            style={item(clockedIn)}
          >
            {clockedIn ? 'Clock out and sign out' : 'Sign out'}
          </button>
        </div>
      )}
    </span>
  );
}
