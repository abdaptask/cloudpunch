import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { desktopScreens } from './desktopScreens.js';

/** Vitest for the web dashboard; MSAL and fetch are mocked per test. */
export default defineConfig({
  plugins: [desktopScreens(), react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
