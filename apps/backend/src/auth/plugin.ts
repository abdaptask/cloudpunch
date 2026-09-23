import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import {
  TokenVerificationError,
  verifyEntraToken,
  type TokenClaims,
  type VerifyOptions,
} from './verify.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Verified token claims for the current request. Present only after
     * a successful bearer-token verification in the `onRequest` hook.
     * Guards (see `require.ts`) reject when this is undefined.
     */
    auth?: TokenClaims;
  }
}

export interface AuthPluginOptions extends VerifyOptions {
  /**
   * URL prefixes to skip auth on. Defaults include the health endpoints.
   * Every non-health route is expected to route through `requireCapability`
   * or `requireAuth` explicitly.
   */
  publicRoutes?: readonly string[];
}

const PUBLIC_DEFAULTS: readonly string[] = ['/livez', '/readyz', '/deep-healthz'] as const;

const authPluginImpl: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const publics = new Set(opts.publicRoutes ?? PUBLIC_DEFAULTS);

  app.decorateRequest('auth', undefined);

  app.addHook('onRequest', async (req) => {
    if (publics.has(req.url) || Array.from(publics).some((p) => req.url.startsWith(p))) return;

    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
      // Guards will 401 on missing req.auth; no work to do here.
      return;
    }

    const token = header.slice(7).trim();
    if (token.length === 0) return;

    try {
      req.auth = await verifyEntraToken(token, opts);
    } catch (err) {
      const code = err instanceof TokenVerificationError ? err.code : 'unknown';
      req.log.info({ authFailure: code }, 'auth: token verification failed');
      // Do not throw here — let per-route guards decide (401 vs 403).
    }
  });
};

export const authPlugin = fp(authPluginImpl, {
  name: 'cloudpunch-auth',
  fastify: '4.x',
});

export default authPlugin;
