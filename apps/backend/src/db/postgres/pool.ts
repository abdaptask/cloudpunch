import postgres from 'postgres';

/**
 * Create a Postgres client wired for CloudPunch conventions:
 *   - `transform: postgres.camel` maps snake_case columns ↔ camelCase
 *     JS/TS field names in both directions.
 *   - `onnotice` suppresses NOTICE noise from CREATE TABLE IF NOT
 *     EXISTS chatter in tests and boot.
 *
 * Callers own the returned client's lifecycle (`await sql.end()`).
 */
export function createPostgresClient(url: string, opts: { max?: number } = {}): postgres.Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    transform: postgres.camel,
    onnotice: () => undefined,
  });
}
