/**
 * The HR / Administrator settings form (ADR-0018 §5): a few policy
 * values in plain units, read from what a scope resolves to and written
 * back into that scope's override document. Ranges match
 * `packages/policy-schema/idle-policy.schema.json`; the server validates
 * again on save.
 */

export interface SettingsForm {
  /** idle.threshold_seconds, in minutes. */
  idlePromptMinutes: number;
  /** idle.grace_seconds. */
  promptWaitSeconds: number;
  /** idle.max_idle_minutes; null = never clock out for idle. */
  idleCapMinutes: number | null;
  /** idle.input_pattern_check.enabled (ADR-0024). */
  presenceCheck: boolean;
  /** reminders.clock_in_prompt_at, "HH:MM"; null = off. */
  clockInPromptAt: string | null;
  /** reminders.clock_in_prompt_tz. */
  clockInPromptTz: string;
  /** reminders.long_day_hours. */
  longDayHours: number;
  /** reminders.long_shift_hours. */
  longShiftHours: number;
  /** break.<id>, in menu order (ADR-0023). */
  breaks: BreakForm[];
  /** away.offer_training. */
  offerTraining: boolean;
  /** away.check_after_minutes (ADR-0027). */
  awayCheckMinutes: number;
  /** connections.record (ADR-0029); company-wide only. */
  recordConnections: boolean;
  /** alerts.location_emails (ADR-0041); company-wide only. */
  locationEmails: boolean;
  /** alerts.shift_emails (ADR-0037 §3); company-wide only. */
  shiftEmails: boolean;
  /** alerts.missed_clock_in_minutes (ADR-0037 §3); company-wide only. */
  missedClockInMinutes: number;
}

export type BreakId = 'bio' | 'meal' | 'rest' | 'personal' | 'other';
export type BreakPay = 'paid' | 'unpaid' | 'paid_up_to_limit';

export interface BreakForm {
  id: BreakId;
  enabled: boolean;
  label: string;
  pay: BreakPay;
  /** Reminder limit and, for paid_up_to_limit, the paid boundary; null = none (Other only). */
  maxMinutes: number | null;
}

/** The fixed catalogue and its schema defaults (ADR-0023 §1). */
export const BREAK_DEFAULTS: readonly BreakForm[] = [
  { id: 'bio', enabled: true, label: 'Bio break', pay: 'paid_up_to_limit', maxMinutes: 10 },
  { id: 'meal', enabled: true, label: 'Meal break', pay: 'unpaid', maxMinutes: 60 },
  { id: 'rest', enabled: true, label: 'Tea break', pay: 'paid_up_to_limit', maxMinutes: 15 },
  { id: 'personal', enabled: true, label: 'Personal', pay: 'unpaid', maxMinutes: 30 },
  { id: 'other', enabled: false, label: 'Other break', pay: 'unpaid', maxMinutes: null },
];

export const PAY_LABELS: [BreakPay, string][] = [
  ['paid_up_to_limit', 'Paid up to the limit'],
  ['paid', 'Paid'],
  ['unpaid', 'Unpaid'],
];

/** Only Other may have no limit (the schema's rule). */
export const mayHaveNoLimit = (id: BreakId): boolean => id === 'other';

/** Zones HR is likely to pick; any IANA name the policy holds is kept. */
export const ZONES: [string, string][] = [
  ['America/New_York', 'US Eastern (New York)'],
  ['America/Chicago', 'US Central (Chicago)'],
  ['America/Denver', 'US Mountain (Denver)'],
  ['America/Los_Angeles', 'US Pacific (Los Angeles)'],
  ['Asia/Kolkata', 'India (Kolkata)'],
  ['Europe/London', 'UK (London)'],
  ['UTC', 'UTC'],
];

type Doc = Record<string, unknown>;

