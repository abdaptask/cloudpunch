import { AppRole, Capability } from '@cloudpunch/shared';
import Fastify from 'fastify';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { authPlugin } from './plugin.js';
import { requireAuth, requireCapability } from './require.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const REQUIRED_SCOPE = 'api.access';
const KID = 'test-key-1';

let privateKey: KeyLike;
let jwks: JWTVerifyGetKey;

async function sign(roles: readonly string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    aud: CLIENT_ID,
    tid: TENANT_ID,
    oid: 'oid-alice',
    scp: REQUIRED_SCOPE,
    roles,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

async function buildApp() {
  const app = Fastify();
  await app.register(authPlugin, {
    jwks,
    issuer: ISSUER,
    audience: CLIENT_ID,
    tenantId: TENANT_ID,
    requiredScope: REQUIRED_SCOPE,
  });
  app.get('/livez', async () => ({ status: 'ok' }));
  app.get('/me', { preHandler: [requireAuth] }, async (req) => ({ oid: req.auth?.oid }));
  app.get(
    '/team/approve',
    { preHandler: [requireCapability(Capability.TeamTimesheetApprove)] },
    async () => ({ ok: true }),
  );
  app.get(
    '/self/clock',
    { preHandler: [requireCapability(Capability.SelfClockWrite)] },
    async () => ({ ok: true }),
  );
  return app;
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  const pubJwk = await exportJWK(kp.publicKey);
  pubJwk.kid = KID;
  pubJwk.alg = 'RS256';
  pubJwk.use = 'sig';
  jwks = createLocalJWKSet({ keys: [pubJwk] });
});

describe('auth plugin + requireCapability', () => {
  it('lets /livez through without auth', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/livez' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 401 on /me when no Authorization header present', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'unauthorized' });
    await app.close();
  });

  it('returns 401 on /me when token is malformed', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer notatoken' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 200 on /me with a valid Employee token', async () => {
    const app = await buildApp();
    const token = await sign([AppRole.Employee]);
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ oid: 'oid-alice' });
    await app.close();
  });

  it('returns 403 when Employee tries a Manager-only route', async () => {
    const app = await buildApp();
    const token = await sign([AppRole.Employee]);
    const res = await app.inject({
      method: 'GET',
      url: '/team/approve',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
    await app.close();
  });

  it('returns 200 when Manager hits the Manager route', async () => {
    const app = await buildApp();
    const token = await sign([AppRole.Manager]);
    const res = await app.inject({
      method: 'GET',
      url: '/team/approve',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 200 when Employee hits a self route', async () => {
    const app = await buildApp();
    const token = await sign([AppRole.Employee]);
    const res = await app.inject({
      method: 'GET',
      url: '/self/clock',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('never trusts unknown role names — a token with only "RogueRole" is treated as no roles', async () => {
    const app = await buildApp();
    const token = await sign(['RogueRole']);
    const res = await app.inject({
      method: 'GET',
      url: '/self/clock',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
