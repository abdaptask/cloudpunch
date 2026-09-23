import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type postgres from 'postgres';

/**
 * Forward-only SQL migration runner.
 *
 * Reads files matching `NNNN_*.sql` from `migrationsDir`, sorts by
 * filename, and applies each un-applied file inside its own
 * transaction. Applied files are recorded in `schema_migrations`
 * (auto-created on first run).
 *
 * Conventions (see apps/backend/db/migrations/README.md):
 *   - Filenames are immutable; never rename or edit after merge.
 *   - Each file is its own transaction — the runner does NOT wrap
 *     multiple files in a single tx.
 *   - Migrations must be idempotent-safe at the file level; if a
 *     migration fails mid-way, the tx rolls back and the runner
 *     surfaces the error. The file remains un-applied and can be
 *     re-run after a fix.
 *   - Runner refuses to apply if it detects a file present in the
 *     schema_migrations table but missing from disk (indicates a
 *     dev picked up a branch with fewer migrations than production).
 */
export interface MigrationEntry {
  id: string; // filename
  applied: boolean;
  appliedAt: Date | null;
  path: string;
}

export interface MigrateResult {
  discovered: readonly MigrationEntry[];
  applied: readonly MigrationEntry[];
  skippedAlreadyApplied: readonly MigrationEntry[];
}

export interface MigrateOptions {
  sql: postgres.Sql;
  migrationsDir: string;
  logger?: {
    info: (msg: string, extra?: Record<string, unknown>) => void;
    warn: (msg: string, extra?: Record<string, unknown>) => void;
  };
}

const FILENAME_RE = /^\d{4}_[a-z0-9_]+\.sql$/i;

export class MigrationError extends Error {
  constructor(
    public readonly code: 'invalid_filename' | 'missing_file_on_disk' | 'apply_failed',
    message: string,
  ) {
    super(`migration: ${message}`);
    this.name = 'MigrationError';
  }
}

export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.logger ?? {
    info: (msg, extra) =>
      process.stdout.write(`${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`),
    warn: (msg, extra) =>
      process.stderr.write(`${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`),
  };

  await ensureSchemaMigrationsTable(opts.sql);

  // Read filesystem
  const dirents = await readdir(opts.migrationsDir, { withFileTypes: true });
  const files = dirents
    .filter((d) => d.isFile() && d.name.endsWith('.sql'))
    .map((d) => d.name)
    .sort();

  for (const f of files) {
    if (!FILENAME_RE.test(f)) {
      throw new MigrationError('invalid_filename', `${f} does not match NNNN_lowercase_slug.sql`);
    }
  }

  // Read applied
  const appliedRows = await opts.sql<{ id: string; applied_at: Date }[]>`
    SELECT id, applied_at FROM schema_migrations ORDER BY id
  `;
  const appliedMap = new Map<string, Date>(appliedRows.map((r) => [r.id, r.applied_at]));

  // Warn on drift: applied file no longer on disk
  const fileSet = new Set(files);
  for (const applied of appliedMap.keys()) {
    if (!fileSet.has(applied)) {
      throw new MigrationError(
        'missing_file_on_disk',
        `${applied} is recorded as applied but is missing from ${opts.migrationsDir}`,
      );
    }
  }

  const discovered: MigrationEntry[] = files.map((f) => ({
    id: f,
    applied: appliedMap.has(f),
    appliedAt: appliedMap.get(f) ?? null,
    path: path.join(opts.migrationsDir, f),
  }));

  const applied: MigrationEntry[] = [];
  const skipped: MigrationEntry[] = discovered.filter((e) => e.applied);

  for (const entry of discovered) {
    if (entry.applied) continue;
    log.info(`applying migration ${entry.id}`);
    const content = await readFile(entry.path, 'utf-8');
    try {
      await opts.sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`INSERT INTO schema_migrations (id) VALUES (${entry.id})`;
      });
    } catch (err) {
      throw new MigrationError(
        'apply_failed',
        `${entry.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    applied.push({ ...entry, applied: true, appliedAt: new Date() });
    log.info(`applied migration ${entry.id}`);
  }

  return {
    discovered,
    applied,
    skippedAlreadyApplied: skipped,
  };
}

async function ensureSchemaMigrationsTable(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          text        PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `;
}
