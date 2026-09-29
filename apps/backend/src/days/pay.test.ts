import { describe, expect, it } from 'vitest';
import { resolvePolicy } from '../policy/resolve.js';
import { breakRules, DEFAULT_BREAK_RULES, splitBreak } from './pay.js';

const MIN = 60_000;

describe('break pay rules (ADR-0023 §3)', () => {
  it('defaults: bio and tea paid up to 10/15, meal, personal and other unpaid', () => {
    expect(DEFAULT_BREAK_RULES).toEqual({
      bio_break: { pay: 'paid_up_to_limit', maxMinutes: 10 },
      meal_break: { pay: 'unpaid', maxMinutes: 60 },
      rest_break: { pay: 'paid_up_to_limit', maxMinutes: 15 },
      personal_break: { pay: 'unpaid', maxMinutes: 30 },
      other_break: { pay: 'unpaid', maxMinutes: null },
    });
  });

  it('follows an override', () => {
    const rules = breakRules(
      resolvePolicy([{ break: { meal: { pay: 'paid' }, rest: { max_minutes: 20 } } }]),
    );
    expect(rules['meal_break']).toEqual({ pay: 'paid', maxMinutes: 60 });
    expect(rules['rest_break']).toEqual({ pay: 'paid_up_to_limit', maxMinutes: 20 });
  });

  it('splits one break at its limit', () => {
    const upTo10 = { pay: 'paid_up_to_limit' as const, maxMinutes: 10 };
    expect(splitBreak(upTo10, 8 * MIN)).toEqual({ paid: 8 * MIN, unpaid: 0 });
    expect(splitBreak(upTo10, 14 * MIN)).toEqual({ paid: 10 * MIN, unpaid: 4 * MIN });
    expect(splitBreak({ pay: 'paid_up_to_limit', maxMinutes: null }, 30 * MIN)).toEqual({
      paid: 30 * MIN,
      unpaid: 0,
    });
    expect(splitBreak({ pay: 'paid', maxMinutes: 5 }, 30 * MIN).paid).toBe(30 * MIN);
    expect(splitBreak({ pay: 'unpaid', maxMinutes: 5 }, 30 * MIN).unpaid).toBe(30 * MIN);
    expect(splitBreak(undefined, 30 * MIN).unpaid).toBe(30 * MIN);
  });
});
