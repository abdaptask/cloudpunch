import { useState, type CSSProperties, type ReactNode } from 'react';
import { useTheme, type Theme } from '../ui/theme.js';

export interface Column<T> {
  key: string;
  label: string;
  /** The cell. */
  render: (row: T) => ReactNode;
  /** What the column sorts by; leave out for a column that doesn't sort. */
  sortText?: (row: T) => string;
  /** Narrow columns (dates, versions) don't wrap. */
  nowrap?: boolean;
}

/**
 * The admin console's table (ADR-0038 §9): a search box, columns that
 * sort on a click, a header row that stays put while the rows scroll,
 * and an optional row click. Shared by Holidays, Computers and
 * Connections, so they look and behave the same.
 */
export function DataTable<T>({
  label,
  rows,
  columns,
  rowKey,
  search,
  searchPlaceholder = 'Find',
  initialSort,
  onRowClick,
  selected,
  empty = 'Nothing here.',
  toolbar,
}: {
  /** The table's accessible name. */
  label: string;
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  /** The text a row is found by; no search box when left out. */
  search?: (row: T) => string;
  searchPlaceholder?: string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  onRowClick?: (row: T) => void;
  /** The key of the row shown as selected. */
  selected?: string | null;
  empty?: string;
  /** Filters and buttons beside the search box. */
  toolbar?: ReactNode;
}): JSX.Element {
  const t = useTheme();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(initialSort ?? null);
  const needle = q.trim().toLowerCase();
  const found =
    search && needle ? rows.filter((r) => search(r).toLowerCase().includes(needle)) : rows;
  const by = sort ? columns.find((c) => c.key === sort.key)?.sortText : undefined;
  const shown =
    sort && by
      ? [...found].sort((a, b) => (sort.dir === 'asc' ? 1 : -1) * by(a).localeCompare(by(b)))
      : found;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {(search || toolbar) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {search && (
            <input
              aria-label={`${label}-find`}
              placeholder={searchPlaceholder}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ ...input(t), flex: 1, minWidth: 160 }}
            />
          )}
          {toolbar}
        </div>
      )}
      <div style={box(t)}>
        <table aria-label={label} style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {columns.map((c) => {
                const on = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    aria-sort={on ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    style={th(t)}
                  >
                    {c.sortText ? (
                      <button
                        type="button"
                        onClick={() =>
                          setSort((s) => ({
                            key: c.key,
                            dir: s?.key === c.key && s.dir === 'asc' ? 'desc' : 'asc',
                          }))
                        }
                        style={headButton(t)}
                      >
                        {c.label}
                        {on ? (sort?.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </button>
                    ) : (
                      <span style={{ ...headButton(t), display: 'block', cursor: 'default' }}>
                        {c.label}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const k = rowKey(r);
              return (
                <tr
                  key={k}
                  aria-selected={selected === k ? true : undefined}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  style={{
                    cursor: onRowClick ? 'pointer' : undefined,
                    background: selected === k ? t.surfaceAlt : undefined,
                  }}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      style={{ ...td(t), whiteSpace: c.nowrap ? 'nowrap' : undefined }}
                    >
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p style={{ margin: 12, fontSize: 13, color: t.muted }}>
            {rows.length === 0 ? empty : 'Nobody matches.'}
          </p>
        )}
      </div>
      <span aria-label={`${label}-count`} style={{ fontSize: 12, color: t.muted }}>
        {shown.length === rows.length ? rows.length : `${shown.length} of ${rows.length}`}
      </span>
    </div>
  );
}

/** A short "Saved" or error line at the top of a page (ADR-0038 §9). */
export function Notice({
  notice,
  onDismiss,
}: {
  notice: { kind: 'saved' | 'error'; text: string } | null;
  onDismiss: () => void;
}): JSX.Element | null {
  const t = useTheme();
  if (!notice) return null;
  const error = notice.kind === 'error';
  return (
    <div
      role={error ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderRadius: 10,
        fontSize: 13,
        background: error ? t.warnBg : t.surfaceAlt,
        color: error ? t.danger : t.text,
      }}
    >
      <span style={{ flex: 1 }}>{notice.text}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        style={{ border: 'none', background: 'none', color: t.muted, cursor: 'pointer' }}
      >
        ✕
      </button>
    </div>
  );
}

function box(t: Theme): CSSProperties {
  return {
    maxHeight: 'calc(100vh - 260px)',
    minHeight: 120,
    overflow: 'auto',
    border: `1px solid ${t.border}`,
    borderRadius: 10,
    background: t.surface,
  };
}

function th(t: Theme): CSSProperties {
  return {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    background: t.surface,
    borderBottom: `1px solid ${t.border}`,
    padding: 0,
    textAlign: 'left',
  };
}

function headButton(t: Theme): CSSProperties {
  return {
    width: '100%',
    padding: '8px 10px',
    border: 'none',
    background: 'none',
    color: t.muted,
    font: 'inherit',
    fontSize: 12,
    fontWeight: 650,
    textAlign: 'left',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

function td(t: Theme): CSSProperties {
  return {
    padding: '7px 10px',
    borderBottom: `1px solid ${t.border}`,
    fontSize: 13,
    verticalAlign: 'top',
  };
}

export function input(t: Theme): CSSProperties {
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
