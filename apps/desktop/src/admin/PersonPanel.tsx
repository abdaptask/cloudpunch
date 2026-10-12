import { useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api.js';
import { ActiveMachineSection, ERROR_TEXT, HR_ASSIGNABLE, ROLES } from '../PeopleScreen.js';
import { ShiftForm, shiftText } from '../ShiftEditor.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { WelcomePanel } from '../WelcomePanel.js';
import { MANAGING_ROLES, managerChoices, type PersonRow } from './peopleModel.js';
import { ManagerPicker } from './ManagerPicker.js';

const MORE_ERRORS: Record<string, string> = {
  manager_loop: 'That would make a reporting loop.',
  self_manager: "Someone can't be their own manager.",
  manager_not_found: 'That manager is no longer active.',
};
const errorText = (code: string): string =>
  ERROR_TEXT[code] ?? MORE_ERRORS[code] ?? `Something went wrong (${code}).`;

type Status = { kind: 'error' | 'saved'; text: string } | null;

/**
 * The person panel (ADR-0038 §3): opens beside the People table, so the
 * table keeps its place. Roles, manager, shift, active machine and the
 * welcome email, each saved with the same call as today's screens. The
 * server checks every change and audits it.
 */
export function PersonPanel({
  row,
  rows,
  canAssignAll,
  canSignOutMachines,
  onChanged,
  onClose,
}: {
  row: PersonRow;
  /** Everyone, to offer managers and to name them. */
  rows: readonly PersonRow[];
  canAssignAll: boolean;
  canSignOutMachines: boolean;
  /** Something was saved: reload the table. */
  onChanged: () => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTheme();
  // Someone new from the directory starts with Employee ticked, as today.
  const [roles, setRoles] = useState<string[]>(
    row.roles.length === 0 && row.employeeId === null ? ['Employee'] : row.roles,
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [editingShift, setEditingShift] = useState(false);
  const [welcome, setWelcome] = useState(false);

  const rolesChanged = [...roles].sort().join() !== [...row.roles].sort().join();
  const fail = (e: unknown): void => {
    setBusy(false);
    setStatus({ kind: 'error', text: errorText(String(e)) });
  };

  const saveRoles = (): void => {
    if (!row.oid) return;
    setBusy(true);
    setStatus(null);
    const newEmployee = roles.includes('Employee') && !row.roles.includes('Employee');
    api.adminPeopleSetRoles(row.oid, roles, reason).then((r) => {
      setBusy(false);
      const freed = (r.unassigned_reports ?? []).map((x) => x.name);
      setStatus({
        kind: 'saved',
        text:
          roles.length === 0
            ? `Saved. ${row.name} has no CloudPunch roles now; their history is kept.` +
              (freed.length > 0
                ? ` ${freed.join(', ')} ${freed.length === 1 ? 'has' : 'have'} no manager now.`
                : '')
            : `Saved. ${row.name} gets the new roles at their next sign-in (within an hour).`,
      });
      if (newEmployee) setWelcome(true);
      onChanged();
    }, fail);
  };

  const setManager = (managerId: string | null): void => {
    if (!row.employeeId) return;
    setBusy(true);
    setStatus(null);
    api.adminSetManager(row.employeeId, managerId, reason).then(() => {
      setBusy(false);
      const name = rows.find((r) => r.employeeId === managerId)?.name;
      setStatus({
        kind: 'saved',
        text: name ? `${row.name} now reports to ${name}.` : `${row.name} has no manager now.`,
      });
      onChanged();
    }, fail);
  };

  // Their manager can't see the Team tab without the Manager (or HR) role.
  const manager = rows.find((r) => r.employeeId !== null && r.employeeId === row.managerId);
  const managerLacksRole =
    manager !== undefined && !MANAGING_ROLES.some((role) => manager.roles.includes(role));
  const giveManagerRole = (): void => {
    if (!manager?.oid) return;
    setBusy(true);
    setStatus(null);
    const next = [...new Set([...manager.roles, 'Manager'])];
    api.adminPeopleSetRoles(manager.oid, next, reason || 'Manager for reporting lines').then(() => {
      setBusy(false);
      setStatus({
        kind: 'saved',
        text: `${manager.name} now has the Manager role. They see the Team tab after signing in again.`,
      });
      onChanged();
    }, fail);
  };

  return (
    <aside aria-label={`person ${row.name}`} style={panel(t)}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 650 }}>{row.name}</div>
          {row.email && <div style={{ fontSize: 12, color: t.muted }}>{row.email}</div>}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} style={link(t)}>
          ✕
        </button>
      </div>

      <Part title="Roles" t={t}>
        {row.oid === null ? (
          <span style={{ fontSize: 12.5, color: t.muted }}>
            Not linked to a Microsoft account, so roles can&apos;t be set here.
          </span>
        ) : (
          <>
            {ROLES.map(([role, what]) => {
              const allowed = canAssignAll || HR_ASSIGNABLE.includes(role);
              return (
                <label key={role} style={{ ...check, opacity: allowed ? 1 : 0.5 }} title={what}>
                  <input
                    type="checkbox"
                    aria-label={`role-${role}`}
                    checked={roles.includes(role)}
                    disabled={!allowed || busy}
                    onChange={(e) =>
                      setRoles((rs) =>
                        e.target.checked ? [...rs, role] : rs.filter((r) => r !== role),
                      )
                    }
                  />
                  {role}
                </label>
              );
            })}
            {rolesChanged && (
              <Button variant="primary" disabled={busy} onClick={saveRoles}>
                {busy ? 'Saving…' : 'Save roles'}
              </Button>
            )}
          </>
        )}
      </Part>

      {row.employeeId === null ? (
        <p style={{ margin: 0, fontSize: 12.5, color: t.muted, lineHeight: 1.4 }}>
          No CloudPunch record yet. It&apos;s made when they&apos;re given Employee, Manager or HR;
          then a manager and shift can be set.
        </p>
      ) : (
        <>
          <Part title="Manager" t={t}>
            <ManagerPicker
              person={row.name}
              current={manager?.employeeId ? { id: manager.employeeId, name: manager.name } : null}
              choices={managerChoices(rows, row)}
              disabled={busy}
              onPick={setManager}
            />
            {managerLacksRole && manager && (
              <span role="note" style={{ fontSize: 12, color: t.warnText }}>
                {manager.name} doesn&apos;t have the Manager role, so they won&apos;t see the Team
                tab.{' '}
                <button type="button" disabled={busy} onClick={giveManagerRole} style={link(t)}>
                  Give them the Manager role
                </button>
              </span>
            )}
          </Part>

          {row.shift !== undefined && (
            <Part title="Shift" t={t}>
              {editingShift ? (
                <ShiftForm
                  row={{ employee_id: row.employeeId, name: row.name, shift: row.shift }}
                  onCancel={() => setEditingShift(false)}
                  onSaved={(s) => {
                    setEditingShift(false);
                    setStatus({ kind: 'saved', text: `Shift saved: ${shiftText(s)}.` });
                    onChanged();
                  }}
                />
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <span
                    aria-label={`shift of ${row.name}`}
                    style={{ flex: 1, minWidth: 0, color: row.shift ? t.text : t.warnText }}
                  >
                    {shiftText(row.shift)}
                  </span>
                  <button type="button" onClick={() => setEditingShift(true)} style={link(t)}>
                    {row.shift ? 'Edit' : 'Set shift'}
                  </button>
                </div>
              )}
            </Part>
          )}
        </>
      )}

      {row.oid !== null && (row.roles.includes('Employee') || welcome) && (
        <Part title="Welcome email" t={t}>
          {welcome ? (
            <WelcomePanel
              oid={row.oid}
              name={row.name}
              onDone={(sent, text) => {
                setWelcome(false);
                if (sent) setStatus({ kind: 'saved', text });
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setWelcome(true)}
              style={{ ...link(t), alignSelf: 'flex-start' }}
            >
              Send welcome email
            </button>
          )}
        </Part>
      )}

      {canSignOutMachines && row.oid !== null && row.employeeId !== null && (
        <ActiveMachineSection oid={row.oid} name={row.name} />
      )}

      <input
        aria-label="person-reason"
        placeholder="Why (audit log, optional)"
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        style={input(t)}
      />
      {status && (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          style={{
            margin: 0,
            fontSize: 12.5,
            lineHeight: 1.4,
            color: status.kind === 'error' ? t.danger : t.text,
          }}
        >
          {status.text}
        </p>
      )}
    </aside>
  );
}

function Part({
  title,
  t,
  children,
}: {
  title: string;
  t: Theme;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={title}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingTop: 8,
        borderTop: `1px solid ${t.border}`,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 650, color: t.muted }}>{title}</div>
      {children}
    </div>
  );
}

const check: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 };

function panel(t: Theme): CSSProperties {
  return {
    width: 320,
    flexShrink: 0,
    alignSelf: 'flex-start',
    position: 'sticky',
    top: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: 14,
    border: `1px solid ${t.border}`,
    borderRadius: 12,
    background: t.surface,
    boxSizing: 'border-box',
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
