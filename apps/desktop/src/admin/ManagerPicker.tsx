import { useState, type CSSProperties } from 'react';
import { useTheme, type Theme } from '../ui/theme.js';

/** At most this many matches show at once; typing more narrows them. */
const MAX_MATCHES = 8;

/**
 * Picking a manager by name (ADR-0038 §4): type two letters, pick from
 * the matches, or "No manager". Replaces the long dropdown.
 */
export function ManagerPicker({
  person,
  current,
  choices,
  disabled = false,
  onPick,
}: {
  /** Whose manager this is, for the labels. */
  person: string;
  current: { id: string; name: string } | null;
  choices: readonly { id: string; name: string }[];
  disabled?: boolean;
  onPick: (managerId: string | null) => void;
}): JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const matches =
    needle.length < 2
      ? []
      : choices.filter((c) => c.name.toLowerCase().includes(needle)).slice(0, MAX_MATCHES);
  const pick = (id: string | null): void => {
    setOpen(false);
    setQ('');
    onPick(id);
  };

  if (!open) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          {current ? (
            <>Reports to {current.name}</>
          ) : (
            <span style={{ color: t.warnText }}>No manager</span>
          )}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          aria-label={`change manager of ${person}`}
          style={link(t)}
        >
          {current ? 'Change' : 'Set manager'}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input
        // The picker opened on a click: typing goes straight in.
        autoFocus
        aria-label={`find a manager for ${person}`}
        placeholder="Type two letters of a name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        style={input(t)}
      />
      <ul aria-label="manager-matches" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {matches.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => pick(m.id)} style={option(t)}>
              {m.name}
            </button>
          </li>
        ))}
        {needle.length >= 2 && matches.length === 0 && (
          <li style={{ fontSize: 12, color: t.muted, padding: '4px 8px' }}>
            Nobody with the Manager or HR role matches.
          </li>
        )}
        {current && (
          <li>
            <button type="button" onClick={() => pick(null)} style={option(t)}>
              No manager
            </button>
          </li>
        )}
      </ul>
      <button
        type="button"
        onClick={() => setOpen(false)}
        style={{ ...link(t), alignSelf: 'flex-start', fontSize: 12 }}
      >
        Cancel
      </button>
    </div>
  );
}

function input(t: Theme): CSSProperties {
  return {
    font: 'inherit',
    fontSize: 13,
    padding: '6px 8px',
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.bg,
    color: t.text,
  };
}

function option(t: Theme): CSSProperties {
  return {
    width: '100%',
    padding: '5px 8px',
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    color: t.text,
    font: 'inherit',
    fontSize: 13,
    textAlign: 'left',
    cursor: 'pointer',
  };
}

function link(t: Theme): CSSProperties {
  return {
    padding: 0,
    border: 'none',
    background: 'none',
    color: t.accent,
    font: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
  };
}
