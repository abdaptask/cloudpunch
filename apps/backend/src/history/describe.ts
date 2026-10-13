import type { AuditEntry } from '../db/index.js';

/**
 * Change history (ADR-0038 §3, §8), pure: an audit_log row in words.
 * The rows themselves are unchanged; this is only how they read.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** [1,2,3,4,5] → "Mon–Fri"; [1,3] → "Mon, Wed"; [] → "none". */
export function weekdays(v: unknown): string {
  const days = (Array.isArray(v) ? v : [])
    .filter((d): d is number => typeof d === 'number' && d >= 1 && d <= 7)
    .sort((a, b) => a - b);
  if (days.length === 0) return 'none';
  const first = days[0] ?? 1;
  const last = days.at(-1) ?? 1;
  if (days.length >= 3 && last - first === days.length - 1) {
    return `${DAYS[first - 1]}–${DAYS[last - 1]}`;
  }
  return days.map((d) => DAYS[d - 1]).join(', ');
}

/** Names for the employee ids a row mentions (managers). */
export type Names = ReadonlyMap<string, string>;

/** The employee ids a row refers to, so the caller can look up names. */
export function mentioned(e: AuditEntry): string[] {
  if (e.action !== 'reporting_manager_set') return [];
  return [
    str(obj(e.before)['manager_employee_id']),
    str(obj(e.after)['manager_employee_id']),
  ].filter((x): x is string => x !== null);
}

const roles = (v: unknown): string => {
  const list = obj(v)['roles'];
  return Array.isArray(list) && list.length > 0 ? list.join(', ') : 'none';
};

/** One person-history row in words. */
export function describePerson(e: AuditEntry, names: Names): string {
  const before = obj(e.before);
  const after = obj(e.after);
  const who = (id: unknown): string => {
    const s = str(id);
    return s ? (names.get(s) ?? 'someone no longer listed') : 'none';
  };
  switch (e.action) {
    case 'reporting_manager_set':
      return `Manager: ${who(before['manager_employee_id'])} → ${who(after['manager_employee_id'])}`;
    case 'roles_set':
      return `Roles: ${roles(e.before)} → ${roles(e.after)}`;
    case 'shift_assigned': {
      const from = str(after['effective_from']);
      const start = str(after['start']);
      const end = str(after['end']);
      const when = start && end ? `${weekdays(after['days'])} ${start}–${end}` : 'no shift';
      const tz = str(after['tz_iana']);
      return `Shift: ${when}${tz && start ? ` (${tz})` : ''}${from ? `, from ${from}` : ''}`;
    }
    case 'office_pattern_set': {
      const from = str(after['effective_from']);
      return `Office days: ${weekdays(after['weekdays'])}${from ? `, from ${from}` : ''}`;
    }
    case 'office_day_set':
      return `${after['in_office'] === true ? 'In the office' : 'Not in the office'} on ${str(after['date']) ?? '?'}`;
    case 'status_set':
      return `Record: ${str(before['status']) ?? '?'} → ${str(after['status']) ?? '?'}`;
    case 'welcome_sent':
      return 'Welcome email sent';
    case 'device_signed_out':
      return 'Signed out of a computer';
    default:
      return e.action.replace(/_/g, ' ');
  }
}

/** Every leaf of a settings document, as `path → value`. */
function leaves(doc: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  const o = obj(doc);
  for (const [k, v] of Object.entries(o)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) leaves(v, path, out);
    else out.set(path, v);
  }
  return out;
}

const shown = (v: unknown): string => {
  if (v === undefined) return 'not set';
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (v === null) return 'none';
  return typeof v === 'string' ? v : JSON.stringify(v);
};

/** At most this many changed values are listed per save. */
const MAX_CHANGES = 8;

/** One settings save in words: the values it changed. */
export function describePolicy(e: AuditEntry): string {
  if (e.action === 'policy_clear') return 'Settings removed (back to the company values)';
  const was = leaves(obj(e.before)['document']);
  const now = leaves(obj(e.after)['document']);
  const changed = [...new Set([...was.keys(), ...now.keys()])]
    .sort()
    .filter((k) => JSON.stringify(was.get(k)) !== JSON.stringify(now.get(k)));
  if (changed.length === 0) return 'Saved with no changes';
  const lines = changed
    .slice(0, MAX_CHANGES)
    .map((k) => `${k}: ${shown(was.get(k))} → ${shown(now.get(k))}`);
  const more = changed.length - MAX_CHANGES;
  return more > 0 ? `${lines.join('; ')}; and ${more} more` : lines.join('; ');
}

export interface HistoryItem {
  at: string;
  by: string | null;
  action: string;
  summary: string;
  reason: string | null;
}

export const item = (e: AuditEntry, summary: string): HistoryItem => ({
  at: e.at.toISOString(),
  by: e.actorName,
  action: e.action,
  summary,
  reason: e.reason,
});
