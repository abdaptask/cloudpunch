import postgres from 'postgres';

/**
 * Create a Postgres client wired for CloudPunch conventions:
 *   - column names map snake_case ↔ camelCase in both directions
 *     ([`POSTGRES_TRANSFORM`]). JSON values are left alone.
 *   - `onnotice` suppresses NOTICE noise from CREATE TABLE IF NOT
 *     EXISTS chatter in tests and boot.
 *
 * Callers own the returned client's lifecycle (`await sql.end()`).
 */
/**
 * Column names only. `postgres.camel` also camelCases the keys inside
 * json/jsonb values on read, so a stored event payload `{break_kind}`
 * came back as `{breakKind}` and ingest's state derivation no longer
 * recognised earlier events of the session (an END_BREAK in a later
 * batch was rejected). Payloads and policy documents must round-trip
 * exactly as written.
 */
export const POSTGRES_TRANSFORM = { column: postgres.camel.column };

export function createPostgresClient(url: string, opts: { max?: number } = {}): postgres.Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    transform: POSTGRES_TRANSFORM,
    onnotice: () => undefined,
  });
}
