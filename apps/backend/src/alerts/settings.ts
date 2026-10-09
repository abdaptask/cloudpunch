import type { DbRepositories } from '../db/index.js';
import { effectivePolicyForScope } from '../policy/service.js';

/**
 * The global `alerts` settings (ADR-0037 §3, §4), read from the global
 * policy only, like `connections.record`: one switch for everyone.
 * Out-of-range values fall back to the schema defaults.
 */
export interface AlertSettings {
  on: boolean;
  graceMinutes: number;
  regularCount: number;
  regularDays: number;
}

export const ALERT_DEFAULTS: AlertSettings = {
  on: false,
  graceMinutes: 15,
  regularCount: 3,
  regularDays: 30,
};

const whole = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;

export async function alertSettings(db: DbRepositories): Promise<AlertSettings> {
  const { policy } = await effectivePolicyForScope(db, 'global', null);
  const a = (policy['alerts'] ?? {}) as Record<string, unknown>;
  return {
    on: a['shift_emails'] === true,
    graceMinutes: whole(a['missed_clock_in_minutes'], 5, 120, ALERT_DEFAULTS.graceMinutes),
    regularCount: whole(a['regular_late_count'], 2, 20, ALERT_DEFAULTS.regularCount),
    regularDays: whole(a['regular_late_days'], 7, 90, ALERT_DEFAULTS.regularDays),
  };
}