const obj = (v: unknown): Doc =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : {};
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** The form's values from a resolved policy. */
export function formFrom(policy: Doc): SettingsForm {
  const idle = obj(policy['idle']);
  const reminders = obj(policy['reminders']);
  const cap = idle['max_idle_minutes'];
  const at = reminders['clock_in_prompt_at'];
  return {
    idlePromptMinutes: Math.round(num(idle['threshold_seconds'], 120) / 60),
    promptWaitSeconds: num(idle['grace_seconds'], 30),
    idleCapMinutes: cap === null ? null : num(cap, 120),
    presenceCheck: obj(idle['input_pattern_check'])['enabled'] === true,
    clockInPromptAt: at === null ? null : typeof at === 'string' ? at : '08:00',
    clockInPromptTz:
      typeof reminders['clock_in_prompt_tz'] === 'string'
        ? reminders['clock_in_prompt_tz']
        : 'America/New_York',
    longDayHours: num(reminders['long_day_hours'], 8),
    longShiftHours: num(reminders['long_shift_hours'], 9),
    breaks: BREAK_DEFAULTS.map((d) => {
      const b = obj(obj(policy['break'])[d.id]);
      const pay = b['pay'];
      const max = b['max_minutes'];
      return {
        id: d.id,
        enabled: typeof b['enabled'] === 'boolean' ? b['enabled'] : d.enabled,
        label: typeof b['label'] === 'string' ? b['label'] : d.label,
        pay: pay === 'paid' || pay === 'unpaid' || pay === 'paid_up_to_limit' ? pay : d.pay,
        maxMinutes:
          max === undefined
            ? d.maxMinutes
            : max === null && mayHaveNoLimit(d.id)
              ? null
              : num(max, d.maxMinutes ?? 30),
      };
    }),
    offerTraining:
      typeof obj(policy['away'])['offer_training'] === 'boolean'
        ? (obj(policy['away'])['offer_training'] as boolean)
        : true,
    awayCheckMinutes: num(obj(policy['away'])['check_after_minutes'], 60),
    recordConnections: obj(policy['connections'])['record'] === true,
    locationEmails: obj(policy['alerts'])['location_emails'] === true,
    shiftEmails: obj(policy['alerts'])['shift_emails'] === true,
    missedClockInMinutes: num(obj(policy['alerts'])['missed_clock_in_minutes'], 15),
  };
}

/** Per-break problems, keyed by break id. */
export function breakIssues(f: SettingsForm): Partial<Record<BreakId, string>> {
  const out: Partial<Record<BreakId, string>> = {};
  for (const b of f.breaks) {
    const label = b.label.trim();
    if (label.length < 1 || label.length > 30) out[b.id] = 'A name of 1 to 30 characters';
    else if (
      b.maxMinutes === null
        ? !mayHaveNoLimit(b.id)
        : !Number.isInteger(b.maxMinutes) || b.maxMinutes < 5 || b.maxMinutes > 180
    ) {
      out[b.id] = 'A limit between 5 and 180 minutes';
    }
  }
  return out;
}

/** Problems to fix before saving, by field. Empty when valid. */
export function formIssues(f: SettingsForm): Partial<Record<keyof SettingsForm, string>> {
  const out: Partial<Record<keyof SettingsForm, string>> = {};
  const whole = (n: number, lo: number, hi: number): boolean =>
    Number.isInteger(n) && n >= lo && n <= hi;
  if (!whole(f.idlePromptMinutes, 1, 60)) out.idlePromptMinutes = 'Between 1 and 60 minutes';
  if (!whole(f.promptWaitSeconds, 10, 300)) out.promptWaitSeconds = 'Between 10 and 300 seconds';
  if (f.idleCapMinutes !== null && !whole(f.idleCapMinutes, 15, 480)) {
    out.idleCapMinutes = 'Between 15 and 480 minutes';
  }
  if (f.clockInPromptAt !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.clockInPromptAt)) {
    out.clockInPromptAt = 'A time like 08:00';
  }
  if (!whole(f.longDayHours, 4, 16)) out.longDayHours = 'Between 4 and 16 hours';
  if (!whole(f.longShiftHours, 4, 16)) out.longShiftHours = 'Between 4 and 16 hours';
  if (!whole(f.awayCheckMinutes, 15, 240)) out.awayCheckMinutes = 'Between 15 and 240 minutes';
  if (!whole(f.missedClockInMinutes, 5, 120)) {
    out.missedClockInMinutes = 'Between 5 and 120 minutes';
  }
  if (Object.keys(breakIssues(f)).length > 0) out.breaks = 'Fix the break types marked below';
  else if (!f.breaks.some((b) => b.enabled)) out.breaks = 'Keep at least one break type on';
  return out;
}

/**
 * The scope's new override: its current document with the form's
 * settings written in. Other settings in the override are kept.
 * `connections.record` (ADR-0029 §7) and `alerts` (ADR-0037) are
 * written only company-wide (`global`): the server reads them from
 * there alone.
 */
