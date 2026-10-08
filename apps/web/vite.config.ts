import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The web dashboard (ADR-0033), served by the backend from /app/. In
 * development, Vite serves it on :5173 (a redirect URI on the CloudPunch
 * Web registration) and passes the API and brand images to a local
 * backend on :8080.
 */
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/v1': 'http://127.0.0.1:8080',
      '/app/config.json': 'http://127.0.0.1:8080',
      '/brand': 'http://127.0.0.1:8080',
      '/favicon.ico': 'http://127.0.0.1:8080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
