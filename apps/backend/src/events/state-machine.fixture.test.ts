import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nextState, type PayrollState } from './state-machine.js';

/**
 * Shared transition fixture. The desktop core (`core/state.rs`) runs
 * the same file through its Rust mirror of `nextState`, so the two
 * machines cannot drift apart silently.
 */
interface FixtureCase {
  from: PayrollState;
  event_type: string;
  payload: Record<string, unknown> | null;
  to: PayrollState | null;
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../packages/event-schema/fixtures/state-transitions.json', import.meta.url),
    'utf8',
  ),
) as { cases: FixtureCase[] };

describe('nextState — shared transition fixture', () => {
  it('fixture is non-empty', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixture.cases) {
    it(`${c.from} + ${c.event_type} ${JSON.stringify(c.payload)} → ${String(c.to)}`, () => {
      expect(nextState(c.from, c.event_type, c.payload ?? undefined)).toBe(c.to);
    });
  }
});
