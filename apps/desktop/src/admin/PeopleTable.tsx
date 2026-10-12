import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  api,
  type DirectoryUser,
  type EmployeeRow,
  type Person,
  type ShiftRow,
  type ShiftTemplate,
} from '../api.js';
import { ERROR_TEXT, ROLES } from '../PeopleScreen.js';
import { shiftText } from '../ShiftEditor.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { BULK_LABEL, BulkPanel, type BulkAction } from './BulkPanel.js';
import {
  FLAGS,
  MAX_BULK,
  NO_FILTER,
  PAGE_SIZE,
  applyFilter,
  attention,
  buildRows,
  flagText,
  pageOf,
  sortRows,
  statusOf,
  type Filter,
  type PersonRow,
  type Sort,
  type SortKey,
} from './peopleModel.js';
import { PersonPanel } from './PersonPanel.js';

const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/**
 * People in the admin console (ADR-0038 §3): one table of everyone, with
 * their roles, manager, shift and what needs doing; search, filters and
 * the needs-attention counts above it. A row opens the person panel
 * beside the table. Shifts are Administrators' only: for HR the Shift
 * column is left out.
 */
export function PeopleTable({
  canAssignAll,
  canSignOutMachines = false,
  onClose,
}: {
  canAssignAll: boolean;
  canSignOutMachines?: boolean;
  onClose: () => void;
}): JSX.Element {
  const t = useTheme();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeRow[] | null>(null);
  const [shifts, setShifts] = useState<ShiftRow[] | null>(null);
  // Named shifts (ADR-0038 §6): Administrators only, like shifts.
  const [templates, setTemplates] = useState<ShiftTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 'asc' });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  // Someone picked from the directory who isn't in the table yet.
  const [added, setAdded] = useState<PersonRow | null>(null);
  const [adding, setAdding] = useState(false);
  // Ticked for a bulk change (ADR-0038 §5), by row key; kept across pages.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);

  const load = (): void => {
    api.adminPeople().then(
      (r) => setPeople(r.people),
      (e: unknown) => setError(errorText(String(e))),
    );
    api.adminEmployees().then(
      (r) => setEmployees(r.employees),
      (e: unknown) => setError(errorText(String(e))),
    );
    api.adminShifts().then(
      (r) => setShifts(r.people),
      () => setShifts(null),
    );
    api.adminShiftTemplates().then(
      (r) => setTemplates(r.templates),
      () => setTemplates(null),
    );
  };
  useEffect(load, []);

  const rows = people && employees ? buildRows(people, employees, shifts) : null;
  const showShift = shifts !== null;
  const counts = rows ? attention(rows) : null;
  const managers = rows
    ? rows.filter((r) => r.employeeId !== null && rows.some((x) => x.managerId === r.employeeId))
    : [];
  const sortText = (r: PersonRow): string => {
    switch (sort.key) {
      case 'name':
        return r.name;
      case 'roles':
        return r.roles.join(', ');
      case 'manager':
        return r.managerName ?? '';
      case 'shift':
        return r.shift ? (r.template?.name ?? shiftText(r.shift)) : '';
      case 'status':
        return rows ? statusOf(r, rows).join(', ') : '';
    }
  };
  const matching = rows ? sortRows(applyFilter(rows, filter), sort, sortText) : [];
  const shown = pageOf(matching, page);
  const open =
    rows?.find((r) => r.key === selected) ?? (added?.key === selected ? added : undefined);
  const picked = rows?.filter((r) => ticked.has(r.key)) ?? [];
  const pageTicked = shown.rows.length > 0 && shown.rows.every((r) => ticked.has(r.key));
  const tick = (keys: readonly string[], on: boolean): void =>
    setTicked((was) => {
      const next = new Set(was);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  const select = (key: string): void => {
    setBulk(null);
    setSelected(key);
  };

  const refine = (f: Partial<Filter>): void => {
    setFilter((x) => ({ ...x, ...f }));
    setPage(0);
  };
  const sortBy = (key: SortKey): void =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
  const pickFromDirectory = (u: DirectoryUser): void => {
    setAdding(false);
    if (!rows?.some((r) => r.oid === u.oid)) {
      setAdded({
        key: u.oid,
        oid: u.oid,
        employeeId: null,
        name: u.name,
        email: u.email,
        roles: [],
        managerId: null,
        managerName: null,
        shift: showShift ? null : undefined,
        template: null,
      });
    }
    setSelected(u.oid);
  };

  const columns: { key: SortKey; label: string }[] = [
    { key: 'name', label: 'Name' },
    { key: 'roles', label: 'Roles' },
    { key: 'manager', label: 'Manager' },
    ...(showShift ? [{ key: 'shift' as const, label: 'Shift' }] : []),
    { key: 'status', label: 'Status' },
  ];

  return (
    <section aria-label="people" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650, flex: 1 }}>People</h2>
        <button type="button" onClick={() => setAdding((a) => !a)} style={link(t)}>
          Add person
        </button>
        <button type="button" onClick={onClose} style={link(t)}>
          Done
        </button>
      </div>

      {adding && <DirectorySearch onPick={pickFromDirectory} onError={setError} t={t} />}

      {counts && FLAGS.some((f) => counts[f] > 0) && (
        <div
          role="group"
          aria-label="needs-attention"
          style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
        >
          {FLAGS.filter((f) => counts[f] > 0).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter.flag === f}
              onClick={() => refine({ flag: filter.flag === f ? null : f })}
              style={chip(t, filter.flag === f)}
            >
              {flagText(f, counts[f])}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          aria-label="people-find"
          placeholder="Find by name or email"
          value={filter.q}
          onChange={(e) => refine({ q: e.target.value })}
          style={{ ...input(t), flex: 1, minWidth: 160 }}
        />
        <select
          aria-label="filter-role"
          value={filter.role}
          onChange={(e) => refine({ role: e.target.value })}
          style={input(t)}
        >
          <option value="">Any role</option>
          {ROLES.map(([role]) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <select
          aria-label="filter-manager"
          value={filter.managerId}
          onChange={(e) => refine({ managerId: e.target.value })}
          style={input(t)}
        >
          <option value="">Any manager</option>
          {managers.map((m) => (
            <option key={m.key} value={m.employeeId ?? ''}>
              Reports to {m.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger }}>
          {error}
        </p>
      )}
      {!rows && !error && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}

      {rows && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ticked.size > 0 && (
              <div role="toolbar" aria-label="bulk-actions" style={bulkBar(t)}>
                <strong style={{ fontWeight: 650 }}>{ticked.size} selected</strong>
                {!pageTicked || matching.every((r) => ticked.has(r.key)) ? null : (
                  <button
                    type="button"
                    onClick={() =>
                      tick(
                        matching.map((r) => r.key),
                        true,
                      )
                    }
                    style={link(t)}
                  >
                    Select all {matching.length} matching
                  </button>
                )}
                <span style={{ flex: 1 }} />
                {ticked.size > MAX_BULK ? (
                  <span style={{ color: t.warnText }}>At most {MAX_BULK} at a time</span>
                ) : (
                  (Object.keys(BULK_LABEL) as BulkAction[])
                    // Shifts are Administrators' only.
                    .filter((a) => a !== 'shift' || showShift)
                    .map((a) => (
                      <button
                        key={a}
                        type="button"
                        aria-pressed={bulk === a}
                        onClick={() => {
                          setSelected(null);
                          setBulk(a);
                        }}
                        style={{ ...link(t), fontWeight: bulk === a ? 650 : 400 }}
                      >
                        {BULK_LABEL[a]}
                      </button>
                    ))
                )}
                <button
                  type="button"
                  onClick={() => {
                    setTicked(new Set());
                    setBulk(null);
                  }}
                  style={{ ...link(t), color: t.muted }}
                >
                  Clear
                </button>
              </div>
            )}
            {/* Scrolls inside, so the header row stays put. */}
            <div style={tableBox(t)}>
              <table
                aria-label="people-table"
                style={{ width: '100%', borderCollapse: 'collapse' }}
              >
                <thead>
                  <tr>
                    <th style={{ ...th(t), width: 28, padding: '0 0 0 10px' }}>
                      <input
                        type="checkbox"
                        aria-label="select this page"
                        checked={pageTicked}
                        onChange={(e) =>
                          tick(
                            shown.rows.map((r) => r.key),
                            e.target.checked,
                          )
                        }
                      />
                    </th>
                    {columns.map((c) => (
                      <th
                        key={c.key}
                        aria-sort={
                          sort.key === c.key
                            ? sort.dir === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : undefined
                        }
                        style={th(t)}
                      >
                        <button type="button" onClick={() => sortBy(c.key)} style={headButton(t)}>
                          {c.label}
                          {sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.rows.map((r) => {
                    const status = statusOf(r, rows);
                    const on = r.key === selected;
                    return (
                      <tr
                        key={r.key}
                        onClick={() => select(r.key)}
                        style={{ cursor: 'pointer', background: on ? t.surfaceAlt : undefined }}
                      >
                        <td
                          style={{ ...td(t), padding: '6px 0 6px 10px' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`select ${r.name}`}
                            checked={ticked.has(r.key)}
                            onChange={(e) => tick([r.key], e.target.checked)}
                          />
                        </td>
                        <td style={td(t)}>
                          <button
                            type="button"
                            aria-current={on ? 'true' : undefined}
                            onClick={(e) => {
                              e.stopPropagation();
                              select(r.key);
                            }}
                            style={nameButton(t)}
                          >
                            {r.name}
                          </button>
                          {r.email && (
                            <div style={{ fontSize: 11.5, color: t.muted, ...clip }}>{r.email}</div>
                          )}
                        </td>
                        <td style={td(t)}>
                          <span style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                            {r.roles.map((role) => (
                              <span key={role} style={roleChip(t)}>
                                {role}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td style={{ ...td(t), ...clip }}>
                          {r.managerName ?? <span style={{ color: t.muted }}>—</span>}
                        </td>
                        {showShift && (
                          <td style={{ ...td(t), fontSize: 12 }}>
                            {r.shift ? (
                              <span title={shiftText(r.shift)}>
                                {r.template?.name ?? shiftText(r.shift)}
                              </span>
                            ) : (
                              <span style={{ color: t.muted }}>—</span>
                            )}
                          </td>
                        )}
                        <td style={td(t)}>
                          {status.length === 0 ? (
                            <span style={{ color: t.muted }}>✓</span>
                          ) : (
                            <span style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                              {status.map((s) => (
                                <span key={s} style={warnChip(t)}>
                                  {s}
                                </span>
                              ))}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {matching.length === 0 && (
                <p style={{ margin: 12, fontSize: 13, color: t.muted }}>Nobody matches.</p>
              )}
            </div>
            <div
              aria-label="people-pages"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                fontSize: 12.5,
                color: t.muted,
              }}
            >
              <span style={{ flex: 1 }}>
                {matching.length === 0
                  ? `0 of ${rows.length}`
                  : `${shown.page * PAGE_SIZE + 1}–${shown.page * PAGE_SIZE + shown.rows.length} of ${matching.length}`}
                {matching.length !== rows.length && ` (${rows.length} in all)`}
              </span>
              {shown.pages > 1 && (
                <>
                  <button
                    type="button"
                    disabled={shown.page === 0}
                    onClick={() => setPage(shown.page - 1)}
                    style={link(t)}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={shown.page >= shown.pages - 1}
                    onClick={() => setPage(shown.page + 1)}
                    style={link(t)}
                  >
                    Next
                  </button>
                </>
              )}
            </div>
          </div>
          {bulk && picked.length > 0 ? (
            <BulkPanel
              templates={templates}
              key={`${bulk}:${[...ticked].sort().join()}`}
              action={bulk}
              picked={picked}
              rows={rows}
              canAssignAll={canAssignAll}
              onChanged={load}
              onClose={() => setBulk(null)}
            />
          ) : (
            open && (
              <PersonPanel
                templates={templates}
                key={open.key}
                row={open}
                rows={rows}
                canAssignAll={canAssignAll}
                canSignOutMachines={canSignOutMachines}
                onChanged={load}
                onClose={() => setSelected(null)}
              />
            )
          )}
        </div>
      )}
    </section>
  );
}

/** Add person: search the company directory (ADR-0020), debounced. */
function DirectorySearch({
  onPick,
  onError,
  t,
}: {
  onPick: (u: DirectoryUser) => void;
  onError: (text: string) => void;
  t: Theme;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      api.adminPeopleSearch(q).then(
        (r) => {
          if (mine === seq.current) setResults(r.users);
        },
        (e: unknown) => {
          if (mine === seq.current) onError(errorText(String(e)));
        },
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, onError]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input
        aria-label="people-search"
        placeholder="Search the company directory by name or email"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={input(t)}
      />
      {results.length > 0 && (
        <ul aria-label="search-results" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {results.map((u) => (
            <li key={u.oid}>
              <button type="button" onClick={() => onPick(u)} style={resultButton(t)}>
                <span style={{ fontWeight: 600 }}>{u.name}</span>
                <span style={{ color: t.muted, fontSize: 12 }}>{u.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const clip: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: 180,
};

function bulkBar(t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    padding: '8px 12px',
    borderRadius: 10,
    border: `1px solid ${t.accent}`,
    background: t.surfaceAlt,
    fontSize: 13,
  };
}

function tableBox(t: Theme): CSSProperties {
  return {
    maxHeight: 'calc(100vh - 240px)',
    minHeight: 160,
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
    padding: '6px 10px',
    borderBottom: `1px solid ${t.border}`,
    fontSize: 13,
    verticalAlign: 'top',
  };
}

function nameButton(t: Theme): CSSProperties {
  return {
    padding: 0,
    border: 'none',
    background: 'none',
    color: t.text,
    font: 'inherit',
    fontSize: 13,
    fontWeight: 600,
    textAlign: 'left',
    cursor: 'pointer',
  };
}

function roleChip(t: Theme): CSSProperties {
  return {
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 999,
    border: `1px solid ${t.border}`,
    color: t.muted,
    whiteSpace: 'nowrap',
  };
}

function warnChip(t: Theme): CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 600,
    padding: '1px 6px',
    borderRadius: 999,
    background: t.warnBg,
    color: t.warnText,
    whiteSpace: 'nowrap',
  };
}

function chip(t: Theme, on: boolean): CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: 999,
    border: `1px solid ${on ? t.accent : t.border}`,
    background: on ? t.surfaceAlt : t.warnBg,
    color: on ? t.accent : t.warnText,
    font: 'inherit',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  };
}

function resultButton(t: Theme): CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    gap: 8,
    alignItems: 'baseline',
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
