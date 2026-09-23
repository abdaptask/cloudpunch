import { filterKnownRoles, type AppRole } from '@cloudpunch/shared';
import { jwtVerify, type JWTVerifyGetKey, type JWTVerifyOptions } from 'jose';

export interface TokenClaims {
  /** Entra Object ID — stable per user, never renamed. */
  oid: string;
  /** Tenant ID — verified to equal the configured tenant. */
  tid: string;
  /** Delegated scopes from the `scp` claim, space-split. */
  scope: readonly string[];
  /** App Role assignments from the `roles` claim, filtered to known values. */
  roles: readonly AppRole[];
  /** `preferred_username` if present (usually work email). */
  preferredUsername: string | null;
  /** Expiration time, seconds since epoch. */
  exp: number;
  /** Issued-at time, seconds since epoch. */
  iat: number;
  /** JWT ID for correlation. */
  jti: string | null;
}

export interface VerifyOptions {
  jwks: JWTVerifyGetKey;
  /** Expected issuer, e.g. `https://login.microsoftonline.com/{tid}/v2.0`. */
  issuer: string;
  /** Expected audience (client ID or Application ID URI of the API app). */
  audience: string;
  /** Expected tenant ID (the `tid` claim). */
  tenantId: string;
  /** Required scope in the `scp` claim (e.g. `api.access`). */
  requiredScope: string;
  /** Clock-skew tolerance in seconds. Default 60s. */
  clockToleranceSeconds?: number;
}

export class TokenVerificationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_signature'
      | 'invalid_issuer'
      | 'invalid_audience'
      | 'invalid_tenant'
      | 'expired'
      | 'missing_scope'
      | 'missing_oid'
      | 'malformed'
      | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

/**
 * Verify an Entra ID access token and return its structured claims.
 *
 * Applies, in order:
 *   1. Signature verification against the JWKS (via `jose`).
 *   2. `iss` equals the configured issuer.
 *   3. `aud` matches the configured audience.
 *   4. `tid` equals the configured tenant ID.
 *   5. `exp` not passed (with `clockToleranceSeconds` tolerance).
 *   6. `scp` contains `requiredScope`.
 *   7. `oid` is present (backend never trusts the sub for user identity).
 *   8. `roles` claim is filtered through `filterKnownRoles`; unknown role
 *       strings are silently dropped and never populate `TokenClaims.roles`.
 *
 * Never trust any information from a token that has not passed all
 * checks above.
 */
export async function verifyEntraToken(token: string, opts: VerifyOptions): Promise<TokenClaims> {
  const verifyOpts: JWTVerifyOptions = {
    issuer: opts.issuer,
    audience: opts.audience,
    algorithms: ['RS256'],
    clockTolerance: opts.clockToleranceSeconds ?? 60,
  };

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, opts.jwks, verifyOpts);
    payload = result.payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('exp')) {
      throw new TokenVerificationError('expired', message);
    }
    if (message.includes('iss')) {
      throw new TokenVerificationError('invalid_issuer', message);
    }
    if (message.includes('aud')) {
      throw new TokenVerificationError('invalid_audience', message);
    }
    if (message.includes('signature')) {
      throw new TokenVerificationError('invalid_signature', message);
    }
    throw new TokenVerificationError('unknown', message);
  }

  const tid = typeof payload['tid'] === 'string' ? payload['tid'] : null;
  if (tid !== opts.tenantId) {
    throw new TokenVerificationError(
      'invalid_tenant',
      `expected tenant ${opts.tenantId}, got ${tid ?? '(missing)'}`,
    );
  }

  const scpRaw = typeof payload['scp'] === 'string' ? payload['scp'] : '';
  const scope = scpRaw.split(' ').filter((s) => s.length > 0);
  if (!scope.includes(opts.requiredScope)) {
    throw new TokenVerificationError(
      'missing_scope',
      `token is missing required scope ${opts.requiredScope}`,
    );
  }

  const oid = typeof payload['oid'] === 'string' ? payload['oid'] : null;
  if (!oid) {
    throw new TokenVerificationError('missing_oid', 'token is missing oid claim');
  }

  const rolesRaw = Array.isArray(payload['roles']) ? (payload['roles'] as unknown[]) : [];
  const roles = filterKnownRoles(rolesRaw);

  const preferredUsername =
    typeof payload['preferred_username'] === 'string' ? payload['preferred_username'] : null;

  const jti = typeof payload['jti'] === 'string' ? payload['jti'] : null;
  const exp = typeof payload['exp'] === 'number' ? payload['exp'] : 0;
  const iat = typeof payload['iat'] === 'number' ? payload['iat'] : 0;

  return {
    oid,
    tid,
    scope,
    roles,
    preferredUsername,
    exp,
    iat,
    jti,
  };
}
