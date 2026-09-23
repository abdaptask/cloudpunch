/**
 * CLI entrypoint: `pnpm migrate`.
 *
 * Reads POSTGRES_URL from the environment and applies every un-applied
 * migration under `apps/backend/db/migrations/`. Idempotent.
 *
 * Exits 0 on success, 1 on any migration failure.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { migrate } from '../src/db/migrations/runner.js';

const POSTGRES_URL = process.env['POSTGRES_URL'];
if (!POSTGRES_URL) {
  process.stderr.write('migrate: POSTGRES_URL env var required\n');
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(scriptDir, '..', 'db', 'migrations');

const sql = postgres(POSTGRES_URL, {
  onnotice: () => undefined,
});

async function main(): Promise<void> {
  try {
    const result = await migrate({ sql, migrationsDir });
    process.stdout.write(
      `migrate: discovered=${result.discovered.length} applied=${result.applied.length} skipped=${result.skippedAlreadyApplied.length}\n`,
    );
    for (const a of result.applied) {
      process.stdout.write(`  ✓ ${a.id}\n`);
    }
  } finally {
    await sql.end();
  }
}

try {
  await main();
} catch (err) {
  process.stderr.write(
    `migrate: failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
}
