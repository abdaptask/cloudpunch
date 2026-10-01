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
  if (Object.keys(breakIssues(f)).length > 0) out.breaks = 'Fix the break types marked below';
  else if (!f.breaks.some((b) => b.enabled)) out.breaks = 'Keep at least one break type on';
  return out;
}

/**
 * The scope's new override: its current document with the form's
 * settings written in. Other settings in the override are kept.
 * `connections.record` is written only company-wide (`global`): the
 * server reads it from there alone (ADR-0029 §7).
 */
export function overrideWith(current: Doc | null, f: SettingsForm, global = false): Doc {
  const base = current ?? {};
  return {
    ...(global
      ? { connections: { ...obj(base['connections']), record: f.recordConnections } }
      : {}),
    ...base,
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
