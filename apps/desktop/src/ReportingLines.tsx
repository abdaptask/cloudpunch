import { useEffect, useState, type CSSProperties } from 'react';
import { api, type EmployeeRow, type Person } from './api.js';
import { useTheme, type Theme } from './ui/theme.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: "Your role can't change reporting lines.",
  manager_loop: 'That would make a reporting loop.',
  self_manager: "Someone can't be their own manager.",
  manager_not_found: 'That manager is no longer active.',
};
/** Roles that can see others' time (`team.timeline.read`). */
const MONITOR_ROLES = ['Manager', 'HR'];

const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/**
 * Reporting lines (ADR-0025 §1), under People: who each person reports
 * to. A Manager sees their direct reports in the Team tab. The server
 * refuses loops and audits every change. greytHR takes this over later.
 *
 * Only people who can see others' time (the Manager or HR role) are
 * offered as managers. Records follow roles (ADR-0020 §4, amended):
 * someone given Manager before that came with a record gets one here,
 * and someone whose roles were removed before it turned the record off
 * can be taken off the list here.
 */
export function ReportingLines(): JSX.Element {
  const t = useTheme();
  const [rows, setRows] = useState<EmployeeRow[] | null>(null);
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  // Roles by Entra id, to warn about managers without the Manager role.
  const [people, setPeople] = useState<Person[] | null>(null);
  useEffect(() => {
    let current = true;
    api.adminPeople().then(
      (r) => {
        if (current) setPeople(r.people);
      },
      () => undefined,
    );
    api.adminEmployees().then(
      (r) => {
        if (current) setRows(r.employees);
      },
      (e: unknown) => {
        if (current) setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const monitors = (r: EmployeeRow): boolean => {
    const p = r.oid ? people?.find((x) => x.oid === r.oid) : undefined;
    return !!p && MONITOR_ROLES.some((role) => p.roles.includes(role));
  };
  /** Offered as a manager: a monitoring role, or already this person's manager. */
  const offered = (row: EmployeeRow, m: EmployeeRow): boolean =>
    m.id !== row.id && (people === null || monitors(m) || m.id === row.reporting_manager_id);
  /** Monitoring roles without an employee record yet: can't be picked until they have one. */
  const noRecord =
    people?.filter(
      (p) => !p.has_employee_record && MONITOR_ROLES.some((role) => p.roles.includes(role)),
    ) ?? [];

  /** Listed, but no CloudPunch role left: their record outlived the roles. */
  const roleless = (r: EmployeeRow): boolean =>
    people !== null && !!r.oid && !people.some((p) => p.oid === r.oid);

  const remove = (row: EmployeeRow): void => {
    if (!row.oid) return;
    setSaving(row.id);
    setStatus(null);
    // Saving no roles turns the record off (the server does it).
    api
      .adminPeopleSetRoles(row.oid, [], reason || 'No CloudPunch role')
      .then((r) =>
        api
          .adminEmployees()
          .then((e) => ({ freed: r.unassigned_reports ?? [], rows: e.employees })),
      )
      .then(
        ({ freed, rows: next }) => {
          setSaving(null);
          setRows(next);
          const names = freed.map((x) => x.name);
          setStatus({
            kind: 'saved',
            text:
              `${row.name} is off the list; their history is kept.` +
              (names.length > 0
                ? ` ${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} no manager now.`
                : ''),
          });
        },
        (e: unknown) => {
          setSaving(null);
          setStatus({ kind: 'error', text: errorText(String(e)) });
        },
      );
  };

  const addRecord = (p: Person): void => {
    setSaving(p.oid);
    setStatus(null);
    // Saving the same roles adds the missing record (the server does it).
    api
      .adminPeopleSetRoles(p.oid, p.roles, reason || 'Record for reporting lines')
      .then(() => api.adminEmployees())
      .then(
        (r) => {
          setSaving(null);
          setRows(r.employees);
          setPeople(
            (ps) =>
              ps?.map((x) => (x.oid === p.oid ? { ...x, has_employee_record: true } : x)) ?? ps,
          );
          setStatus({ kind: 'saved', text: `${p.name} can now be picked as a manager.` });
        },
        (e: unknown) => {
          setSaving(null);
          setStatus({ kind: 'error', text: errorText(String(e)) });
        },
      );
  };

  /** A manager whose Team tab won't show: no Manager (or HR) role. */
  const lacksRole = (managerId: string | null): Person | null => {
    const m = rows?.find((r) => r.id === managerId);
    const p = m?.oid ? people?.find((x) => x.oid === m.oid) : undefined;
    if (!p) return null;
    return p.roles.includes('Manager') || p.roles.includes('HR') ? null : p;
  };

  const giveManager = (p: Person): void => {
    setSaving(p.oid);
    setStatus(null);
    const roles = [...new Set([...p.roles, 'Manager'])];
    api.adminPeopleSetRoles(p.oid, roles, reason || 'Manager for reporting lines').then(
      () => {
        setSaving(null);
        setPeople((ps) => ps?.map((x) => (x.oid === p.oid ? { ...x, roles } : x)) ?? ps);
        setStatus({
          kind: 'saved',
          text: `${p.name} now has the Manager role. They see the Team tab after signing in again.`,
        });
      },
      (e: unknown) => {
        setSaving(null);
        setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };

  const change = (row: EmployeeRow, managerId: string | null): void => {
    setSaving(row.id);
    setStatus(null);
    api.adminSetManager(row.id, managerId, reason).then(
      () => {
        setSaving(null);
        setRows((rs) =>
          rs
            ? rs.map((r) => (r.id === row.id ? { ...r, reporting_manager_id: managerId } : r))
            : rs,
        );
        const manager = rows?.find((r) => r.id === managerId)?.name;
        setStatus({
          kind: 'saved',
          text: manager
            ? `${row.name} now reports to ${manager}.`
            : `${row.name} has no manager now.`,
        });
      },
      (e: unknown) => {
        setSaving(null);
        setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };

  return (
    <section
      aria-label="reporting-lines"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        border: `1px solid ${t.border}`,
        borderRadius: 12,
        background: t.surface,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 650 }}>Reporting lines</h3>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.4, color: t.muted }}>
        Who each person reports to. Managers see their direct reports in the Team tab. Only people
        with the Manager or HR role are offered as managers.
      </p>
      {noRecord.map((p) => (
        <span key={p.oid} role="note" style={{ fontSize: 12, color: t.warnText }}>
          {p.name} has the {p.roles.includes('Manager') ? 'Manager' : 'HR'} role but no CloudPunch
          record yet, so they can&apos;t be picked as a manager.{' '}
          <button
            type="button"
            disabled={saving === p.oid}
            onClick={() => addRecord(p)}
            style={{
              padding: 0,
              border: 'none',
              background: 'none',
              color: t.accent,
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            Add {p.name}&apos;s record
          </button>
        </span>
      ))}
      <label
        style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: t.muted }}
      >
        Why (kept in the audit log, optional)
        <input
          aria-label="reporting-reason"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          style={input(t)}
        />
      </label>
      {!rows && !status && <span style={{ fontSize: 13, color: t.muted }}>Loading…</span>}
      {rows?.map((row) => {
        const missing = lacksRole(row.reporting_manager_id);
        return (
          <div key={row.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <span style={{ flex: 1, minWidth: 0 }}>{row.name}</span>
              <select
                aria-label={`manager of ${row.name}`}
                value={row.reporting_manager_id ?? ''}
                disabled={saving === row.id}
                onChange={(e) => change(row, e.target.value || null)}
                style={{ ...input(t), maxWidth: 180 }}
              >
                <option value="">No manager</option>
                {rows
                  .filter((m) => offered(row, m))
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
            {roleless(row) && (
              <span role="note" style={{ fontSize: 12, color: t.muted }}>
                {row.name} has no CloudPunch role.{' '}
                <button
                  type="button"
                  disabled={saving === row.id}
                  onClick={() => remove(row)}
                  style={{
                    padding: 0,
                    border: 'none',
                    background: 'none',
                    color: t.accent,
                    font: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  Remove {row.name} from this list
                </button>
              </span>
            )}
            {missing && (
              <span role="note" style={{ fontSize: 12, color: t.warnText }}>
                {missing.name} doesn&apos;t have the Manager role yet, so they won&apos;t see the
                Team tab.{' '}
                <button
                  type="button"
                  disabled={saving === missing.oid}
                  onClick={() => giveManager(missing)}
                  style={{
                    padding: 0,
                    border: 'none',
                    background: 'none',
                    color: t.accent,
                    font: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  Give {missing.name} the Manager role
                </button>
              </span>
            )}
          </div>
        );
      })}
      {status && (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          style={{ margin: 0, fontSize: 13, color: status.kind === 'error' ? t.danger : t.text }}
        >
          {status.text}
        </p>
      )}
    </section>
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