export function overrideWith(current: Doc | null, f: SettingsForm, global = false): Doc {
  const base = current ?? {};
  return {
    ...base,
    // After `base`, so a saved value can change (it once couldn't).
    ...(global
      ? {
          connections: { ...obj(base['connections']), record: f.recordConnections },
          alerts: {
            ...obj(base['alerts']),
            shift_emails: f.shiftEmails,
            location_emails: f.locationEmails,
            missed_clock_in_minutes: f.missedClockInMinutes,
          },
        }
      : {}),
    idle: {
      ...obj(base['idle']),
      threshold_seconds: f.idlePromptMinutes * 60,
      grace_seconds: f.promptWaitSeconds,
      max_idle_minutes: f.idleCapMinutes,
      input_pattern_check: {
        ...obj(obj(base['idle'])['input_pattern_check']),
        enabled: f.presenceCheck,
      },
    },
    reminders: {
      ...obj(base['reminders']),
      clock_in_prompt_at: f.clockInPromptAt,
      clock_in_prompt_tz: f.clockInPromptTz,
      long_day_hours: f.longDayHours,
      long_shift_hours: f.longShiftHours,
    },
    // Other settings inside each entry (e.g. meal's prompt) are kept.
    break: Object.fromEntries([
      ...Object.entries(obj(base['break'])),
      ...f.breaks.map((b) => [
        b.id,
        {
          ...obj(obj(base['break'])[b.id]),
          enabled: b.enabled,
          label: b.label.trim(),
          pay: b.pay,
          max_minutes: b.maxMinutes,
        },
      ]),
    ]),
    away: {
      ...obj(base['away']),
      offer_training: f.offerTraining,
      check_after_minutes: f.awayCheckMinutes,
    },
  };
}

// The admin console's Rules page (ADR-0038 §8): sections, unsaved
// changes, and a department's values against the company's.

/** A setting other than the break table. */
export type ScalarKey = Exclude<keyof SettingsForm, 'breaks'>;

export type RuleSectionKey =
  'idle' | 'clockIn' | 'longDays' | 'breaks' | 'away' | 'connections' | 'alerts';

export interface RuleSection {
  key: RuleSectionKey;
  label: string;
  fields: readonly ScalarKey[];
  /** Read from the company-wide policy only (ADR-0029 §7, ADR-0037). */
  companyOnly?: true;
}

export const RULE_SECTIONS: readonly RuleSection[] = [
  {
    key: 'idle',
    label: 'Idle',
    fields: ['idlePromptMinutes', 'promptWaitSeconds', 'idleCapMinutes', 'presenceCheck'],
  },
  { key: 'clockIn', label: 'Clock-in popup', fields: ['clockInPromptAt', 'clockInPromptTz'] },
  { key: 'longDays', label: 'Long days', fields: ['longDayHours', 'longShiftHours'] },
  { key: 'breaks', label: 'Breaks', fields: [] },
  { key: 'away', label: 'Away', fields: ['offerTraining', 'awayCheckMinutes'] },
  {
    key: 'connections',
    label: 'Connection location',
    fields: ['recordConnections', 'locationEmails'],
    companyOnly: true,
  },
  {
    key: 'alerts',
    label: 'Shift-start emails',
    fields: ['shiftEmails', 'missedClockInMinutes'],
    companyOnly: true,
  },
];

const BREAK_FIELDS = ['enabled', 'label', 'pay', 'maxMinutes'] as const;
type BreakField = (typeof BREAK_FIELDS)[number];

const same = (x: unknown, y: unknown): boolean =>
  x === y || (typeof x === 'number' && typeof y === 'number' && Number.isNaN(x) && Number.isNaN(y));

/**
 * What differs between two forms: a setting's key, or
 * `breaks.<id>.<field>` for the break table.
 */
export function changedFields(a: SettingsForm, b: SettingsForm): string[] {
  const out: string[] = [];
  for (const s of RULE_SECTIONS) for (const k of s.fields) if (!same(a[k], b[k])) out.push(k);
  for (const x of a.breaks) {
    const y = b.breaks.find((z) => z.id === x.id);
    for (const f of BREAK_FIELDS) {
      if (!y || !same(x[f], y[f])) out.push(`breaks.${x.id}.${f}`);
    }
  }
  return out;
}

/** The section a changed field belongs to. */
export function sectionOf(field: string): RuleSectionKey {
  if (field.startsWith('breaks.')) return 'breaks';
  return RULE_SECTIONS.find((s) => (s.fields as readonly string[]).includes(field))?.key ?? 'idle';
}

