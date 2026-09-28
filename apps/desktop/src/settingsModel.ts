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
  /** reminders.clock_in_prompt_at, "HH:MM"; null = off. */
  clockInPromptAt: string | null;
  /** reminders.clock_in_prompt_tz. */
  clockInPromptTz: string;
  /** reminders.long_day_hours. */
  longDayHours: number;
  /** reminders.long_shift_hours. */
  longShiftHours: number;
}

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
    clockInPromptAt: at === null ? null : typeof at === 'string' ? at : '08:00',
    clockInPromptTz:
      typeof reminders['clock_in_prompt_tz'] === 'string'
        ? reminders['clock_in_prompt_tz']
        : 'America/New_York',
    longDayHours: num(reminders['long_day_hours'], 8),
    longShiftHours: num(reminders['long_shift_hours'], 9),
  };
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
  return out;
}

/**
 * The scope's new override: its current document with the form's
 * settings written in. Other settings in the override are kept.
 */
export function overrideWith(current: Doc | null, f: SettingsForm): Doc {
  const base = current ?? {};
  return {
    ...base,
    idle: {
      ...obj(base['idle']),
      threshold_seconds: f.idlePromptMinutes * 60,
      grace_seconds: f.promptWaitSeconds,
      max_idle_minutes: f.idleCapMinutes,
    },
    reminders: {
      ...obj(base['reminders']),
      clock_in_prompt_at: f.clockInPromptAt,
      clock_in_prompt_tz: f.clockInPromptTz,
      long_day_hours: f.longDayHours,
      long_shift_hours: f.longShiftHours,
    },
  };
}
