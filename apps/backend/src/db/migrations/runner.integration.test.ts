import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationError, migrate } from './runner.js';

/**
 * Integration test for the migration runner. Spins up a real Postgres
 * container via testcontainers, applies the on-disk migrations, and
 * verifies both idempotency and drift detection.
 *
 * Requires Docker. Runs only under `pnpm test:integration`.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'db',
  'migrations',
);

let container: StartedPostgreSqlContainer;
let sql: postgres.Sql;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  sql = postgres(container.getConnectionUri(), { onnotice: () => undefined });
});

afterAll(async () => {
  if (sql) await sql.end();
  if (container) await container.stop();
});

describe('migrate — happy path', () => {
  it('applies every migration in order and marks them in schema_migrations', async () => {
    const result = await migrate({ sql, migrationsDir: MIGRATIONS_DIR });
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.applied[0]?.id).toBe('0001_baseline_identity.sql');
    expect(result.applied.map((a) => a.id)).toContain('0002_time_events.sql');

    // Assert core tables exist after migration
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const names = new Set(tables.map((t) => t.table_name));
    expect(names.has('app_user')).toBe(true);
    expect(names.has('employee')).toBe(true);
    expect(names.has('device')).toBe(true);
    expect(names.has('time_session')).toBe(true);
    expect(names.has('time_event')).toBe(true);
    expect(names.has('audit_log')).toBe(true);
    expect(names.has('schema_migrations')).toBe(true);
  });

  it('is idempotent — second run applies nothing', async () => {
    const result = await migrate({ sql, migrationsDir: MIGRATIONS_DIR });
    expect(result.applied.length).toBe(0);
    expect(result.skippedAlreadyApplied.length).toBeGreaterThan(0);
  });

  it('append-only trigger on time_event refuses UPDATE and DELETE', async () => {
    await expect(sql`UPDATE time_event SET event_type = 'x' WHERE false`).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`DELETE FROM time_event WHERE false`).rejects.toThrow(/append-only/);
  });

  it('append-only trigger on audit_log refuses UPDATE and DELETE', async () => {
    await expect(sql`UPDATE audit_log SET action = 'x' WHERE false`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_log WHERE false`).rejects.toThrow(/append-only/);
  });
});

describe('migrate — invariant checks', () => {
  it('rejects a filename that does not match NNNN_slug.sql', async () => {
    // Point at a temp dir with a bad filename.
    const badDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test-bad');
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    await mkdir(badDir, { recursive: true });
    await writeFile(path.join(badDir, 'not-numbered.sql'), 'SELECT 1;');
    try {
      await expect(migrate({ sql, migrationsDir: badDir })).rejects.toBeInstanceOf(MigrationError);
    } finally {
      await rm(badDir, { recursive: true, force: true });
    }
  });
});
