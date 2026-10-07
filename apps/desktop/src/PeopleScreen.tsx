import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, type ActiveMachine, type DirectoryUser, type Person } from './api.js';
import { formatClock } from './timelineModel.js';
import { Button } from './ui/Button.js';
import { WelcomePanel } from './WelcomePanel.js';
import { useTheme, type Theme } from './ui/theme.js';

/** Every CloudPunch role, with what it's for (ADR-0002 §2). */
const ROLES: [string, string][] = [
  ['Employee', 'Clocks in and out; sees their own time'],
  ['Manager', 'Approves their team’s timesheets'],
  ['HR', 'Department settings; people with Employee / Manager'],
  ['Payroll', 'Approved hours and exports'],
  ['Auditor', 'Read-only, everything'],
  ['Administrator', 'Company settings and all roles'],
];
/** What HR may give or remove (ADR-0020 §3); the server enforces it too. */
const HR_ASSIGNABLE = ['Employee', 'Manager'];

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  people_not_configured: 'People is not set up on the server yet.',
  consent_required: 'An Entra admin still needs to grant consent for People.',
  directory_forbidden:
    'Microsoft refused this change. Ask an Entra admin to make you an owner of the CloudPunch API app.',
  not_allowed_for_role: 'HR can give or remove Employee and Manager only.',
  cannot_remove_own_admin: "You can't remove your own Administrator role.",
  last_administrator: 'CloudPunch needs at least one Administrator.',
  forbidden: "Your role can't manage people.",
};

/** Active machine (ADR-0028 §4). */
const MACHINE_ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: 'Only Administrators can sign someone out of a computer.',
};
const machineErrorText = (code: string): string =>
  MACHINE_ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

const OS_NAME: Record<ActiveMachine['os'], string> = {
  windows: 'Windows computer',
  macos: 'Mac',
};

