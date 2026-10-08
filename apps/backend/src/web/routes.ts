import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

/**
 * The web dashboard (ADR-0033): the built `apps/web` app at `/app/`,
 * same origin as `/v1`, so the browser needs no CORS. `/app/config.json`
 * hands it the non-secret sign-in settings from the server's env.
 * Paths without a file fall back to `index.html` (the app routes itself).
 */

export interface WebOptions {
  /** The built app; unset or missing: `/app/` says it isn't installed. */
  distDir?: string | undefined;
  tenantId?: string | undefined;
  /** The `CloudPunch Web` SPA registration. */
  webClientId?: string | undefined;
  /** e.g. `api://<api client id>/api.access`. */
  apiScope?: string | undefined;
}

/** The default place: apps/web/dist next to apps/backend. */
export const DEFAULT_DIST = fileURLToPath(new URL('../../../web/dist', import.meta.url));

/** Scripts and styles from the app itself; Microsoft only for sign-in. */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React's style={…} props are inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' https://login.microsoftonline.com",
  // MSAL's silent sign-in loads Microsoft, then our page, in a hidden frame.
  'frame-src https://login.microsoftonline.com',
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

const webRoutesImpl: FastifyPluginAsync<WebOptions> = async (app, opts) => {
  const dist = normalize(opts.distDir ?? DEFAULT_DIST);

  /** A file inside `dist`, or null (missing, a folder, or outside it). */
  async function fileAt(rel: string): Promise<Buffer | null> {
    const path = normalize(join(dist, rel));
    if (path !== dist && !path.startsWith(dist + sep)) return null;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return null;
    return readFile(path);
  }

  const secure = (reply: FastifyReply): FastifyReply =>
    reply
      .header('content-security-policy', WEB_CSP)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer');

  app.get('/app', async (_req, reply) => reply.redirect(301, '/app/'));

  app.get('/app/config.json', async (_req, reply) => {
    if (!opts.tenantId || !opts.webClientId || !opts.apiScope) {
      return reply.code(503).type('application/problem+json').send({
        code: 'web_not_configured',
        message: 'the web dashboard is not set up on this server',
      });
    }
    return secure(reply)
      .header('cache-control', 'no-cache')
      .send({ tenantId: opts.tenantId, clientId: opts.webClientId, apiScope: opts.apiScope });
  });

  app.get('/app/*', async (req, reply) => {
    const rel = (req.params as { '*'?: string })['*'] ?? '';
    const asset = rel !== '' && rel !== 'index.html' ? await fileAt(rel) : null;
    if (asset) {
      // Vite fingerprints everything under assets/.
      const cache = rel.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';
      return secure(reply)
        .type(TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream')
        .header('cache-control', cache)
        .send(asset);
    }
    // A missing file that looks like one is a real 404, not the app.
    if (extname(rel) !== '' && rel !== 'index.html') {
      return reply.code(404).type('text/plain').send('Not found');
    }
    const index = await fileAt('index.html');
    if (!index) {
      return reply
        .code(404)
        .type('text/plain')
        .send('The CloudPunch web dashboard is not installed on this server.');
    }
    return secure(reply)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(index);
  });
};

export const webRoutes = fp(webRoutesImpl, { name: 'cloudpunch-web', fastify: '4.x' });
