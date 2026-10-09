import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from './api.js';
import {
  breakIssues,
  formFrom,
  formIssues,
  mayHaveNoLimit,
  overrideWith,
  PAY_LABELS,
  ZONES,
  type BreakForm,
  type BreakPay,
  type SettingsForm,
} from './settingsModel.js';
import { Button } from './ui/Button.js';
import { useTheme, type Theme } from './ui/theme.js';

/** `global`, or a department id. */
type ScopeKey = string;

interface Loaded {
  override: Record<string, unknown> | null;
  form: SettingsForm;
}

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: "Your role can't change this.",
  policy_invalid: 'CloudPunch refused these values. Check the ranges.',
  not_configured: "Settings aren't available in this build.",
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/**
 * Settings for HR and Administrators (ADR-0018 §5). Administrators edit
 * the company-wide values; HR edits a department. The server checks the
 * role on every read and save, and audits each change.
 */
export function SettingsScreen({
  canEditCompany,
  onClose,
}: {
  /** `admin.policy.write`: the company-wide scope is offered too. */
  canEditCompany: boolean;
  onClose: () => void;
}): JSX.Element {
  const t = useTheme();
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [scope, setScope] = useState<ScopeKey | null>(canEditCompany ? 'global' : null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.adminDepartments().then(
      (r) => {
        setDepartments(r.departments);
        const first = r.departments[0];
        if (!canEditCompany && first) setScope((s) => s ?? first.id);
      },
      (e: unknown) => {
        if (!canEditCompany) setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  }, [canEditCompany]);

  useEffect(() => {
    if (scope === null) return;
    let current = true;
    setLoaded(null);
    setForm(null);
    setStatus(null);
    const load =
      scope === 'global'
        ? api.adminPolicyGet('global', null)
        : api.adminPolicyGet('department', scope);
    load.then(
      (r) => {
        if (!current) return;
        const next = { override: r.override?.document ?? null, form: formFrom(r.effective.policy) };
        setLoaded(next);
        setForm(next.form);
      },
      (e: unknown) => {
        if (current) setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
    return () => {
      current = false;
    };
  }, [scope]);

  const issues = form ? formIssues(form) : {};
  const changed =
    form !== null && loaded !== null && JSON.stringify(form) !== JSON.stringify(loaded.form);
  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]): void => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    setStatus(null);
  };
  const setBreak = (id: BreakForm['id'], patch: Partial<BreakForm>): void => {
    setForm((f) =>
      f ? { ...f, breaks: f.breaks.map((b) => (b.id === id ? { ...b, ...patch } : b)) } : f,
    );
    setStatus(null);
  };
  const rowIssues = form ? breakIssues(form) : {};

  const save = (): void => {
    if (!form || !loaded || scope === null || Object.keys(issues).length > 0) return;
    setSaving(true);
    const document = overrideWith(loaded.override, form, scope === 'global');
    const put =
      scope === 'global'
        ? api.adminPolicyPut('global', null, document, reason)
        : api.adminPolicyPut('department', scope, document, reason);
    put.then(
      (r) => {
        setSaving(false);
        setLoaded({ override: r.override?.document ?? document, form });
        setReason('');
        setStatus({
          kind: 'saved',
          text: "Saved. Each person's app picks this up within 15 minutes, and it applies from their next clock-in.",
        });
      },
      (e: unknown) => {
        setSaving(false);
        setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };

  return (
    <section aria-label="settings" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Settings</h2>
        <button type="button" onClick={onClose} style={link(t)}>
          Done
        </button>
      </div>
      <Field label="Applies to">
        <select
          aria-label="scope"
          value={scope ?? ''}
          onChange={(e) => setScope(e.target.value)}
          style={input(t)}
        >
          {canEditCompany && <option value="global">Everyone (company-wide)</option>}
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>

      {form && (
        <>
          <Group title="Idle" t={t}>
            <NumberField
              label="Idle popup after (minutes)"
              name="idle-prompt"
              value={form.idlePromptMinutes}
              issue={issues.idlePromptMinutes}
              onChange={(v) => set('idlePromptMinutes', v)}
            />
            <NumberField
              label="Popup waits before logging idle (seconds)"
              name="prompt-wait"
              value={form.promptWaitSeconds}
              issue={issues.promptWaitSeconds}
              onChange={(v) => set('promptWaitSeconds', v)}
            />
            <Toggle
              label="Clock out after long idle"
              name="idle-cap-on"
              on={form.idleCapMinutes !== null}
              onChange={(on) => set('idleCapMinutes', on ? 120 : null)}
            />
            {form.idleCapMinutes !== null && (
              <NumberField
                label="…after this much idle (minutes)"
                name="idle-cap"
                value={form.idleCapMinutes}
                issue={issues.idleCapMinutes}
                onChange={(v) => set('idleCapMinutes', v)}
              />
            )}
            <Toggle
              label="Presence check for propped keys and mouse jigglers"
              name="presence-check"
              on={form.presenceCheck}
              onChange={(on) => set('presenceCheck', on)}
            />
            {form.presenceCheck && (
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.4, color: t.muted }}>
                After 20 minutes of input with no pauses, or input in a machine&apos;s fixed rhythm,
                CloudPunch asks &ldquo;Are you there?&rdquo;. Unanswered, the time is idle and the
                manager sees it. Only input timing is used, never keys. Tell employees before
                turning this on (privacy notice).
              </p>
            )}
          </Group>
          <Group title="Clock-in popup" t={t}>
            <Toggle
              label="Show a daily clock-in popup"
              name="clock-in-prompt-on"
              on={form.clockInPromptAt !== null}
              onChange={(on) => set('clockInPromptAt', on ? '08:00' : null)}
            />
            {form.clockInPromptAt !== null && (
              <>
                <Field label="At" issue={issues.clockInPromptAt}>
                  <input
                    aria-label="clock-in-prompt-at"
                    type="time"
                    value={form.clockInPromptAt}
                    onChange={(e) => set('clockInPromptAt', e.target.value)}
                    style={input(t)}
                  />
                </Field>
                <Field label="Time zone">
                  <select
                    aria-label="clock-in-prompt-tz"
                    value={form.clockInPromptTz}
                    onChange={(e) => set('clockInPromptTz', e.target.value)}
                    style={input(t)}
                  >
                    {!ZONES.some(([z]) => z === form.clockInPromptTz) && (
                      <option value={form.clockInPromptTz}>{form.clockInPromptTz}</option>
                    )}
                    {ZONES.map(([z, label]) => (
                      <option key={z} value={z}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </Group>
          <Group title="Long days" t={t}>
            <NumberField
              label="Trip complete after (hours worked)"
              name="long-day"
              value={form.longDayHours}
              issue={issues.longDayHours}
              onChange={(v) => set('longDayHours', v)}
            />
            <NumberField
              label="Long-shift check after (hours)"
              name="long-shift"
              value={form.longShiftHours}
              issue={issues.longShiftHours}
              onChange={(v) => set('longShiftHours', v)}
            />
          </Group>
          <Group title="Breaks" t={t}>
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.4, color: t.muted }}>
              The limit sends a reminder and, for &ldquo;Paid up to the limit&rdquo;, is where paid
              time stops. It never ends a break. Managers see the type.
            </p>
            {form.breaks.map((b) => (
              <BreakRow
                key={b.id}
                b={b}
                issue={rowIssues[b.id]}
                t={t}
                onChange={(patch) => setBreak(b.id, patch)}
              />
            ))}
            {issues.breaks && !Object.keys(rowIssues).length && (
              <span role="alert" style={{ fontSize: 12, color: t.danger }}>
                {issues.breaks}
              </span>
            )}
          </Group>
          <Group title="Away" t={t}>
            <Toggle
              label="Offer Training (counts as work)"
              name="offer-training"
              on={form.offerTraining}
              onChange={(on) => set('offerTraining', on)}
            />
            <NumberField
              label="Ask “Still away?” after (minutes)"
              name="away-check"
              value={form.awayCheckMinutes}
              issue={issues.awayCheckMinutes}
              onChange={(v) => set('awayCheckMinutes', v)}
            />
          </Group>
          {scope === 'global' && (
            <Group title="Connection location" t={t}>
              <Toggle
                label="Record where people connect from"
                name="record-connections"
                on={form.recordConnections}
                onChange={(on) => set('recordConnections', on)}
              />
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.4, color: t.muted }}>
                The server keeps each computer&apos;s IP address, approximate city and internet
                provider for 30 days. Nothing comes from the computer itself and there&apos;s no
                GPS. Managers see their own team; Administrators see everyone. Tell employees before
                turning this on (privacy notice).
              </p>
            </Group>
          )}
          {scope === 'global' && (
            <Group title="Shift-start emails" t={t}>
              <Toggle
                label="Email when someone hasn't clocked in"
                name="shift-emails"
                on={form.shiftEmails}
                onChange={(on) => set('shiftEmails', on)}
              />
              <NumberField
                label="Minutes after the shift starts"
                name="missed-clock-in-minutes"
                value={form.missedClockInMinutes}
                issue={issues.missedClockInMinutes}
                onChange={(v) => set('missedClockInMinutes', v)}
              />
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.4, color: t.muted }}>
                From cloudpunch@aptask.com to the person, with their manager copied (no manager:
                Administrators and HR): not clocked in, clocked in late, and &ldquo;Not working
                today&rdquo;. Once each per shift, never on a holiday. Add the holidays first.
              </p>
            </Group>
          )}
          <Field label="Why (kept in the audit log, optional)">
            <input
              aria-label="reason"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              style={input(t)}
            />
          </Field>
          <Button
            variant="primary"
            disabled={!changed || saving || Object.keys(issues).length > 0}
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      )}
      {!form && !status && scope !== null && (
        <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>
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

/** One break type: on/off, name, pay rule and limit (ADR-0023 §5). */
function BreakRow({
  b,
  issue,
  t,
  onChange,
}: {
  b: BreakForm;
  issue: string | undefined;
  t: Theme;
  onChange: (patch: Partial<BreakForm>) => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={`break ${b.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingTop: 8,
        borderTop: `1px solid ${t.border}`,
        opacity: b.enabled ? 1 : 0.65,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          aria-label={`${b.id}-enabled`}
          type="checkbox"
          checked={b.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <input
          aria-label={`${b.id}-label`}
          value={b.label}
          maxLength={30}
          onChange={(e) => onChange({ label: e.target.value })}
          style={{ ...input(t), flex: 1 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <select
          aria-label={`${b.id}-pay`}
          value={b.pay}
          onChange={(e) => onChange({ pay: e.target.value as BreakPay })}
          style={{ ...input(t), flex: 1 }}
        >
          {PAY_LABELS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <input
          aria-label={`${b.id}-limit`}
          type="number"
          inputMode="numeric"
          placeholder={mayHaveNoLimit(b.id) ? 'No limit' : undefined}
          value={b.maxMinutes === null ? '' : Number.isFinite(b.maxMinutes) ? b.maxMinutes : ''}
          onChange={(e) =>
            onChange({
              maxMinutes:
                e.target.value === ''
                  ? mayHaveNoLimit(b.id)
                    ? null
                    : Number.NaN
                  : Number(e.target.value),
            })
          }
          style={{ ...input(t), width: 72 }}
        />
        <span style={{ alignSelf: 'center', fontSize: 12, color: t.muted }}>min</span>
      </div>
      {issue && <span style={{ fontSize: 12, color: t.danger }}>{issue}</span>}
    </div>
  );
}

function Group({
  title,
  t,
  children,
}: {
  title: string;
  t: Theme;
  children: ReactNode;
}): JSX.Element {
  return (
    <fieldset
      style={{
        margin: 0,
        padding: 12,
        border: `1px solid ${t.border}`,
        borderRadius: 12,
        background: t.surface,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <legend style={{ padding: '0 4px', fontSize: 12, fontWeight: 650, color: t.muted }}>
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function Field({
  label,
  issue,
  children,
}: {
  label: string;
  issue?: string | undefined;
  children: ReactNode;
}): JSX.Element {
  const t = useTheme();
  return (
    <label
      style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: t.muted }}
    >
      {label}
      {children}
      {issue && <span style={{ color: t.danger }}>{issue}</span>}
    </label>
  );
}

function NumberField({
  label,
  name,
  value,
  issue,
  onChange,
}: {
  label: string;
  name: string;
  value: number;
  issue?: string | undefined;
  onChange: (v: number) => void;
}): JSX.Element {
  const t = useTheme();
  return (
    <Field label={label} issue={issue}>
      <input
        aria-label={name}
        type="number"
        inputMode="numeric"
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
        style={input(t)}
      />
    </Field>
  );
}

function Toggle({
  label,
  name,
  on,
  onChange,
}: {
  label: string;
  name: string;
  on: boolean;
  onChange: (on: boolean) => void;
}): JSX.Element {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <input
        aria-label={name}
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
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
