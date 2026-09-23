import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for the CloudPunch desktop UI. Port 1420 is Tauri's
 * conventional dev port; `strictPort` fails fast if it's taken so we
 * never accidentally attach the Tauri window to some other server.
 *
 * `envPrefix` allows both VITE_* env vars (for build-time knobs) and
 * TAURI_ENV_* (for platform-specific rules the tauri CLI injects at
 * dev/build time).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome108',
    sourcemap: true,
    minify: 'esbuild',
  },
});
