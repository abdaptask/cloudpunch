import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useFocusPart, type PanelFocus } from './panelFocus.js';
import { api, type DeactivatedPerson } from '../api.js';
import { dayLabel, localDateOf, shiftDate } from '../dayHistory.js';
import type { DaySummary } from '../dayPickerModel.js';
import { EarlierDay } from '../TeamScreen.js';
import { hm } from '../teamModel.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { HistoryList } from './HistoryList.js';
import { ERROR_TEXT, HR_ASSIGNABLE, ROLES } from './peopleParts.js';

/**
 * A deactivated person's panel (ADR-0053, opened from People's Inactive
 * rows since ADR-0054): when, by whom and why; Reactivate, which gives
 * roles back and turns the record on; their time history, back a year;
 * their changes. Nothing else here edits them.
 */

/** How far back a history goes, and how many days a page shows. */
const HISTORY_DAYS = 366;
const PAGE_DAYS = 31;
/** Roles that keep the record on (ADR-0020 §4). */
const RECORD_ROLES = ['Employee', 'Manager', 'HR'];

const MORE_ERRORS: Record<string, string> = {
  needs_record_role: 'Give them Employee, Manager or HR.',
  not_allowed_for_role: 'HR can give Employee and Manager only.',
  account_gone: "Their Microsoft account no longer exists, so they can't sign in.",
  no_microsoft_account: "This record isn't linked to a Microsoft account.",
  not_deactivated: 'They are already active. Reload the list.',
  validation: 'A reason of at least 3 characters is needed.',
  directory_error: 'Microsoft had a problem. Nothing was changed; try again.',
  date_out_of_range: 'That is more than a year ago.',
};
const errorText = (code: string): string =>
  MORE_ERRORS[code] ?? ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/** "5 Nov 2026", in the viewer's time zone. */
function when(iso: string | null): string {
  if (!iso) return 'date not recorded';
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function DeactivatedPanel({
  person,
  canAssignAll,
  onClose,
  onReactivated,
  focus = null,
}: {
  person: DeactivatedPerson;
  canAssignAll: boolean;
  onClose: () => void;
  onReactivated: (text: string) => void;
  /** Open at this part (the table's action icons). */
  focus?: PanelFocus | null;
}): JSX.Element {
  const t = useTheme();
  const ref = useFocusPart(focus);
  return (
    <aside ref={ref} aria-label={`deactivated ${person.name}`} style={panel(t)}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 650 }}>{person.name}</div>
          {person.email && <div style={{ fontSize: 12, color: t.muted }}>{person.email}</div>}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} style={link(t)}>
          ✕
        </button>
      </div>

      <Part title="Deactivated" t={t}>
        <span aria-label="deactivation" style={{ fontSize: 13, lineHeight: 1.45 }}>
          {when(person.deactivated_at)}
          {person.deactivated_by ? ` by ${person.deactivated_by}` : ''}.
          {person.reason ? ` Reason: ${person.reason}.` : ''}
          {person.roles_before.length > 0 ? ` Roles then: ${person.roles_before.join(', ')}.` : ''}
        </span>
      </Part>

      <Part title="Reactivate" t={t}>
        <Reactivate
          person={person}
          canAssignAll={canAssignAll}
          onDone={onReactivated}
          startAsking={focus === 'reactivate'}
        />
      </Part>

      <Part title="Time history" t={t}>
        <TimeHistory employeeId={person.employee_id} end={person.deactivated_at} />
      </Part>

      <Part title="Changes" t={t}>
        <HistoryList
          key={person.employee_id}
          label={`changes to ${person.name}`}
          load={() => api.adminPersonHistory(person.employee_id)}
        />
      </Part>
    </aside>
  );
}