/** "09:02", or "29 Sep 09:02" when not today. */
function when(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  if (sameDay) return formatClock(ms);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${date} ${formatClock(ms)}`;
}
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/**
 * People (ADR-0020): find someone in the company directory and set their
 * CloudPunch roles, without the Entra portal. Changes are made in Entra
 * with your own rights, audited, and take effect at their next sign-in.
 */
export function PeopleScreen({
  canAssignAll,
  canSignOutMachines = false,
  onClose,
}: {
  /** `admin.role.assign`: every role; otherwise HR's Employee / Manager. */
  canAssignAll: boolean;
  /** Administrators: Active machine and "Sign out of this machine" (ADR-0028 §4). */
  canSignOutMachines?: boolean;
  onClose: () => void;
}): JSX.Element {
  const t = useTheme();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [editing, setEditing] = useState<{ oid: string; name: string; roles: string[] } | null>(
    null,
  );
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // After giving someone Employee (or on request): the welcome email (ADR-0021).
  const [welcome, setWelcome] = useState<{ oid: string; name: string } | null>(null);
  const searchSeq = useRef(0);

  const load = (): void => {
    api.adminPeople().then(
      (r) => setPeople(r.people),
      (e: unknown) => setStatus({ kind: 'error', text: errorText(String(e)) }),
    );
  };
  useEffect(load, []);

  // Directory search, debounced; only the latest answer counts.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = window.setTimeout(() => {
      api.adminPeopleSearch(q).then(
        (r) => {
          if (seq === searchSeq.current) setResults(r.users);
        },
        (e: unknown) => {
          if (seq === searchSeq.current) setStatus({ kind: 'error', text: errorText(String(e)) });
        },
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const edit = (oid: string, name: string): void => {
    const current = people?.find((p) => p.oid === oid)?.roles ?? [];
    setEditing({ oid, name, roles: current.length > 0 ? current : ['Employee'] });
    setReason('');
    setStatus(null);
    setQuery('');
  };
  const original = editing ? (people?.find((p) => p.oid === editing.oid)?.roles ?? []) : [];
  const changed =
    editing !== null && [...editing.roles].sort().join() !== [...original].sort().join();

  const save = (): void => {
    if (!editing) return;
    setSaving(true);
    const newEmployee = editing.roles.includes('Employee') && !original.includes('Employee');
    api.adminPeopleSetRoles(editing.oid, editing.roles, reason).then(
      () => {
        setSaving(false);
        setStatus({
          kind: 'saved',
          text: `Saved. ${editing.name} gets the new roles at their next sign-in (within an hour).`,
        });
        if (newEmployee) setWelcome({ oid: editing.oid, name: editing.name });
        setEditing(null);
        load();
      },
      (e: unknown) => {
        setSaving(false);
        setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };

  return (
    <section aria-label="people" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>People</h2>
        <button type="button" onClick={onClose} style={link(t)}>
          Done
        </button>
      </div>

      {editing ? (
        <div style={panel(t)} role="group" aria-label="edit-roles">
          <div style={{ fontSize: 14, fontWeight: 650 }}>{editing.name}</div>
          {ROLES.map(([role, what]) => {
            const allowed = canAssignAll || HR_ASSIGNABLE.includes(role);
            const on = editing.roles.includes(role);
            return (
              <label
                key={role}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'flex-start',
                  fontSize: 13,
                  opacity: allowed ? 1 : 0.5,
                }}
              >
                <input
                  type="checkbox"
                  aria-label={`role-${role}`}
                  checked={on}
                  disabled={!allowed}
                  onChange={(e) =>
                    setEditing((p) =>
                      p
                        ? {
                            ...p,
                            roles: e.target.checked
                              ? [...p.roles, role]
                              : p.roles.filter((r) => r !== role),
                          }
                        : p,
                    )
                  }
                />
                <span>
                  <strong style={{ fontWeight: 600 }}>{role}</strong>
                  <span style={{ color: t.muted }}> · {what}</span>
                </span>
              </label>
            );
          })}
          <input
            aria-label="people-reason"
            placeholder="Why (kept in the audit log, optional)"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            style={input(t)}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Button variant="primary" disabled={!changed || saving} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
          {original.includes('Employee') && (
            <button
              type="button"
              onClick={() => {
                setWelcome({ oid: editing.oid, name: editing.name });
                setEditing(null);
              }}
              style={{ ...link(t), alignSelf: 'flex-start', fontSize: 12.5 }}
            >
              Send welcome email
            </button>
          )}
          {canSignOutMachines && <ActiveMachineSection oid={editing.oid} name={editing.name} />}
        </div>
      ) : welcome ? (
        <WelcomePanel
          oid={welcome.oid}
          name={welcome.name}
          onDone={(sent, text) => {
            setWelcome(null);
            if (sent) setStatus({ kind: 'saved', text });
          }}
        />
      ) : (
        <>
          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              fontSize: 12,
              color: t.muted,
            }}
          >
            Add a person
            <input
              aria-label="people-search"
              placeholder="Search the company directory by name or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={input(t)}
            />
          </label>
          {results.length > 0 && (
            <ul aria-label="search-results" style={list}>
              {results.map((u) => (
                <li key={u.oid}>
                  <button type="button" onClick={() => edit(u.oid, u.name)} style={row(t)}>
                    <span style={{ fontWeight: 600 }}>{u.name}</span>
                    <span style={{ color: t.muted, fontSize: 12 }}>{u.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div style={{ fontSize: 12, fontWeight: 650, color: t.muted }}>
            With a CloudPunch role
          </div>
          {people === null && !status && (
            <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>
          )}
          {people && (
            <ul aria-label="people-list" style={list}>
              {people.map((p) => (
                <li key={p.oid}>
                  <button type="button" onClick={() => edit(p.oid, p.name)} style={row(t)}>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    <span style={{ color: t.muted, fontSize: 12 }}>{p.roles.join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {status && (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          style={{
            margin: 0,
            fontSize: 13,
            lineHeight: 1.4,
            color: status.kind === 'error' ? t.danger : t.text,
          }}
        >
          {status.text}
        </p>
      )}
    </section>
  );
}

/**
 * Administrators (ADR-0028 §4): the computer this person is clocked in
 * on, and "Sign out of this machine" for a laptop left clocked in, dead
 * or lost. The server closes the session at its last activity (no time
 * is invented), audits it, and signs that computer out.
 */
function ActiveMachineSection({ oid, name }: { oid: string; name: string }): JSX.Element {
  const t = useTheme();
  // undefined: loading; null: no employee record.
  const [employeeId, setEmployeeId] = useState<string | null | undefined>(undefined);
  // undefined: loading; null: not clocked in anywhere.
  const [machine, setMachine] = useState<ActiveMachine | null | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);

  const loadMachine = (id: string): void => {
    api.adminActiveDevice(id).then(
      (m) => setMachine(m),
      (e: unknown) => {
        setMachine(null);
        setStatus({ kind: 'error', text: machineErrorText(String(e)) });
      },
    );
  };
  useEffect(() => {
    let current = true;
    setEmployeeId(undefined);
    setMachine(undefined);
    setConfirming(false);
    setStatus(null);
    api.adminEmployees().then(
      (r) => {
        if (!current) return;
        const id = r.employees.find((e) => e.oid === oid)?.id ?? null;
        setEmployeeId(id);
        if (id) loadMachine(id);
      },
      (e: unknown) => {
        if (!current) return;
        setEmployeeId(null);
        setStatus({ kind: 'error', text: machineErrorText(String(e)) });
      },
    );
    return () => {
      current = false;
    };
  }, [oid]);

  const signOut = (): void => {
    if (!employeeId || !machine) return;
    setBusy(true);
    api.adminActiveDeviceSignOut(employeeId, machine.device_id).then(
      (r) => {
        setBusy(false);
        setConfirming(false);
        setStatus({
          kind: 'saved',
          text:
            r.closed_at !== null
              ? `${name} was clocked out at ${when(r.closed_at)}. That computer signs out the next time it connects.`
              : `That computer signs out the next time it connects.`,
        });
        loadMachine(employeeId);
      },
      (e: unknown) => {
        setBusy(false);
        setConfirming(false);
        setStatus({ kind: 'error', text: machineErrorText(String(e)) });
      },
    );
  };

  return (
    <div
      role="group"
      aria-label="active-machine"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingTop: 8,
        borderTop: `1px solid ${t.border}`,
        fontSize: 13,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 650, color: t.muted }}>Active machine</div>
      {employeeId === undefined || (employeeId !== null && machine === undefined) ? (
        <span style={{ color: t.muted }}>Loading…</span>
      ) : employeeId === null ? (
        <span style={{ color: t.muted }}>No employee record, so no computer to show.</span>
      ) : machine === null || machine === undefined ? (
        <span style={{ color: t.muted }}>Not clocked in on any computer.</span>
      ) : (
        <>
          <span aria-label="active-machine-details">
            <strong style={{ fontWeight: 600 }}>{OS_NAME[machine.os] ?? 'Computer'}</strong>
            <span style={{ color: t.muted }}>
              {' · '}clocked in since {when(machine.opened_at)}
              {machine.last_event_at !== null && (
                <> · last activity {when(machine.last_event_at)}</>
              )}
            </span>
          </span>
          {confirming ? (
            <div role="dialog" aria-label="confirm-machine-sign-out" style={confirmBox(t)}>
              <span>
                This clocks {name} out at their last activity and signs that computer out. Continue?
              </span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Button variant="primary" disabled={busy} onClick={signOut}>
                  {busy ? 'Signing out…' : 'Continue'}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                setStatus(null);
                setConfirming(true);
              }}
            >
              Sign out of this machine
            </Button>
          )}
        </>
      )}
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
    </div>
  );
}

function confirmBox(t: Theme): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    background: t.warnBg,
    color: t.warnText,
    lineHeight: 1.4,
  };
}

const list: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

function row(t: Theme): CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 2,
    padding: '8px 10px',
    border: `1px solid ${t.border}`,
    borderRadius: 10,
    background: t.surface,
    color: t.text,
    font: 'inherit',
    fontSize: 13,
    textAlign: 'left',
    cursor: 'pointer',
  };
}

function panel(t: Theme): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    border: `1px solid ${t.border}`,
    borderRadius: 12,
    background: t.surface,
  };
}

function input(t: Theme): CSSProperties {
  return {
    font: 'inherit',
    fontSize: 13,
    padding: '7px 9px',
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
