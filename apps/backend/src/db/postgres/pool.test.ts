import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { POSTGRES_TRANSFORM } from './pool.js';

describe('POSTGRES_TRANSFORM', () => {
  it('maps column names both ways', () => {
    expect(POSTGRES_TRANSFORM.column.from('break_kind')).toBe('breakKind');
    expect(POSTGRES_TRANSFORM.column.to('breakKind')).toBe('break_kind');
  });

  it('never rewrites keys inside json values (payloads round-trip)', () => {
    expect('value' in POSTGRES_TRANSFORM).toBe(false);
    // The trap it avoids: postgres.camel rewrites jsonb keys on read.
    const jsonb = { type: 3802 } as unknown as postgres.Column<string>;
    const camelValue = postgres.camel.value.from as (x: unknown, c: unknown) => unknown;
    expect(camelValue({ break_kind: 'meal' }, jsonb)).toEqual({ breakKind: 'meal' });
  });
});
