/**
 * CloudPunch canonical JSON. Matches the byte-level rules documented in
 * `canonicalization.md` at the root of this package. Both the backend
 * (this file) and the Rust desktop core (`apps/desktop/src-tauri/src/event/canonicalize.rs`)
 * MUST produce byte-identical output for the same input; a conformance
 * suite lands in Phase 2b to enforce this.
 *
 * Rules recap:
 *   - UTF-8 encoding, no BOM.
 *   - No whitespace outside string values.
 *   - Object keys sorted lexicographically (UTF-16 code-unit order).
 *   - Numbers: integers only.
 *   - Booleans: `true` / `false`.
 *   - `null` preserved.
 *   - String escapes limited to \" \\ \b \f \n \r \t and \u00XX for
 *     other controls; non-ASCII characters preserved literally as UTF-8.
 *   - No trailing commas, no duplicate keys.
 */

/**
 * The exact set of top-level fields covered by the Ed25519 signature.
 * Any change here is a signing-contract break and requires migration.
 * Order matters only in that this array documents intent; the actual
 * on-wire ordering is enforced by the alphabetical key sort inside
 * {@link canonicalize}.
 */
export const SIGNED_FIELD_NAMES: readonly string[] = Object.freeze([
  'app_version',
  'client_ts',
  'correlation_id',
  'device_id',
  'employee_id',
  'event_type',
  'event_ulid',
  'monotonic_ns',
  'offline_captured',
  'origin',
  'parent_event_ulid',
  'payload',
  'sequence_number',
  'session_id',
  'tz_iana',
  'utc_offset_minutes',
]);

/** Fields intentionally excluded from the signature. */
export const UNSIGNED_FIELD_NAMES: readonly string[] = Object.freeze([
  'integrity_signature',
  'server_ts',
  'inserted_at',
]);

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/**
 * Serialize a value to canonical JSON bytes. Throws on:
 *   - Non-integer numbers (NaN, Infinity, fractions)
 *   - `undefined` values (JSON has no undefined)
 *   - Functions, symbols, bigints
 *   - Cyclic references
 */
export function canonicalize(value: CanonicalJsonValue): Uint8Array {
  const seen = new WeakSet<object>();
  const out = writeValue(value, seen);
  return new TextEncoder().encode(out);
}

function writeValue(v: CanonicalJsonValue, seen: WeakSet<object>): string {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    const n = v as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalizationError('non-finite number is not representable in canonical JSON');
    }
    if (!Number.isInteger(n)) {
      throw new CanonicalizationError('fractional numbers are not permitted in canonical payloads');
    }
    // Integers within safe-integer range serialize deterministically via toString(10).
    if (n < Number.MIN_SAFE_INTEGER || n > Number.MAX_SAFE_INTEGER) {
      throw new CanonicalizationError('integer outside JS safe-integer range');
    }
    return n.toString(10);
  }
  if (t === 'string') return writeString(v as string);
  if (Array.isArray(v)) {
    if (seen.has(v)) throw new CanonicalizationError('cycle detected');
    seen.add(v);
    const parts = v.map((item) => writeValue(item as CanonicalJsonValue, seen));
    seen.delete(v);
    return '[' + parts.join(',') + ']';
  }
  if (t === 'object') {
    const obj = v as { readonly [key: string]: CanonicalJsonValue };
    if (seen.has(obj)) throw new CanonicalizationError('cycle detected');
    seen.add(obj);
    // Sort keys lexicographically. TypeScript object keys are UTF-16
    // strings; JS sort() uses UTF-16 code-unit order.
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const child = obj[k];
      if (child === undefined) {
        throw new CanonicalizationError(
          `undefined at key ${JSON.stringify(k)} is not representable`,
        );
      }
      parts.push(writeString(k) + ':' + writeValue(child, seen));
    }
    seen.delete(obj);
    return '{' + parts.join(',') + '}';
  }
  throw new CanonicalizationError(`unsupported type: ${t}`);
}

/**
 * Escape a string per the canonicalization spec. We emit UTF-16 code
 * units unchanged for anything above U+001F except quote and backslash;
 * TextEncoder then converts the concatenated string to correct UTF-8
 * (including surrogate pairs).
 */
function writeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    switch (code) {
      case 0x22: // "
        out += '\\"';
        break;
      case 0x5c: // \
        out += '\\\\';
        break;
      case 0x08:
        out += '\\b';
        break;
      case 0x09:
        out += '\\t';
        break;
      case 0x0a:
        out += '\\n';
        break;
      case 0x0c:
        out += '\\f';
        break;
      case 0x0d:
        out += '\\r';
        break;
      default:
        if (code < 0x20) {
          out += '\\u' + code.toString(16).padStart(4, '0');
        } else {
          out += s[i];
        }
    }
  }
  return out + '"';
}

/**
 * Restrict an event-shaped object down to the signed subset and return
 * its canonical bytes. Both signer (desktop) and verifier (backend) use
 * this identical function; the derived bytes are the input to Ed25519.
 */
export function canonicalizeSignedFields(event: {
  readonly app_version: string;
  readonly client_ts: string;
  readonly correlation_id: string;
  readonly device_id: string;
  readonly employee_id: string;
  readonly event_type: string;
  readonly event_ulid: string;
  readonly monotonic_ns: number;
  readonly offline_captured: boolean;
  readonly origin: string;
  readonly parent_event_ulid: string | null;
  readonly payload: CanonicalJsonValue;
  readonly sequence_number: number;
  readonly session_id: string;
  readonly tz_iana: string;
  readonly utc_offset_minutes: number;
}): Uint8Array {
  return canonicalize({
    app_version: event.app_version,
    client_ts: event.client_ts,
    correlation_id: event.correlation_id,
    device_id: event.device_id,
    employee_id: event.employee_id,
    event_type: event.event_type,
    event_ulid: event.event_ulid,
    monotonic_ns: event.monotonic_ns,
    offline_captured: event.offline_captured,
    origin: event.origin,
    parent_event_ulid: event.parent_event_ulid,
    payload: event.payload,
    sequence_number: event.sequence_number,
    session_id: event.session_id,
    tz_iana: event.tz_iana,
    utc_offset_minutes: event.utc_offset_minutes,
  });
}

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(`canonicalize: ${message}`);
    this.name = 'CanonicalizationError';
  }
}
