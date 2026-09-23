import { defineConfig } from 'vitest/config';

/**
 * Default vitest config for `pnpm test`. Excludes `*.integration.test.ts`
 * files so the default gate is fast and does not require Docker.
 *
 * Integration tests run separately via `pnpm test:integration`, which
 * uses `vitest.integration.config.ts` and requires a running Docker
 * daemon for testcontainers to spin up Postgres.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'node_modules/**', 'dist/**'],
  },
});
