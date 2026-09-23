import { AppRole } from '@cloudpunch/shared';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { TokenVerificationError, verifyEntraToken } from './verify.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const AUDIENCE = CLIENT_ID;
const REQUIRED_SCOPE = 'api.access';
const KID = 'test-key-1';

let privateKey: KeyLike;
let jwks: JWTVerifyGetKey;

interface SignOpts {
  iss?: string;
  aud?: string;
  tid?: string | null;
  oid?: string | null;
  scp?: string;
  roles?: readonly unknown[];
  preferredUsername?: string;
  expOffsetSeconds?: number;
  iatOffsetSeconds?: number;
  extraHeader?: Record<string, unknown>;
}

async function sign(opts: SignOpts = {}): Promise<string> {
  const payload: Record<string, unknown> = {
    aud: opts.aud ?? AUDIENCE,
    scp: opts.scp ?? REQUIRED_SCOPE,
    roles: opts.roles ?? ['Employee'],
  };
  if (opts.tid !== null) payload['tid'] = opts.tid ?? TENANT_ID;
  if (opts.oid !== null) payload['oid'] = opts.oid ?? 'oid-alice';
  if (opts.preferredUsername) payload['preferred_username'] = opts.preferredUsername;

  const now = Math.floor(Date.now() / 1000) + (opts.iatOffsetSeconds ?? 0);
  const exp = now + (opts.expOffsetSeconds ?? 3600);

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: KID, ...(opts.extraHeader ?? {}) })
    .setIssuer(opts.iss ?? ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti('jti-test-1')
    .sign(privateKey);
}

const baseVerifyOpts = () => ({
  jwks,
  issuer: ISSUER,
  audience: AUDIENCE,
  tenantId: TENANT_ID,
  requiredScope: REQUIRED_SCOPE,
  clockToleranceSeconds: 5,
});

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  const pubJwk = await exportJWK(kp.publicKey);
  pubJwk.kid = KID;
  pubJwk.alg = 'RS256';
  pubJwk.use = 'sig';
  jwks = createLocalJWKSet({ keys: [pubJwk] });
});

describe('verifyEntraToken — happy path', () => {
  it('returns full claims for a well-formed token', async () => {
    const token = await sign({
      preferredUsername: 'alice@aptask.com',
      roles: ['Employee', 'Manager'],
    });
    const claims = await verifyEntraToken(token, baseVerifyOpts());
    expect(claims.oid).toBe('oid-alice');
    expect(claims.tid).toBe(TENANT_ID);
    expect(claims.preferredUsername).toBe('alice@aptask.com');
    expect(claims.scope).toEqual([REQUIRED_SCOPE]);
    expect(new Set(claims.roles)).toEqual(new Set([AppRole.Employee, AppRole.Manager]));
    expect(claims.jti).toBe('jti-test-1');
  });

  it('drops unknown role names silently (never trust unregistered roles)', async () => {
    const token = await sign({ roles: ['Employee', 'RogueRole', 42, null, 'Auditor'] });
    const claims = await verifyEntraToken(token, baseVerifyOpts());
    expect(new Set(claims.roles)).toEqual(new Set([AppRole.Employee, AppRole.Auditor]));
  });

  it('accepts a token whose scp lists multiple scopes if the required one is included', async () => {
    const token = await sign({ scp: `${REQUIRED_SCOPE} openid profile` });
    const claims = await verifyEntraToken(token, baseVerifyOpts());
    expect(claims.scope).toEqual([REQUIRED_SCOPE, 'openid', 'profile']);
  });
});

describe('verifyEntraToken — failures', () => {
  it('rejects wrong issuer', async () => {
    const token = await sign({ iss: 'https://evil.example.com/v2.0' });
    await expect(verifyEntraToken(token, baseVerifyOpts())).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });

  it('rejects wrong audience', async () => {
    const token = await sign({ aud: 'other-audience' });
    await expect(verifyEntraToken(token, baseVerifyOpts())).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });

  it('rejects wrong tenant ID (tid mismatch)', async () => {
    const token = await sign({ tid: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz' });
    await expect(verifyEntraToken(token, baseVerifyOpts())).rejects.toMatchObject({
      code: 'invalid_tenant',
    });
  });

  it('rejects a missing tid claim', async () => {
    const token = await sign({ tid: null });
    await expect(verifyEntraToken(token, baseVerifyOpts())).rejects.toMatchObject({
      code: 'invalid_tenant',
    });
  });

  it('rejects a missing required scope', async () => {
    const token = await sign({ scp: 'other.scope' });
    await expect(verifyEntraToken(token, baseVerifyOpts())).rejects.toMatchObject({
      code: 'missing_scope',
    });
  });

  it('rejects a missing oid claim', async () => {
    const token = await sign({ oid: null });
    await expect(verifyEntraToken(token, baseVerifyOpts())).rejects.toMatchObject({
      code: 'missing_oid',
    });
  });

  it('rejects an expired token', async () => {
    const token = await sign({ expOffsetSeconds: -60, iatOffsetSeconds: -3600 });
    await expect(verifyEntraToken(token, baseVerifyOpts())).rejects.toMatchObject({
      code: 'expired',
    });
  });

  it('rejects a syntactically malformed token', async () => {
    await expect(verifyEntraToken('not.a.valid.jwt', baseVerifyOpts())).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });
});
