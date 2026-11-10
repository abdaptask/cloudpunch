import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  api,
  type DeactivatedPerson,
  type DirectoryUser,
  type EmployeeRow,
  type Person,
  type ShiftRow,
  type OfficeDays,
  type ShiftTemplate,
} from '../api.js';
import { officeText } from './OfficeDaysPart.js';
import { ERROR_TEXT, ROLES } from './peopleParts.js';
import { shiftText } from '../ShiftEditor.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { BULK_LABEL, BulkPanel, type BulkAction } from './BulkPanel.js';
import {
  CHECKS,
  CHECK_LABEL,
  MAX_BULK,
  NO_FILTER,
  PAGE_SIZE,
  applyFilter,
  buildRows,
  checkCounts,
  pageOf,
  sortRows,
  statusOf,
  type Check,
  type Filter,
  type PersonRow,
  type Sort,
  type SortKey,
  type StatusFilter,
} from './peopleModel.js';
import { PersonPanel } from './PersonPanel.js';
import { DeactivatedPanel } from './DeactivatedPeople.js';
import type { PanelFocus } from './panelFocus.js';
import {
  DeactivateBulkPanel,
  DeactivatedNotice,
  canDeactivate,
  type Deactivated,
} from './DeactivateParts.js';
import {
  AlertIcon,
  HistoryIcon,
  KeyIcon,
  MailIcon,
  RefreshIcon,
  ResetIcon,
  SearchIcon,
  UserCheckIcon,
  UserXIcon,
} from './icons.js';