/** Where each department-level setting lives in the policy document. */
const PATHS: Partial<Record<ScalarKey, readonly string[]>> = {
  idlePromptMinutes: ['idle', 'threshold_seconds'],
  promptWaitSeconds: ['idle', 'grace_seconds'],
  idleCapMinutes: ['idle', 'max_idle_minutes'],
  presenceCheck: ['idle', 'input_pattern_check', 'enabled'],
  clockInPromptAt: ['reminders', 'clock_in_prompt_at'],
  clockInPromptTz: ['reminders', 'clock_in_prompt_tz'],
  longDayHours: ['reminders', 'long_day_hours'],
  longShiftHours: ['reminders', 'long_shift_hours'],
  offerTraining: ['away', 'offer_training'],
  awayCheckMinutes: ['away', 'check_after_minutes'],
};
const BREAK_PATH: Record<BreakField, string> = {
  enabled: 'enabled',
  label: 'label',
  pay: 'pay',
  maxMinutes: 'max_minutes',
};

/** Drops `path` from `doc`, then any object it leaves empty. */
function dropPath(doc: Doc, path: readonly string[]): void {
  const [head, ...rest] = path;
  if (head === undefined || !(head in doc)) return;
  if (rest.length === 0) {
    delete doc[head];
    return;
  }
  const value = doc[head];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const child = value as Doc;
  dropPath(child, rest);
  if (Object.keys(child).length === 0) delete doc[head];
}

/**
 * A department's new override (ADR-0038 §8): only what differs from the
 * company. A value set back to the company's is left out, so the
 * department follows the company for it again. Settings the form
 * doesn't show are kept.
 */
export function departmentOverride(
  current: Doc | null,
  f: SettingsForm,
  company: SettingsForm,
): Doc {
  const doc = structuredClone(overrideWith(current, f, false));
  for (const [k, path] of Object.entries(PATHS) as [ScalarKey, readonly string[]][]) {
    if (same(f[k], company[k])) dropPath(doc, path);
  }
  for (const b of f.breaks) {
    const c = company.breaks.find((x) => x.id === b.id);
    for (const field of BREAK_FIELDS) {
      if (c && same(b[field], c[field])) dropPath(doc, ['break', b.id, BREAK_PATH[field]]);
    }
  }
  return doc;
}

const HOURS = (n: number): string => `${n} ${n === 1 ? 'hour' : 'hours'}`;
const MINUTES = (n: number): string => `${n} min`;

/** A setting's value in words, for "Company: …". */
export function valueText(k: ScalarKey, f: SettingsForm): string {
  const onOff = (v: boolean): string => (v ? 'On' : 'Off');
  switch (k) {
    case 'idlePromptMinutes':
      return MINUTES(f.idlePromptMinutes);
    case 'promptWaitSeconds':
      return `${f.promptWaitSeconds} s`;
    case 'idleCapMinutes':
      return f.idleCapMinutes === null ? 'Never' : MINUTES(f.idleCapMinutes);
    case 'presenceCheck':
      return onOff(f.presenceCheck);
    case 'clockInPromptAt':
      return f.clockInPromptAt ?? 'Off';
    case 'clockInPromptTz':
      return ZONES.find(([z]) => z === f.clockInPromptTz)?.[1] ?? f.clockInPromptTz;
    case 'longDayHours':
      return HOURS(f.longDayHours);
    case 'longShiftHours':
      return HOURS(f.longShiftHours);
    case 'offerTraining':
      return onOff(f.offerTraining);
    case 'awayCheckMinutes':
      return MINUTES(f.awayCheckMinutes);
    case 'recordConnections':
      return onOff(f.recordConnections);
    case 'locationEmails':
      return onOff(f.locationEmails);
    case 'shiftEmails':
      return onOff(f.shiftEmails);
    case 'missedClockInMinutes':
      return MINUTES(f.missedClockInMinutes);
  }
}

/** One break's value in words, for "Company: …". */
export function breakText(b: BreakForm): string {
  const pay = PAY_LABELS.find(([p]) => p === b.pay)?.[1] ?? b.pay;
  const limit = b.maxMinutes === null ? 'no limit' : MINUTES(b.maxMinutes);
  return `${b.enabled ? 'On' : 'Off'} · ${b.label} · ${pay} · ${limit}`;
}
