import { defineConfig } from 'vitest/config';

/**
 * Integration test config for `pnpm test:integration`. Runs only
 * `*.integration.test.ts` files. Requires Docker to be running so
 * testcontainers can spin up Postgres.
 *
 * Longer timeouts to accommodate container pull + boot.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
