import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { UpdateCheck } from './api.js';
import { useTheme } from './ui/theme.js';

/** What "Check for updates" says: an answer, or a rejection's code. */
export function updateCheckText(
  result: UpdateCheck | { error: string },
  version: string | null,
  clockedIn: boolean,
): string {
  if ('error' in result) {
    if (result.error === 'signed_out') return 'Sign in again to check for updates.';
    if (result.error === 'not_configured') return "This copy of CloudPunch doesn't get updates.";
    return "Couldn't check right now. Try again in a minute.";
  }
  if (result.status === 'up_to_date') {
    return version ? `You're up to date (version ${version}).` : "You're up to date.";
  }
  return clockedIn
    ? `Version ${result.version} is downloaded. Clock out, then choose Restart to update.`
    : `Version ${result.version} is ready. Choose Restart to update.`;
}

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
  version = null,
  onCheckForUpdate,
}: {
  name: string | null;
  username: string | null;
  clockedIn: boolean;
  onSignOut: () => void;
  onClockOutAndSignOut: () => void;
  /** "Where you connect from" (ADR-0029 §5); absent hides it. */
  onConnections?: (() => void) | undefined;
  /** This app's version, shown under "Check for updates". */
  version?: string | null;
  /** "Check for updates" (owner request, 2026-10-07); absent hides it. */
  onCheckForUpdate?: (() => Promise<UpdateCheck>) | undefined;
}): JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const label = name ?? username ?? 'Account';
  // null: not checked since the menu opened; 'checking' while it runs.
  const [check, setCheck] = useState<string | null>(null);

  useEffect(() => {
    setCheck(null);
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
          {onCheckForUpdate && (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={check === 'checking'}
                onClick={() => {
                  // Stays open: the answer shows right here.
                  setCheck('checking');
                  onCheckForUpdate().then(
                    (r) => setCheck(updateCheckText(r, version, clockedIn)),
                    (e: unknown) =>
                      setCheck(updateCheckText({ error: String(e) }, version, clockedIn)),
                  );
                }}
                style={item(false)}
              >
                Check for updates
              </button>
              <div
                role="status"
                aria-label="update-check"
                style={{ padding: '0 12px 6px', fontSize: 12, color: t.muted }}
              >
                {check === 'checking'
                  ? 'Checking…'
                  : (check ?? (version ? `Version ${version}` : ''))}
              </div>
            </>
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
