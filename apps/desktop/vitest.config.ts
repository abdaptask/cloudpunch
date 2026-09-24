import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vitest config for the desktop React UI. Kept separate from
 * `vite.config.ts` so dev-server knobs (port 1420, envPrefix) don't
 * leak into tests.
 *
 * jsdom stands in for the Tauri webview. Anything that calls
 * `@tauri-apps/api` must be mocked per test — there is no IPC bridge
 * under jsdom.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
