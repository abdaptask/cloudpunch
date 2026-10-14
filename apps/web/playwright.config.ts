import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the web app (item 9, 2026-10-14). The app is built
 * with `VITE_E2E=1` (a stand-in for Microsoft sign-in, see
 * `src/e2eDeps.ts`) into `dist-e2e` and served by `vite preview`; every
 * `/v1/…` call is answered by the tests (`e2e/api.ts`). Desktop width
 * and a phone (item 6).
 */
const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    { name: 'phone', use: { ...devices['Pixel 5'], viewport: { width: 375, height: 740 } } },
  ],
  webServer: {
    command: `vite build --outDir dist-e2e --emptyOutDir && vite preview --outDir dist-e2e --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/app/`,
    env: { VITE_E2E: '1' },
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
