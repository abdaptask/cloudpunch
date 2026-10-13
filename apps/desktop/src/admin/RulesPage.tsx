import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api.js';
import {
  breakIssues,
  breakText,
  changedFields,
  departmentOverride,
  formFrom,
  formIssues,
  mayHaveNoLimit,
  overrideWith,
  PAY_LABELS,
  RULE_SECTIONS,
  sectionOf,
  valueText,
  ZONES,
  type BreakForm,
  type BreakPay,
  type RuleSectionKey,
  type ScalarKey,
  type SettingsForm,
} from '../settingsModel.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: "Your role can't change this.",
  policy_invalid: 'CloudPunch refused these values. Check the ranges.',
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

interface Loaded {
  override: Record<string, unknown> | null;
  form: SettingsForm;
  /** A department's company values, to compare with; null company-wide. */
  company: SettingsForm | null;
}

/**
 * Rules in the admin console (ADR-0038 §8): one section at a time from
 * a menu, Company or a department at the top. On a department, each
 * value it changes shows Overridden, the company value, and Reset. A
 * save bar stays on screen with the unsaved changes across sections;
 * switching away with changes asks first. The server, the policy shape
 * and the save call are as before; a department now saves only what
 * differs from the company.
 */
export function RulesPage({
  canEditCompany,
  onDirtyChange,
}: {
  /** `admin.policy.write`: the company-wide rules too. */
  canEditCompany: boolean;
  /** Tells the console when there are unsaved changes. */
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element {
  const t = useTheme();
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [scope, setScope] = useState<string | null>(canEditCompany ? 'global' : null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [section, setSection] = useState<RuleSectionKey>('idle');
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // A scope switch waiting on "discard your changes?".
  const [leavingTo, setLeavingTo] = useState<string | null>(null);

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
    const global = scope === 'global';
    Promise.all([
      global ? api.adminPolicyGet('global', null) : api.adminPolicyGet('department', scope),
      global ? Promise.resolve(null) : api.adminPolicyGet('global', null),
    ]).then(
      ([r, c]) => {
        if (!current) return;
        const next: Loaded = {
          override: r.override?.document ?? null,
          form: formFrom(r.effective.policy),
          company: c ? formFrom(c.effective.policy) : null,
        };
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

  const changes = form && loaded ? changedFields(form, loaded.form) : [];
  const dirty = changes.length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // On the web, closing the tab with changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

  const issues = form ? formIssues(form) : {};
  const rowIssues = form ? breakIssues(form) : {};
  const company = loaded?.company ?? null;
  const offered = RULE_SECTIONS.filter((s) => !s.companyOnly || scope === 'global');

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
  const switchScope = (to: string): void => {
    if (dirty) setLeavingTo(to);
    else setScope(to);
  };

  const save = (): void => {
    if (!form || !loaded || scope === null || Object.keys(issues).length > 0) return;
    setSaving(true);
    const document =
      scope === 'global'
        ? overrideWith(loaded.override, form, true)
        : departmentOverride(loaded.override, form, loaded.company ?? form);
    const put =
      scope === 'global'
        ? api.adminPolicyPut('global', null, document, reason)
        : api.adminPolicyPut('department', scope, document, reason);
    put.then(
      (r) => {
        setSaving(false);
        setLoaded({ ...loaded, override: r.override?.document ?? document, form });
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

  /** One setting's row, with Overridden and Reset on a department. */
  const row = (k: ScalarKey, label: string, control: ReactNode, issue?: string): ReactNode => {
    const differs = company !== null && form !== null && form[k] !== company[k];
    return (
      <Row
        key={k}
        label={label}
        issue={issue}
        unsaved={changes.includes(k)}
        override={
          differs && company
            ? { text: valueText(k, company), reset: () => set(k, company[k]) }
            : null
        }
        t={t}
      >
        {control}
      </Row>
    );
  };

  return (
    <section aria-label="rules" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650, flex: 1 }}>Rules</h2>
        <select
          aria-label="scope"
          value={scope ?? ''}
          onChange={(e) => switchScope(e.target.value)}
          style={input(t)}
        >
          {canEditCompany && <option value="global">Company (everyone)</option>}
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              Department: {d.name}
            </option>
          ))}
        </select>
      </div>
      {scope !== null && scope !== 'global' && (
        <p style={{ margin: 0, fontSize: 12.5, color: t.muted }}>
          A department follows the company rules except where it says Overridden.
        </p>
      )}
      {leavingTo !== null && (
        <div role="alertdialog" aria-label="unsaved-changes" style={warnBox(t)}>
          <span style={{ flex: 1 }}>
            You have {count(changes.length)}. Discard {changes.length === 1 ? 'it' : 'them'} and
            switch?
          </span>
          <Button
            variant="chip"
            onClick={() => {
              setScope(leavingTo);
              setLeavingTo(null);
            }}
          >
            Discard and switch
          </Button>
          <Button variant="chip" onClick={() => setLeavingTo(null)}>
            Stay
          </Button>
        </div>
      )}

      {form && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <nav aria-label="rule-sections" style={{ width: 170, flexShrink: 0 }}>
            {offered.map((s) => {
              const unsaved = changes.filter((c) => sectionOf(c) === s.key).length;
              return (
                <button
                  key={s.key}
                  type="button"
                  aria-current={section === s.key ? 'page' : undefined}
                  onClick={() => setSection(s.key)}
                  style={menuItem(t, section === s.key)}
                >
                  <span style={{ flex: 1 }}>{s.label}</span>
                  {unsaved > 0 && (
                    <span aria-label={`${s.label} has unsaved changes`} style={dot(t)} />
                  )}
                </button>
              );
            })}
          </nav>

          <div
            role="group"
            aria-label={`section ${offered.find((s) => s.key === section)?.label ?? ''}`}
            style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            {section === 'idle' && (
              <>
                {row(
                  'idlePromptMinutes',
                  'Idle popup after (minutes)',
                  <NumberInput
                    name="idle-prompt"
                    value={form.idlePromptMinutes}
                    onChange={(v) => set('idlePromptMinutes', v)}
                  />,
                  issues.idlePromptMinutes,
                )}
                {row(
                  'promptWaitSeconds',
                  'Popup waits before logging idle (seconds)',
                  <NumberInput
                    name="prompt-wait"
                    value={form.promptWaitSeconds}
                    onChange={(v) => set('promptWaitSeconds', v)}
                  />,
                  issues.promptWaitSeconds,
                )}
                {row(
                  'idleCapMinutes',
                  'Clock out after long idle',
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Check
                      name="idle-cap-on"
                      on={form.idleCapMinutes !== null}
                      onChange={(on) => set('idleCapMinutes', on ? 120 : null)}
                    />
                    {form.idleCapMinutes !== null && (
                      <>
                        <NumberInput
                          name="idle-cap"
                          value={form.idleCapMinutes}
                          onChange={(v) => set('idleCapMinutes', v)}
                        />
                        <span style={{ fontSize: 12, color: t.muted }}>minutes</span>
                      </>
                    )}
                  </span>,
                  issues.idleCapMinutes,
                )}
                {row(
                  'presenceCheck',
                  'Presence check for propped keys and mouse jigglers',
                  <Check
                    name="presence-check"
                    on={form.presenceCheck}
                    onChange={(on) => set('presenceCheck', on)}
                  />,
                )}
                <Note t={t}>
                  The presence check looks only at input timing, never keys. Tell employees before
                  turning it on (privacy notice).
                </Note>
              </>
            )}

            {section === 'clockIn' && (
              <>
                {row(
                  'clockInPromptAt',
                  'Daily clock-in popup at',
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Check
                      name="clock-in-prompt-on"
                      on={form.clockInPromptAt !== null}
                      onChange={(on) => set('clockInPromptAt', on ? '08:00' : null)}
                    />
                    {form.clockInPromptAt !== null && (
                      <input
                        aria-label="clock-in-prompt-at"
                        type="time"
                        value={form.clockInPromptAt}
                        onChange={(e) => set('clockInPromptAt', e.target.value)}
                        style={input(t)}
                      />
                    )}
                  </span>,
                  issues.clockInPromptAt,
                )}
                {form.clockInPromptAt !== null &&
                  row(
                    'clockInPromptTz',
                    'Time zone',
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
                    </select>,
                  )}
              </>
            )}

            {section === 'longDays' && (
              <>
                {row(
                  'longDayHours',
                  'Trip complete after (hours worked)',
                  <NumberInput
                    name="long-day"
                    value={form.longDayHours}
                    onChange={(v) => set('longDayHours', v)}
                  />,
                  issues.longDayHours,
                )}
                {row(
                  'longShiftHours',
                  'Long-shift check after (hours)',
                  <NumberInput
                    name="long-shift"
                    value={form.longShiftHours}
                    onChange={(v) => set('longShiftHours', v)}
                  />,
                  issues.longShiftHours,
                )}
              </>
            )}

            {section === 'breaks' && (
              <>
                <Note t={t}>
                  The limit sends a reminder and, for &ldquo;Paid up to the limit&rdquo;, is where
                  paid time stops. It never ends a break.
                </Note>
                <BreakTable
                  breaks={form.breaks}
                  company={company?.breaks ?? null}
                  saved={loaded?.form.breaks ?? []}
                  issues={rowIssues}
                  onChange={setBreak}
                  t={t}
                />
                {issues.breaks && !Object.keys(rowIssues).length && (
                  <span role="alert" style={{ fontSize: 12, color: t.danger }}>
                    {issues.breaks}
                  </span>
                )}
              </>
            )}

            {section === 'away' && (
              <>
                {row(
                  'offerTraining',
                  'Offer Training (counts as work)',
                  <Check
                    name="offer-training"
                    on={form.offerTraining}
                    onChange={(on) => set('offerTraining', on)}
                  />,
                )}
                {row(
                  'awayCheckMinutes',
                  'Ask “Still away?” after (minutes)',
                  <NumberInput
                    name="away-check"
                    value={form.awayCheckMinutes}
                    onChange={(v) => set('awayCheckMinutes', v)}
                  />,
                  issues.awayCheckMinutes,
                )}
              </>
            )}

            {section === 'connections' && scope === 'global' && (
              <>
                {row(
                  'recordConnections',
                  'Record where people connect from',
                  <Check
                    name="record-connections"
                    on={form.recordConnections}
                    onChange={(on) => set('recordConnections', on)}
                  />,
                )}
                {row(
                  'locationEmails',
                  'Email the manager when someone connects from a new city',
                  <Check
                    name="location-emails"
                    on={form.locationEmails}
                    onChange={(on) => set('locationEmails', on)}
                  />,
                )}
                <Note t={t}>
                  The server keeps each computer&apos;s IP address, approximate city and internet
                  provider for 30 days; no GPS. Managers see their own team; Administrators see
                  everyone. With the email on, a city or country someone hasn&apos;t used in 30 days
                  is sent once to their manager, Administrators copied (ADR-0041). Say so in the
                  privacy notice first.
                </Note>
              </>
            )}

            {section === 'alerts' && scope === 'global' && (
              <>
                {row(
                  'shiftEmails',
                  "Email when someone hasn't clocked in",
                  <Check
                    name="shift-emails"
                    on={form.shiftEmails}
                    onChange={(on) => set('shiftEmails', on)}
                  />,
                )}
                {row(
                  'missedClockInMinutes',
                  'Minutes after the shift starts',
                  <NumberInput
                    name="missed-clock-in-minutes"
                    value={form.missedClockInMinutes}
                    onChange={(v) => set('missedClockInMinutes', v)}
                  />,
                  issues.missedClockInMinutes,
                )}
                <Note t={t}>
                  From cloudpunch@aptask.com to the person, with their manager copied. Once each per
                  shift, never on a holiday.
                </Note>
              </>
            )}
          </div>
        </div>
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

      {dirty && (
        <div role="region" aria-label="save-bar" style={saveBar(t)}>
          <strong style={{ fontWeight: 650, whiteSpace: 'nowrap' }}>{count(changes.length)}</strong>
          <input
            aria-label="reason"
            placeholder="Why (audit log, optional)"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            style={{ ...input(t), flex: 1, minWidth: 120 }}
          />
          <Button
            variant="primary"
            disabled={saving || Object.keys(issues).length > 0}
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button
            variant="chip"
            disabled={saving}
            onClick={() => {
              if (loaded) setForm(loaded.form);
              setStatus(null);
            }}
          >
            Discard
          </Button>
        </div>
      )}
    </section>
  );
}

const count = (n: number): string => `${n} unsaved ${n === 1 ? 'change' : 'changes'}`;

/** A setting: label, control, and on a department its company value. */
function Row({
  label,
  issue,
  unsaved,
  override,
  t,
  children,
}: {
  label: string;
  issue?: string | undefined;
  unsaved: boolean;
  override: { text: string; reset: () => void } | null;
  t: Theme;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '8px 0',
        borderBottom: `1px solid ${t.border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 180, fontSize: 13 }}>
          {label}
          {unsaved && <span style={{ ...dot(t), marginLeft: 6 }} aria-label="unsaved" />}
        </span>
        {children}
      </div>
      {override && <OverrideNote text={override.text} reset={override.reset} t={t} />}
      {issue && <span style={{ fontSize: 12, color: t.danger }}>{issue}</span>}
    </div>
  );
}

function OverrideNote({
  text,
  reset,
  t,
}: {
  text: string;
  reset: () => void;
  t: Theme;
}): JSX.Element {
  return (
    <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
      <span style={badge(t)}>Overridden</span>
      <span style={{ color: t.muted }}>Company: {text}</span>
      <button type="button" onClick={reset} style={link(t)}>
        Reset to company value
      </button>
    </span>
  );
}

/** Breaks as a table (ADR-0038 §8): Type | On | Name | Pay | Limit. */
function BreakTable({
  breaks,
  company,
  saved,
  issues,
  onChange,
  t,
}: {
  breaks: readonly BreakForm[];
  company: readonly BreakForm[] | null;
  saved: readonly BreakForm[];
  issues: Partial<Record<BreakForm['id'], string>>;
  onChange: (id: BreakForm['id'], patch: Partial<BreakForm>) => void;
  t: Theme;
}): JSX.Element {
  const head: CSSProperties = {
    textAlign: 'left',
    fontSize: 12,
    fontWeight: 650,
    color: t.muted,
    padding: '6px 6px',
    borderBottom: `1px solid ${t.border}`,
  };
  const cell: CSSProperties = { padding: '6px 6px', verticalAlign: 'top' };
  return (
    <table aria-label="breaks" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr>
          <th style={head}>Type</th>
          <th style={head}>On</th>
          <th style={head}>Name</th>
          <th style={head}>Pay</th>
          <th style={head}>Limit</th>
        </tr>
      </thead>
      <tbody>
        {breaks.map((b) => {
          const c = company?.find((x) => x.id === b.id);
          const s = saved.find((x) => x.id === b.id);
          const differs = !!c && breakText(c) !== breakText(b);
          const unsaved = !!s && breakText(s) !== breakText(b);
          return (
            <tr key={b.id} aria-label={`break ${b.id}`} style={{ opacity: b.enabled ? 1 : 0.65 }}>
              <td style={{ ...cell, color: t.muted, whiteSpace: 'nowrap' }}>
                {b.id}
                {unsaved && <span style={{ ...dot(t), marginLeft: 6 }} aria-label="unsaved" />}
              </td>
              <td style={cell}>
                <input
                  aria-label={`${b.id}-enabled`}
                  type="checkbox"
                  checked={b.enabled}
                  onChange={(e) => onChange(b.id, { enabled: e.target.checked })}
                />
              </td>
              <td style={cell}>
                <input
                  aria-label={`${b.id}-label`}
                  value={b.label}
                  maxLength={30}
                  onChange={(e) => onChange(b.id, { label: e.target.value })}
                  style={{ ...input(t), width: '100%', boxSizing: 'border-box' }}
                />
                {issues[b.id] && (
                  <span style={{ display: 'block', fontSize: 12, color: t.danger }}>
                    {issues[b.id]}
                  </span>
                )}
                {differs && c && (
                  <OverrideNote
                    text={breakText(c)}
                    reset={() =>
                      onChange(b.id, {
                        enabled: c.enabled,
                        label: c.label,
                        pay: c.pay,
                        maxMinutes: c.maxMinutes,
                      })
                    }
                    t={t}
                  />
                )}
              </td>
              <td style={cell}>
                <select
                  aria-label={`${b.id}-pay`}
                  value={b.pay}
                  onChange={(e) => onChange(b.id, { pay: e.target.value as BreakPay })}
                  style={input(t)}
                >
                  {PAY_LABELS.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </td>
              <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                <input
                  aria-label={`${b.id}-limit`}
                  type="number"
                  inputMode="numeric"
                  placeholder={mayHaveNoLimit(b.id) ? 'None' : undefined}
                  value={
                    b.maxMinutes === null ? '' : Number.isFinite(b.maxMinutes) ? b.maxMinutes : ''
                  }
                  onChange={(e) =>
                    onChange(b.id, {
                      maxMinutes:
                        e.target.value === ''
                          ? mayHaveNoLimit(b.id)
                            ? null
                            : Number.NaN
                          : Number(e.target.value),
                    })
                  }
                  style={{ ...input(t), width: 64 }}
                />{' '}
                <span style={{ fontSize: 12, color: t.muted }}>min</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function NumberInput({
  name,
  value,
  onChange,
}: {
  name: string;
  value: number;
  onChange: (v: number) => void;
}): JSX.Element {
  const t = useTheme();
  return (
    <input
      aria-label={name}
      type="number"
      inputMode="numeric"
      value={Number.isFinite(value) ? value : ''}
      onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
      style={{ ...input(t), width: 90 }}
    />
  );
}

function Check({
  name,
  on,
  onChange,
}: {
  name: string;
  on: boolean;
  onChange: (on: boolean) => void;
}): JSX.Element {
  return (
    <input
      aria-label={name}
      type="checkbox"
      checked={on}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function Note({ t, children }: { t: Theme; children: ReactNode }): JSX.Element {
  return (
    <p style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.45, color: t.muted }}>{children}</p>
  );
}

function dot(t: Theme): CSSProperties {
  return {
    display: 'inline-block',
    width: 7,
    height: 7,
    borderRadius: 999,
    background: t.accent,
    verticalAlign: 'middle',
  };
}

function badge(t: Theme): CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 650,
    padding: '1px 6px',
    borderRadius: 999,
    background: t.warnBg,
    color: t.warnText,
  };
}

function menuItem(t: Theme, on: boolean): CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    textAlign: 'left',
    padding: '7px 10px',
    border: 'none',
    borderLeft: `3px solid ${on ? t.accent : 'transparent'}`,
    borderRadius: 6,
    background: on ? t.surfaceAlt : 'transparent',
    color: on ? t.text : t.muted,
    font: 'inherit',
    fontSize: 13,
    fontWeight: on ? 650 : 500,
    cursor: 'pointer',
  };
}

function saveBar(t: Theme): CSSProperties {
  return {
    position: 'sticky',
    bottom: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    border: `1px solid ${t.accent}`,
    borderRadius: 12,
    background: t.surface,
    boxShadow: '0 -4px 16px rgba(0,0,0,0.08)',
    fontSize: 13,
  };
}

function warnBox(t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    background: t.warnBg,
    color: t.warnText,
    fontSize: 13,
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
    fontSize: 12,
    cursor: 'pointer',
  };
}
