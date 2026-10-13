import { useState } from 'react';
import type { HistoryEntry } from '../api.js';
import { useTheme } from '../ui/theme.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: "Your role can't see this history.",
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/** "13 Oct 2026, 14:05", in this computer's zone. */
export function whenText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/**
 * Change history (ADR-0038 §8): who changed what, when and why, newest
 * first. Loads only when asked, so opening a panel doesn't fetch it.
 */
export function HistoryList({
  label,
  load,
}: {
  /** The list's accessible name. */
  label: string;
  load: () => Promise<{ entries: HistoryEntry[] }>;
}): JSX.Element {
  const t = useTheme();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  const show = (): void => {
    setAsked(true);
    setError(null);
    load().then(
      (r) => setEntries(r.entries),
      (e: unknown) => setError(errorText(String(e))),
    );
  };

  if (!asked) {
    return (
      <button
        type="button"
        onClick={show}
        style={{
          alignSelf: 'flex-start',
          padding: 0,
          border: 'none',
          background: 'none',
          color: t.accent,
          font: 'inherit',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        Show changes
      </button>
    );
  }
  if (error) {
    return (
      <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger }}>
        {error}
      </p>
    );
  }
  if (!entries) return <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>;
  if (entries.length === 0) {
    return <p style={{ margin: 0, fontSize: 13, color: t.muted }}>No changes recorded yet.</p>;
  }
  return (
    <ol aria-label={label} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {entries.map((e, i) => (
        <li
          key={`${e.at}-${i}`}
          style={{ padding: '6px 0', borderTop: i > 0 ? `1px solid ${t.border}` : undefined }}
        >
          <div style={{ fontSize: 13, lineHeight: 1.4 }}>{e.summary}</div>
          <div style={{ fontSize: 11.5, color: t.muted }}>
            {whenText(e.at)} · {e.by ?? 'CloudPunch'}
            {e.reason ? ` · “${e.reason}”` : ''}
          </div>
        </li>
      ))}
    </ol>
  );
}