/** Roles back and the record on, with a required reason (ADR-0053 §2). */
function Reactivate({
  person,
  canAssignAll,
  onDone,
  startAsking = false,
}: {
  person: DeactivatedPerson;
  canAssignAll: boolean;
  onDone: (text: string) => void;
  startAsking?: boolean;
}): JSX.Element {
  const t = useTheme();
  const allowed = (r: string): boolean => canAssignAll || HR_ASSIGNABLE.includes(r);
  const before = person.roles_before.filter(allowed);
  const [asking, setAsking] = useState(startAsking);
  const [roles, setRoles] = useState<string[]>(before.length > 0 ? before : ['Employee']);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (person.oid === null) {
    return (
      <span style={{ fontSize: 12.5, color: t.muted }}>
        Not linked to a Microsoft account, so they can&apos;t be reactivated here.
      </span>
    );
  }
  if (!asking) {
    return (
      <Button
        variant="secondary"
        onClick={() => setAsking(true)}
        style={{ alignSelf: 'flex-start', width: 'auto' }}
      >
        Reactivate…
      </Button>
    );
  }
  const ok = reason.trim().length >= 3 && roles.some((r) => RECORD_ROLES.includes(r));
  const go = (): void => {
    setBusy(true);
    setError(null);
    api.adminReactivate(person.employee_id, roles, reason.trim()).then(
      (r) => {
        setBusy(false);
        onDone(
          `${person.name} is active again with ${r.roles.join(', ')}. They sign in to CloudPunch ` +
            'again on their computer. Set their manager and shift in People.',
        );
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(String(e)));
      },
    );
  };
  return (
    <div
      role="group"
      aria-label="reactivate-confirm"
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      <span style={{ fontSize: 12.5, lineHeight: 1.45 }}>
        Gives these CloudPunch roles back in Microsoft Entra and turns their record on. Their
        history is as it was; their manager and shift need setting again.
      </span>
      {ROLES.map(([role, what]) => (
        <label key={role} title={what} style={{ ...check, opacity: allowed(role) ? 1 : 0.5 }}>
          <input
            type="checkbox"
            aria-label={`reactivate-role-${role}`}
            checked={roles.includes(role)}
            disabled={!allowed(role) || busy}
            onChange={(e) =>
              setRoles((rs) => (e.target.checked ? [...rs, role] : rs.filter((r) => r !== role)))
            }
          />
          {role}
        </label>
      ))}
      <textarea
        aria-label="reactivate-reason"
        placeholder="Reason (required, for the audit log)"
        value={reason}
        maxLength={500}
        rows={2}
        onChange={(e) => setReason(e.target.value)}
        style={{ ...input(t), resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" disabled={!ok || busy} onClick={go}>
          {busy ? 'Reactivating…' : `Reactivate ${person.name}`}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12.5, color: t.danger }}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Their days, 31 at a time, starting from the day they left; Earlier
 * and Later step through the last year (ADR-0053 §4). Read-only.
 */
export function TimeHistory({
  employeeId,
  end,
}: {
  employeeId: string;
  /** The last day to show first (ISO time they left); null: today. */
  end: string | null;
}): JSX.Element {
  const t = useTheme();
  const today = localDateOf(Date.now());
  const oldest = shiftDate(today, -(HISTORY_DAYS - 1));
  const left = end ? localDateOf(Date.parse(end)) : today;
  const [to, setTo] = useState(left < oldest ? oldest : left > today ? today : left);
  const fromRaw = shiftDate(to, -(PAGE_DAYS - 1));
  const from = fromRaw < oldest ? oldest : fromRaw;
  const [days, setDays] = useState<DaySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setDays(null);
    setError(null);
    api.adminPersonDays(employeeId, from, to).then(
      (r) => {
        if (!current) return;
        setDays(
          r.days
            .filter((d) => d.sessions > 0 || d.worked_ms > 0)
            .sort((a, b) => b.date.localeCompare(a.date)),
        );
      },
      (e: unknown) => {
        if (current) setError(errorText(String(e)));
      },
    );
    return () => {
      current = false;
    };
  }, [employeeId, from, to]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
        <button
          type="button"
          disabled={from <= oldest}
          onClick={() => setTo(shiftDate(from, -1))}
          style={link(t)}
        >
          ← Earlier
        </button>
        <span aria-label="history-range" style={{ flex: 1, textAlign: 'center', color: t.muted }}>
          {from} to {to}
        </span>
        <button
          type="button"
          disabled={to >= today}
          onClick={() => {
            const next = shiftDate(to, PAGE_DAYS);
            setTo(next > today ? today : next);
          }}
          style={link(t)}
        >
          Later →
        </button>
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12.5, color: t.danger }}>
          {error}
        </p>
      )}
      {!days && !error && <span style={{ fontSize: 12.5, color: t.muted }}>Loading…</span>}
      {days && days.length === 0 && (
        <span style={{ fontSize: 12.5, color: t.muted }}>Nothing tracked in these days.</span>
      )}
      {days && days.length > 0 && (
        <ul aria-label="history-days" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {days.map((d) => (
            <li key={d.date} style={{ borderBottom: `1px solid ${t.border}` }}>
              <button
                type="button"
                aria-expanded={open === d.date}
                aria-label={`day ${d.date}`}
                onClick={() => setOpen(open === d.date ? null : d.date)}
                style={{
                  width: '100%',
                  display: 'flex',
                  gap: 10,
                  padding: '6px 2px',
                  border: 'none',
                  background: 'none',
                  color: t.text,
                  font: 'inherit',
                  fontSize: 13,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span style={{ flex: 1 }}>{dayLabel(d.date, today)}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {hm(d.worked_ms / 60_000)}
                </span>
              </button>
              {open === d.date && (
                <EarlierDay
                  id={employeeId}
                  date={d.date}
                  canCorrect={false}
                  load={api.adminPersonDay}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
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
    flex: '0 1 360px',
    minWidth: 0,
    maxWidth: '100%',
    alignSelf: 'flex-start',
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
    fontSize: 12.5,
    cursor: 'pointer',
  };
}