const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/**
 * People in the admin console (ADR-0038 §3, laid out per ADR-0054): one
 * table of everyone, active and deactivated, with a Status filter
 * (Active by default), role and manager dropdowns, tick-box filters,
 * badges for roles and status, and a row of action icons that open the
 * person's panel at the right part. Shifts are Administrators' only:
 * for HR the Shift column is left out.
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
  // Deactivated records (ADR-0053), shown as Inactive.
  const [inactive, setInactive] = useState<DeactivatedPerson[]>([]);
  // Named shifts (ADR-0038 §6): Administrators only, like shifts.
  const [templates, setTemplates] = useState<ShiftTemplate[] | null>(null);
  // In-office days (ADR-0039), the next 60 days.
  const [office, setOffice] = useState<OfficeDays[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 'asc' });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  // Which part of the panel an action icon asked for.
  const [focus, setFocus] = useState<PanelFocus | null>(null);
  // Someone picked from the directory who isn't in the table yet.
  const [added, setAdded] = useState<PersonRow | null>(null);
  const [adding, setAdding] = useState(false);
  // Ticked for a bulk change (ADR-0038 §5), by row key; kept across pages.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  // The last deactivation's answer (ADR-0052), kept while the list reloads.
  const [deactivated, setDeactivated] = useState<Deactivated | null>(null);
  // The last reactivation, said above the table (ADR-0053).
  const [reactivated, setReactivated] = useState<string | null>(null);
  const onDeactivated = (d: Deactivated): void => {
    setSelected(null);
    setBulk(null);
    setTicked(new Set());
    setDeactivated(d);
    load();
  };

  const load = (): void => {
    api.adminPeople().then(
      (r) => setPeople(r.people),
      (e: unknown) => setError(errorText(String(e))),
    );
    api.adminEmployees().then(
      (r) => setEmployees(r.employees),
      (e: unknown) => setError(errorText(String(e))),
    );
    api.adminDeactivatedPeople().then(
      (r) => setInactive(r.people),
      () => setInactive([]),
    );
    api.adminShifts().then(
      (r) => setShifts(r.people),
      () => setShifts(null),
    );
    const today = new Date().toISOString().slice(0, 10);
    const ahead = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    api.adminOfficeDays(today, ahead).then(
      (r) => setOffice(r.people),
      () => setOffice(null),
    );
    api.adminShiftTemplates().then(
      (r) => setTemplates(r.templates),
      () => setTemplates(null),
    );
  };
  useEffect(load, []);

  const rows = people && employees ? buildRows(people, employees, shifts, office, inactive) : null;
  const showShift = shifts !== null;
  const counts = rows ? checkCounts(rows, filter.status) : null;
  const managers = rows
    ? rows.filter(
        (r) =>
          r.active &&
          r.employeeId !== null &&
          rows.some((x) => x.active && x.managerId === r.employeeId),
      )
    : [];
  const sortText = (r: PersonRow): string => {
    switch (sort.key) {
      case 'name':
        return r.name;
      case 'email':
        return r.email ?? '';
      case 'roles':
        return r.roles.join(', ');
      case 'manager':
        return r.managerName ?? '';
      case 'shift':
        return r.shift ? (r.template?.name ?? shiftText(r.shift)) : '';
      case 'office':
        return r.office && r.office.weekdays.length > 0 ? officeText(r.office.weekdays) : '';
      case 'status':
        return r.active ? 'Active' : 'Inactive';
    }
  };
  const matching = rows ? sortRows(applyFilter(rows, filter), sort, sortText) : [];
  const shown = pageOf(matching, page);
  const open =
    rows?.find((r) => r.key === selected) ?? (added?.key === selected ? added : undefined);
  const picked = rows?.filter((r) => ticked.has(r.key)) ?? [];
  const tickable = shown.rows.filter((r) => r.active);
  const pageTicked = tickable.length > 0 && tickable.every((r) => ticked.has(r.key));
  const tick = (keys: readonly string[], on: boolean): void =>
    setTicked((was) => {
      const next = new Set(was);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  const select = (key: string, at: PanelFocus | null = null): void => {
    setBulk(null);
    setSelected(key);
    setFocus(at);
  };

  const refine = (f: Partial<Filter>): void => {
    setFilter((x) => ({ ...x, ...f }));
    setPage(0);
  };
  const toggleCheck = (c: Check): void =>
    refine({
      checks: filter.checks.includes(c)
        ? filter.checks.filter((x) => x !== c)
        : [...filter.checks, c],
    });
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
        active: true,
        deactivated: null,
      });
    }
    select(u.oid);
  };

  // With a panel open, Email, Shift and Office step aside (the panel has
  // them), so Status and Actions stay in view.
  const narrow = open !== undefined || (bulk !== null && picked.length > 0);
  const showEmail = !narrow;
  const shiftCol = showShift && !narrow;
  const officeCol = office !== null && !narrow;
  const columns: { key: SortKey | 'actions'; label: string }[] = [
    { key: 'name', label: 'Name' },
    ...(showEmail ? [{ key: 'email' as const, label: 'Email' }] : []),
    { key: 'manager', label: 'Manager' },
    { key: 'roles', label: 'Roles' },
    ...(shiftCol ? [{ key: 'shift' as const, label: 'Shift' }] : []),
    ...(officeCol ? [{ key: 'office' as const, label: 'Office' }] : []),
    { key: 'status', label: 'Status' },
    { key: 'actions', label: 'Actions' },
  ];

  return (
    <section aria-label="people" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650 }}>People</h2>
          {rows && (
            <div aria-label="people-count" style={{ fontSize: 12.5, color: t.muted }}>
              {matching.length} of {rows.length} people
            </div>
          )}
        </div>
        <button type="button" onClick={() => setAdding((a) => !a)} style={link(t)}>
          Add person
        </button>
        <button type="button" onClick={onClose} style={link(t)}>
          Done
        </button>
      </div>

      {adding && <DirectorySearch onPick={pickFromDirectory} onError={setError} t={t} />}

      <div style={{ display: 'flex', gap: 8 }}>
        <label style={searchBox(t)}>
          <span style={{ color: t.muted, display: 'flex' }}>
            <SearchIcon />
          </span>
          <input
            aria-label="people-find"
            placeholder="Search by name or email…"
            value={filter.q}
            onChange={(e) => refine({ q: e.target.value })}
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: t.text,
              font: 'inherit',
              fontSize: 13.5,
            }}
          />
        </label>
        <button
          type="button"
          aria-label="Reset filters"
          title="Reset filters"
          onClick={() => {
            setFilter(NO_FILTER);
            setPage(0);
          }}
          style={squareButton(t)}
        >
          <ResetIcon />
        </button>
        <button
          type="button"
          aria-label="Reload"
          title="Reload"
          onClick={load}
          style={squareButton(t)}
        >
          <RefreshIcon />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          aria-label="filter-role"
          value={filter.role}
          onChange={(e) => refine({ role: e.target.value })}
          style={dropdown(t)}
        >
          <option value="">All roles</option>
          {ROLES.map(([role]) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <select
          aria-label="filter-status"
          value={filter.status}
          onChange={(e) => refine({ status: e.target.value as StatusFilter })}
          style={dropdown(t)}
        >
          <option value="all">All status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <select
          aria-label="filter-manager"
          value={filter.managerId}
          onChange={(e) => refine({ managerId: e.target.value })}
          style={dropdown(t)}
        >
          <option value="">All managers</option>
          {managers.map((m) => (
            <option key={m.key} value={m.employeeId ?? ''}>
              Reports to {m.name}
            </option>
          ))}
        </select>
        {CHECKS.map((c) => (
          <label key={c} style={checkPill(t, filter.checks.includes(c))}>
            <input
              type="checkbox"
              aria-label={`only-${c}`}
              checked={filter.checks.includes(c)}
              onChange={() => toggleCheck(c)}
            />
            {CHECK_LABEL[c]}
            {counts && c !== 'managersOnly' && counts[c] > 0 && (
              <span style={{ color: t.warnText, fontWeight: 650 }}>{counts[c]}</span>
            )}
          </label>
        ))}
      </div>

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger }}>
          {error}
        </p>
      )}
      {!rows && !error && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}
      {deactivated && rows && (
        <DeactivatedNotice
          value={deactivated}
          rows={rows}
          onOpen={(key) => select(key)}
          onChange={(d) => {
            setDeactivated(d);
            load();
          }}
          onClose={() => setDeactivated(null)}
        />
      )}
      {reactivated && (
        <div role="status" aria-label="reactivated" style={notice(t)}>
          <span style={{ flex: 1 }}>{reactivated}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setReactivated(null)}
            style={link(t)}
          >
            ✕
          </button>
        </div>
      )}

      {rows && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div
            style={{
              flex: '1 1 560px',
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {ticked.size > 0 && (
              <div role="toolbar" aria-label="bulk-actions" style={bulkBar(t)}>
                <strong style={{ fontWeight: 650 }}>{ticked.size} selected</strong>
                {!pageTicked ||
                matching.filter((r) => r.active).every((r) => ticked.has(r.key)) ? null : (
                  <button
                    type="button"
                    onClick={() =>
                      tick(
                        matching.filter((r) => r.active).map((r) => r.key),
                        true,
                      )
                    }
                    style={link(t)}
                  >
                    Select all {matching.filter((r) => r.active).length} matching
                  </button>
                )}
                <span style={{ flex: 1 }} />
                {ticked.size > MAX_BULK ? (
                  <span style={{ color: t.warnText }}>At most {MAX_BULK} at a time</span>
                ) : (
                  (Object.keys(BULK_LABEL) as BulkAction[])
                    // Shifts are Administrators' only.
                    .filter(
                      (a) => (a !== 'shift' || showShift) && (a !== 'office' || office !== null),
                    )
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
                    <th style={{ ...th(t), width: 36, padding: '0 0 0 16px' }}>
                      <input
                        type="checkbox"
                        aria-label="select this page"
                        checked={pageTicked}
                        disabled={tickable.length === 0}
                        onChange={(e) =>
                          tick(
                            tickable.map((r) => r.key),
                            e.target.checked,
                          )
                        }
                      />
                    </th>
                    {columns.map((c) =>
                      c.key === 'actions' ? (
                        <th key={c.key} style={th(t)}>
                          <span style={headLabel(t)}>{c.label}</span>
                        </th>
                      ) : (
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
                          <button
                            type="button"
                            onClick={() => sortBy(c.key as SortKey)}
                            style={headButton(t)}
                          >
                            {c.label}
                            <span style={{ opacity: sort.key === c.key ? 1 : 0.45 }}>
                              {sort.key === c.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ' ⇅'}
                            </span>
                          </button>
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {shown.rows.map((r) => {
                    const needs = statusOf(r, rows);
                    const on = r.key === selected;
                    return (
                      <tr
                        key={r.key}
                        onClick={() => select(r.key)}
                        style={{
                          cursor: 'pointer',
                          background: on ? t.surfaceAlt : undefined,
                        }}
                      >
                        <td
                          style={{ ...td(t), padding: '12px 0 12px 16px' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`select ${r.name}`}
                            checked={ticked.has(r.key)}
                            disabled={!r.active}
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
                        </td>
                        {showEmail && (
                          <td style={{ ...td(t), ...clip }}>
                            {r.email ?? <span style={{ color: t.muted }}>—</span>}
                          </td>
                        )}
                        <td style={td(t)}>
                          {r.managerName ? (
                            <span style={outlineChip(t)}>{r.managerName}</span>
                          ) : (
                            <span style={{ color: t.muted }}>—</span>
                          )}
                        </td>
                        <td style={td(t)}>
                          {r.roles.length === 0 ? (
                            <span style={{ color: t.muted }}>—</span>
                          ) : (
                            <span style={{ display: 'flex', gap: 4 }}>
                              {r.roles.map((role) => (
                                <span key={role} style={roleBadge(t, role)}>
                                  {role}
                                </span>
                              ))}
                            </span>
                          )}
                        </td>
                        {shiftCol && (
                          <td style={{ ...td(t), fontSize: 12.5, whiteSpace: 'nowrap' }}>
                            {r.shift ? (
                              <span title={shiftText(r.shift)}>
                                {r.template?.name ?? shiftText(r.shift)}
                              </span>
                            ) : (
                              <span style={{ color: t.muted }}>—</span>
                            )}
                          </td>
                        )}
                        {officeCol && (
                          <td style={{ ...td(t), fontSize: 12.5, whiteSpace: 'nowrap' }}>
                            {r.office && r.office.weekdays.length > 0 ? (
                              officeText(r.office.weekdays)
                            ) : (
                              <span style={{ color: t.muted }}>—</span>
                            )}
                          </td>
                        )}
                        <td style={td(t)}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={statusBadge(t, r.active)}>
                              {r.active ? 'Active' : 'Inactive'}
                            </span>
                            {needs.length > 0 && (
                              <span
                                role="img"
                                aria-label={`needs: ${needs.join(', ')}`}
                                title={needs.join(' · ')}
                                style={{ color: t.warnText, display: 'flex' }}
                              >
                                <AlertIcon />
                              </span>
                            )}
                          </span>
                        </td>
                        <td style={{ ...td(t), whiteSpace: 'nowrap' }}>
                          <span
                            role="group"
                            aria-label={`actions for ${r.name}`}
                            style={{ display: 'flex', alignItems: 'center', gap: 2 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => select(r.key)}
                              style={{
                                ...actionButton(t.text),
                                fontWeight: 600,
                                padding: '4px 8px',
                              }}
                            >
                              {r.active ? 'Edit' : 'View'}
                            </button>
                            {r.active && r.oid !== null && (
                              <Action
                                label={`Roles of ${r.name}`}
                                title="Roles"
                                color={t.text}
                                onClick={() => select(r.key, 'roles')}
                              >
                                <KeyIcon />
                              </Action>
                            )}
                            {r.employeeId !== null && (
                              <Action
                                label={`History of ${r.name}`}
                                title="Time history and changes"
                                color={palette(t).blue}
                                onClick={() => select(r.key, 'history')}
                              >
                                <HistoryIcon />
                              </Action>
                            )}
                            {r.active && r.oid !== null && r.roles.includes('Employee') && (
                              <Action
                                label={`Welcome email to ${r.name}`}
                                title="Send the welcome email"
                                color={palette(t).purple}
                                onClick={() => select(r.key, 'welcome')}
                              >
                                <MailIcon />
                              </Action>
                            )}
                            {canDeactivate(r, canAssignAll) && (
                              <Action
                                label={`Deactivate ${r.name}`}
                                title="Deactivate (signs out, removes roles, stops emails)"
                                color={palette(t).orange}
                                onClick={() => select(r.key, 'deactivate')}
                              >
                                <UserXIcon />
                              </Action>
                            )}
                            {!r.active && r.oid !== null && (
                              <Action
                                label={`Reactivate ${r.name}`}
                                title="Reactivate (gives roles back, turns the record on)"
                                color={palette(t).green}
                                onClick={() => select(r.key, 'reactivate')}
                              >
                                <UserCheckIcon />
                              </Action>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {matching.length === 0 && (
                <p style={{ margin: 16, fontSize: 13, color: t.muted }}>Nobody matches.</p>
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
          {bulk === 'deactivate' && picked.length > 0 ? (
            <DeactivateBulkPanel
              key={[...ticked].sort().join()}
              picked={picked}
              canAssignAll={canAssignAll}
              onDone={onDeactivated}
              onClose={() => setBulk(null)}
            />
          ) : bulk && picked.length > 0 ? (
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
          ) : open && !open.active && open.deactivated ? (
            <DeactivatedPanel
              key={`${open.key}:${focus ?? ''}`}
              person={open.deactivated}
              canAssignAll={canAssignAll}
              focus={focus}
              onClose={() => setSelected(null)}
              onReactivated={(text) => {
                setSelected(null);
                setReactivated(text);
                load();
              }}
            />
          ) : (
            open && (
              <PersonPanel
                templates={templates}
                key={`${open.key}:${focus ?? ''}`}
                row={open}
                rows={rows}
                canAssignAll={canAssignAll}
                canSignOutMachines={canSignOutMachines}
                focus={focus}
                onChanged={load}
                onDeactivated={onDeactivated}
                onClose={() => setSelected(null)}
              />
            )
          )}
        </div>
      )}
    </section>
  );
}

/** One icon in the Actions column, with its tooltip. */
function Action({
  label,
  title,
  color,
  onClick,
  children,
}: {
  label: string;
  title: string;
  color: string;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      style={actionButton(color)}
    >
      {children}
    </button>
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
  maxWidth: 220,
};

/** Badge colours (ADR-0054), light and dark. */
function palette(t: Theme) {
  const dark = t.mode === 'dark';
  return {
    blue: dark ? '#60a5fa' : '#2563eb',
    purple: dark ? '#c084fc' : '#9333ea',
    orange: dark ? '#fb923c' : '#ea580c',
    green: dark ? '#4ade80' : '#16a34a',
  };
}

const ROLE_COLOURS: Record<
  string,
  { light: [string, string, string]; dark: [string, string, string] }
> = {
  // [background, text, border]
  Administrator: {
    light: ['#f3e8ff', '#7e22ce', '#e9d5ff'],
    dark: ['rgba(168,85,247,0.16)', '#d8b4fe', 'rgba(168,85,247,0.35)'],
  },
  HR: {
    light: ['#ccfbf1', '#0f766e', '#99f6e4'],
    dark: ['rgba(20,184,166,0.16)', '#5eead4', 'rgba(20,184,166,0.35)'],
  },
  Manager: {
    light: ['#dbeafe', '#1d4ed8', '#bfdbfe'],
    dark: ['rgba(59,130,246,0.16)', '#93c5fd', 'rgba(59,130,246,0.35)'],
  },
  Payroll: {
    light: ['#fef3c7', '#b45309', '#fde68a'],
    dark: ['rgba(245,158,11,0.16)', '#fcd34d', 'rgba(245,158,11,0.35)'],
  },
  Auditor: {
    light: ['#f1f5f9', '#475569', '#e2e8f0'],
    dark: ['rgba(148,163,184,0.16)', '#cbd5e1', 'rgba(148,163,184,0.35)'],
  },
};

function roleBadge(t: Theme, role: string): CSSProperties {
  const c = ROLE_COLOURS[role]?.[t.mode];
  return {
    fontSize: 11,
    fontWeight: 650,
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    padding: '3px 8px',
    borderRadius: 6,
    whiteSpace: 'nowrap',
    background: c ? c[0] : t.surface,
    color: c ? c[1] : t.text,
    border: `1px solid ${c ? c[2] : t.border}`,
  };
}

function statusBadge(t: Theme, active: boolean): CSSProperties {
  const dark = t.mode === 'dark';
  const [bg, fg, border] = active
    ? dark
      ? ['rgba(34,197,94,0.14)', '#86efac', 'rgba(34,197,94,0.35)']
      : ['#f0fdf4', '#15803d', '#bbf7d0']
    : dark
      ? ['rgba(239,68,68,0.14)', '#fca5a5', 'rgba(239,68,68,0.35)']
      : ['#fef2f2', '#b91c1c', '#fecaca'];
  return {
    fontSize: 12,
    fontWeight: 650,
    padding: '3px 10px',
    borderRadius: 6,
    whiteSpace: 'nowrap',
    background: bg,
    color: fg,
    border: `1px solid ${border}`,
  };
}

function outlineChip(t: Theme): CSSProperties {
  return {
    display: 'inline-block',
    fontSize: 12,
    fontWeight: 600,
    padding: '3px 8px',
    borderRadius: 6,
    border: `1px solid ${t.border}`,
    background: t.surface,
    color: t.text,
    whiteSpace: 'nowrap',
  };
}

function actionButton(color: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 30,
    height: 30,
    padding: 0,
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    color,
    font: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
  };
}

