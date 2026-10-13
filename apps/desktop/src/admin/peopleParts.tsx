import { useEffect, useState, type CSSProperties } from 'react';
import { api, type ActiveMachine } from '../api.js';
import { formatClock } from '../timelineModel.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';

/**
 * Pieces of People shared by the admin console's table, panel and bulk
 * bar (ADR-0020, ADR-0028 §4, ADR-0038): the roles, what HR may give,
 * error words, and the active machine section.
 */

/** Every CloudPunch role, with what it's for (ADR-0002 §2). */
export const ROLES: [string, string][] = [
  ['Employee', 'Clocks in and out; sees their own time'],
  ['Manager', 'Approves their team’s timesheets'],
  ['HR', 'Department settings; people with Employee / Manager'],
  ['Payroll', 'Approved hours and exports'],
  ['Auditor', 'Read-only, everything'],
  ['Administrator', 'Company settings and all roles'],
];
/** What HR may give or remove (ADR-0020 §3); the server enforces it too. */
export const HR_ASSIGNABLE = ['Employee', 'Manager'];

export const ERROR_TEXT: Record<string, string> = {
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
export function ActiveMachineSection({ oid, name }: { oid: string; name: string }): JSX.Element {
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
