import type { PolicyDocument } from '../policy/resolve.js';
import { schemaDefaults } from '../policy/resolve.js';

/**
 * How break time is paid (ADR-0023 §3), from the policy's `break.*`
 * entries. Pure. Only break segments are paid or unpaid here; work
 * time (including Away) is counted as worked elsewhere.
 */

export type BreakPay = 'paid' | 'unpaid' | 'paid_up_to_limit';

export interface BreakRule {
  pay: BreakPay;
  /** The paid boundary for `paid_up_to_limit`; null = none. */
  maxMinutes: number | null;
}

/** Segment kind (`bio_break`, …) to its rule. */
export type BreakRules = Readonly<Record<string, BreakRule>>;

const KINDS = ['bio', 'meal', 'rest', 'personal', 'other'] as const;
const PAYS: ReadonlySet<string> = new Set(['paid', 'unpaid', 'paid_up_to_limit']);

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The rules in `policy` (a resolved document, so every entry is set). */
export function breakRules(policy: PolicyDocument): BreakRules {
  const breaks = obj(policy['break']);
  const out: Record<string, BreakRule> = {};
  for (const kind of KINDS) {
    const entry = obj(breaks[kind]);
    const pay =
      typeof entry['pay'] === 'string' && PAYS.has(entry['pay']) ? entry['pay'] : 'unpaid';
    const max = entry['max_minutes'];
    out[`${kind}_break`] = {
      pay: pay as BreakPay,
      maxMinutes: typeof max === 'number' ? max : null,
    };
  }
  return out;
}

/** The schema's own defaults (bio and tea paid up to 10/15, the rest unpaid). */
export const DEFAULT_BREAK_RULES: BreakRules = breakRules(schemaDefaults());

/** Paid and unpaid parts of one break segment of `ms`. */
export function splitBreak(
  rule: BreakRule | undefined,
  ms: number,
): { paid: number; unpaid: number } {
  if (!rule || rule.pay === 'unpaid') return { paid: 0, unpaid: ms };
  if (rule.pay === 'paid' || rule.maxMinutes === null) return { paid: ms, unpaid: 0 };
  const paid = Math.min(ms, rule.maxMinutes * 60_000);
  return { paid, unpaid: ms - paid };
}