function bulkBar(t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    padding: '8px 12px',
    borderRadius: 10,
    border: `1px solid ${t.border}`,
    background: t.surfaceAlt,
    fontSize: 13,
  };
}

function tableBox(t: Theme): CSSProperties {
  return {
    maxHeight: '70vh',
    overflow: 'auto',
    border: `1px solid ${t.border}`,
    borderRadius: 12,
    background: t.surface,
  };
}

function th(t: Theme): CSSProperties {
  return {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    padding: '0 12px',
    height: 44,
    background: t.surfaceAlt,
    borderBottom: `1px solid ${t.border}`,
    textAlign: 'left',
    verticalAlign: 'middle',
  };
}

function headLabel(t: Theme): CSSProperties {
  return {
    color: t.muted,
    fontSize: 11.5,
    fontWeight: 650,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  };
}

function headButton(t: Theme): CSSProperties {
  return {
    font: 'inherit',
    ...headLabel(t),
    padding: 0,
    border: 'none',
    background: 'none',
    textAlign: 'left',
    cursor: 'pointer',
  };
}

function td(t: Theme): CSSProperties {
  return {
    padding: '12px',
    borderBottom: `1px solid ${t.border}`,
    fontSize: 13.5,
    verticalAlign: 'middle',
  };
}

function nameButton(t: Theme): CSSProperties {
  return {
    whiteSpace: 'nowrap',
    padding: 0,
    border: 'none',
    background: 'none',
    color: palette(t).blue,
    font: 'inherit',
    fontSize: 14,
    fontWeight: 500,
    textAlign: 'left',
    cursor: 'pointer',
  };
}

function searchBox(t: Theme): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 14px',
    height: 40,
    borderRadius: 10,
    border: `1px solid ${t.border}`,
    background: t.surface,
  };
}

function squareButton(t: Theme): CSSProperties {
  return {
    width: 40,
    height: 40,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    border: `1px solid ${t.border}`,
    background: t.surface,
    color: t.text,
    cursor: 'pointer',
  };
}

function dropdown(t: Theme): CSSProperties {
  return {
    font: 'inherit',
    fontSize: 13.5,
    height: 38,
    padding: '0 10px',
    minWidth: 140,
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.surface,
    color: t.text,
  };
}

function checkPill(t: Theme, on: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    height: 38,
    padding: '0 12px',
    borderRadius: 8,
    border: `1px solid ${on ? t.accent : t.border}`,
    background: t.surface,
    color: t.text,
    fontSize: 13.5,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

function notice(t: Theme): CSSProperties {
  return {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
    padding: 10,
    borderRadius: 10,
    border: `1px solid ${t.border}`,
    background: t.surfaceAlt,
    fontSize: 12.5,
    lineHeight: 1.45,
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
