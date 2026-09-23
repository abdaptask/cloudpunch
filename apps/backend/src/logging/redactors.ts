/**
 * PII and secret redaction paths for pino. See ADR-0007 §11.
 *
 * Paths use pino's fast-redact syntax:
 *   - `a.b.c` — direct nested path
 *   - `*.field` — any object with a top-level `field`
 *   - `[*].field` — array items with `field`
 *
 * Update this list alongside any new field-carrying route or event.
 * Every path is unit-tested in redactors.test.ts.
 */
export const REDACT_PATHS: readonly string[] = Object.freeze([
  // Request/response headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-forwarded-for"]',
  'res.headers["set-cookie"]',

  // Auth token fields when logged as part of a payload
  '*.access_token',
  '*.id_token',
  '*.refresh_token',
  '*.authorization',
  '*.password',
  '*.client_secret',
  '*.api_key',

  // Event / signing material
  '*.integrity_signature',
  '*.signature',
  '*.webhook_signing_key',
  '*.sqlcipher_key',
  '*.private_key',

  // Free-text employee notes — cautious: not secret, but PII surface
  '*.note',
]);

export const REDACT_CENSOR = '***REDACTED***';
