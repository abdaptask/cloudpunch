import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

export interface JwksOptions {
  /**
   * URI of the Entra JWKS endpoint. Example:
   * `https://login.microsoftonline.com/{tenantId}/discovery/v2.0/keys`
   */
  uri: URL;

  /** Full-cache TTL for the JWKS payload. Default 24h. */
  cacheMaxAgeMs?: number;

  /**
   * Minimum time between JWKS fetches when a token references an
   * unknown `kid` (kid-miss). Prevents runaway network on flapping
   * tokens.
   */
  cooldownMs?: number;

  /** Total network timeout for the JWKS fetch. */
  timeoutMs?: number;
}

/**
 * Create a `JWTVerifyGetKey` bound to a remote JWKS endpoint. Handles
 * caching and kid-miss cooldown internally.
 */
export function createEntraJwks(opts: JwksOptions): JWTVerifyGetKey {
  return createRemoteJWKSet(opts.uri, {
    cacheMaxAge: opts.cacheMaxAgeMs ?? 24 * 60 * 60 * 1000,
    cooldownDuration: opts.cooldownMs ?? 30_000,
    timeoutDuration: opts.timeoutMs ?? 5_000,
  });
}
