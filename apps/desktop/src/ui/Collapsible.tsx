import { useId, useState, type ReactNode } from 'react';
import { useTheme } from './theme.js';

/**
 * A section that folds to one line (owner request, 2026-10-12): the
 * title and a short summary ("12 people · 2 without a manager") stay
 * visible, the list opens on a click. Folded by default, so a long list
 * never pushes the next section out of view.
 */
export function Collapsible({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Shown next to the title, folded or not. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(defaultOpen);
  const body = useId();
  return (
    <section
      aria-label={title}
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 12,
        background: t.surface,
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          border: 'none',
          background: 'none',
          color: t.text,
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 10,
            color: t.muted,
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms',
          }}
        >
          ▸
        </span>
        <span style={{ fontSize: 13, fontWeight: 650 }}>{title}</span>
        {summary !== undefined && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: t.muted }}>{summary}</span>
        )}
      </button>
      {open && (
        <div
          id={body}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '0 12px 12px',
          }}
        >
          {children}
        </div>
      )}
    </section>
  );
}
