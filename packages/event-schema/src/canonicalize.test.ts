import { describe, expect, it } from 'vitest';
import {
  CanonicalizationError,
  canonicalize,
  canonicalizeSignedFields,
  SIGNED_FIELD_NAMES,
} from './canonicalize.js';

const dec = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

describe('canonicalize — primitives', () => {
  it('null', () => {
    expect(dec(canonicalize(null))).toBe('null');
  });
  it('booleans', () => {
    expect(dec(canonicalize(true))).toBe('true');
    expect(dec(canonicalize(false))).toBe('false');
  });
  it('integers', () => {
    expect(dec(canonicalize(0))).toBe('0');
    expect(dec(canonicalize(42))).toBe('42');
    expect(dec(canonicalize(-1))).toBe('-1');
    expect(dec(canonicalize(Number.MAX_SAFE_INTEGER))).toBe(String(Number.MAX_SAFE_INTEGER));
  });
  it('rejects fractional numbers', () => {
    expect(() => canonicalize(3.14)).toThrow(CanonicalizationError);
  });
  it('rejects NaN and Infinity', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(CanonicalizationError);
  });
  it('rejects integers outside safe range', () => {
    expect(() => canonicalize(Number.MAX_SAFE_INTEGER + 1)).toThrow(CanonicalizationError);
  });
});

describe('canonicalize — strings', () => {
  it('empty string', () => {
    expect(dec(canonicalize(''))).toBe('""');
  });
  it('plain ASCII', () => {
    expect(dec(canonicalize('hello'))).toBe('"hello"');
  });
  it('escapes double-quote and backslash', () => {
    expect(dec(canonicalize('a"b\\c'))).toBe('"a\\"b\\\\c"');
  });
  it('escapes standard C-style controls', () => {
    expect(dec(canonicalize('a\nb\tc\rd\be\ff'))).toBe('"a\\nb\\tc\\rd\\be\\ff"');
  });
  it('escapes other controls as \\u00XX', () => {
    expect(dec(canonicalize(''))).toBe('"\\u0001"');
    expect(dec(canonicalize(''))).toBe('"\\u001f"');
  });
  it('preserves UTF-8 bytes for non-ASCII (café)', () => {
    // c a f é  = 0x63 0x61 0x66 0xC3 0xA9
    expect(canonicalize('café')).toEqual(
      new Uint8Array([0x22, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x22]),
    );
  });
  it('preserves surrogate pairs (grinning face U+1F600)', () => {
    // 😀 is F0 9F 98 80 in UTF-8.
    expect(canonicalize('😀')).toEqual(new Uint8Array([0x22, 0xf0, 0x9f, 0x98, 0x80, 0x22]));
  });
});

describe('canonicalize — objects and arrays', () => {
  it('empty object and array', () => {
    expect(dec(canonicalize({}))).toBe('{}');
    expect(dec(canonicalize([]))).toBe('[]');
  });
  it('sorts object keys lexicographically', () => {
    expect(dec(canonicalize({ b: 1, a: 2, c: 3 }))).toBe('{"a":2,"b":1,"c":3}');
    expect(dec(canonicalize({ '': 1, A: 2, a: 3, '0': 4 }))).toBe('{"":1,"0":4,"A":2,"a":3}');
  });
  it('nested objects sort recursively', () => {
    expect(dec(canonicalize({ b: { z: 1, a: 2 }, a: 1 }))).toBe('{"a":1,"b":{"a":2,"z":1}}');
  });
  it('arrays preserve order', () => {
    expect(dec(canonicalize([3, 1, 2]))).toBe('[3,1,2]');
  });
  it('rejects undefined values', () => {
    expect(() => canonicalize({ a: undefined } as never)).toThrow(CanonicalizationError);
  });
  it('rejects cyclic structures', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(() => canonicalize(a as never)).toThrow(CanonicalizationError);
  });
});

describe('canonicalize — determinism guarantee', () => {
  it('same-shape objects with different key insertion order produce identical bytes', () => {
    const a = { z: [1, { x: 'x', a: 'a' }], a: null };
    const b: Record<string, unknown> = {};
    b['a'] = null;
    b['z'] = [1, { a: 'a', x: 'x' }];
    expect(canonicalize(a)).toEqual(canonicalize(b as never));
  });
});

describe('canonicalizeSignedFields — event subset', () => {
  const sample = {
    app_version: '0.1.0',
    client_ts: '2026-09-22T09:15:03.412+05:30',
    correlation_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    device_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    employee_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    event_type: 'USER_CLOCK_IN' as const,
    event_ulid: '01J8Q00000000000000000000A',
    monotonic_ns: 0,
    offline_captured: false,
    origin: 'user' as const,
    parent_event_ulid: null,
    payload: {},
    sequence_number: 1,
    session_id: 'ssssssss-ssss-ssss-ssss-ssssssssssss',
    tz_iana: 'Asia/Kolkata',
    utc_offset_minutes: 330,
  };

  it('produces the expected canonical byte string', () => {
    // Golden vector: byte-for-byte string. If either the sample or the
    // canonicalization changes, this test updates deliberately.
    const expected =
      '{' +
      '"app_version":"0.1.0",' +
      '"client_ts":"2026-09-22T09:15:03.412+05:30",' +
      '"correlation_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",' +
      '"device_id":"dddddddd-dddd-dddd-dddd-dddddddddddd",' +
      '"employee_id":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",' +
      '"event_type":"USER_CLOCK_IN",' +
      '"event_ulid":"01J8Q00000000000000000000A",' +
      '"monotonic_ns":0,' +
      '"offline_captured":false,' +
      '"origin":"user",' +
      '"parent_event_ulid":null,' +
      '"payload":{},' +
      '"sequence_number":1,' +
      '"session_id":"ssssssss-ssss-ssss-ssss-ssssssssssss",' +
      '"tz_iana":"Asia/Kolkata",' +
      '"utc_offset_minutes":330' +
      '}';
    expect(dec(canonicalizeSignedFields(sample))).toBe(expected);
  });

  it('the emitted key set matches SIGNED_FIELD_NAMES exactly', () => {
    const bytes = canonicalizeSignedFields(sample);
    const parsed = JSON.parse(dec(bytes)) as Record<string, unknown>;
    expect(new Set(Object.keys(parsed))).toEqual(new Set(SIGNED_FIELD_NAMES));
  });

  it('permutations of construction order yield the same bytes', () => {
    const permuted = {
      ...sample,
      // deliberately reorder via a spread rebuild
      utc_offset_minutes: sample.utc_offset_minutes,
      app_version: sample.app_version,
      payload: sample.payload,
    };
    expect(canonicalizeSignedFields(permuted)).toEqual(canonicalizeSignedFields(sample));
  });
});
