import type { DbRepositories, RetentionKind } from '../db/index.js';
import { effectivePolicyForScope } from '../policy/service.js';

/**
 * Data retention settings (ADR-0044 §1): the global `retention` policy
 * only, off by default. Periods are in days for the purge; the two long
 * ones are set in years.
 */

/** The kinds, in the order they run. */
export const RETENTION_KINDS: readonly RetentionKind[] = [
  'time_records',
  'idle_notes',
  'audit_log',
  'notifications',
  'operational',
];

/**
 * Floors in days, the same as the database function's (migration 0019):
 * nothing shorter is ever asked for.
 */
export const RETENTION_FLOOR_DAYS: Readonly<Record<RetentionKind, number>> = {
  time_records: 1096,
  audit_log: 1096,
  idle_notes: 90,
  notifications: 120,
  operational: 30,
};

export interface RetentionSettings {
  enabled: boolean;
  /** Days to keep, per kind. */
  days: Record<RetentionKind, number>;
}

/** The proposed defaults (ADR-0044 §1), for HR/legal to confirm. */
export const RETENTION_DEFAULTS = {
  time_records_years: 5,
  idle_notes_days: 365,
  audit_log_years: 7,
  notifications_days: 365,
  operational_days: 90,
} as const;

/** Whole years as days, counting leap days. */
export const yearsToDays = (years: number): number => Math.ceil(years * 365.25);

const whole = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;

/** Days per kind from a `retention` policy object; out-of-range values fall back to the defaults. */
export function retentionDays(r: Record<string, unknown>): Record<RetentionKind, number> {
  const d = RETENTION_DEFAULTS;
  return {
    time_records: yearsToDays(whole(r['time_records_years'], 3, 50, d.time_records_years)),
    idle_notes: whole(r['idle_notes_days'], 90, 3650, d.idle_notes_days),
    audit_log: yearsToDays(whole(r['audit_log_years'], 3, 50, d.audit_log_years)),
    notifications: whole(r['notifications_days'], 120, 3650, d.notifications_days),
    operational: whole(r['operational_days'], 30, 3650, d.operational_days),
  };
}

export async function retentionSettings(db: DbRepositories): Promise<RetentionSettings> {
  const { policy } = await effectivePolicyForScope(db, 'global', null);
  const r = (policy['retention'] ?? {}) as Record<string, unknown>;
  return { enabled: r['enabled'] === true, days: retentionDays(r) };
}
