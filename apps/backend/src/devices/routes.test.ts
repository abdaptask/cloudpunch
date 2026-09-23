import { AppRole } from '@cloudpunch/shared';
import Fastify from 'fastify';
import { randomUUID, webcrypto } from 'node:crypto';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authPlugin } from '../auth/plugin.js';
import { InMemoryDb } from '../db/in-memory.js';
import { devicesRoutes } from './routes.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const REQUIRED_SCOPE = 'api.access';
const KID = 'test-key-1';

let signerPrivate: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;
let userId: string;
let userOid: string;
let employeeId: string;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signerPrivate = kp.privateKey;
  const pubJwk = await exportJWK(kp.publicKey);
  pubJwk.kid = KID;
  pubJwk.alg = 'RS256';
  pubJwk.use = 'sig';
  jwks = createLocalJWKSet({ keys: [pubJwk] });
});

beforeEach(() => {
  db = new InMemoryDb();
  userOid = randomUUID();
  userId = randomUUID();
  employeeId = randomUUID();
  db.seedEmployee({
    id: employeeId,
    source: 'local_admin',
    greythrEmployeeId: null,
    employeeNumber: null,
    givenName: 'Alice',
    familyName: 'Test',
    displayName: null,
    workEmail: 'alice@aptask.com',
    status: 'active',
  });
  db.seedUser(
    {
      id: userId,
      entraObjectId: userOid,
      workEmail: 'alice@aptask.com',
      displayName: 'Alice Test',
      isServiceAccount: false,
      breakGlass: false,
      employeeId,
    },
    userOid,
  );
});

async function signToken(roles: readonly string[], overrides: { oid?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    aud: CLIENT_ID,
    tid: TENANT_ID,
    oid: overrides.oid ?? userOid,
    scp: REQUIRED_SCOPE,
    roles,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signerPrivate);
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
  await app.register(devicesRoutes, { db });
  return app;
}

const pkBase64 = Buffer.from(new Uint8Array(32).fill(0x11)).toString('base64');
const validBody = () => ({
  device_id: randomUUID(),
  os: 'windows' as const,
  hostname_hash: 'sha256-' + '0'.repeat(64),
  public_key_ed25519: pkBase64,
  app_version: '0.1.0',
});

describe('POST /v1/devices/enroll', () => {
  it('returns 401 without auth', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      payload: validBody(),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 200 on happy path', async () => {
    const app = await buildApp();
    const token = await signToken([AppRole.Employee]);
    const body = validBody();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { device_id: string; enrolled_at: string; revoked: boolean };
    expect(json.device_id).toBe(body.device_id);
    expect(json.revoked).toBe(false);
    expect(new Date(json.enrolled_at).toString()).not.toBe('Invalid Date');
    await app.close();
  });

  it('returns 400 for a body missing required fields', async () => {
    const app = await buildApp();
    const token = await signToken([AppRole.Employee]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { device_id: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 for a wrong-shape hostname hash', async () => {
    const app = await buildApp();
    const token = await signToken([AppRole.Employee]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody(), hostname_hash: 'not-a-hash' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when decoded public key is not 32 bytes', async () => {
    const app = await buildApp();
    const token = await signToken([AppRole.Employee]);
    const tooShort = Buffer.from(new Uint8Array(16)).toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody(), public_key_ed25519: tooShort },
    });
    // schema allows 43-44 chars; padded 16 bytes is 24 chars → schema rejects first
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 403 when oid has no CloudPunch user', async () => {
    const app = await buildApp();
    const token = await signToken([AppRole.Employee], { oid: randomUUID() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'no_user_for_oid' });
    await app.close();
  });

  it('returns 409 on re-enrollment by a different user', async () => {
    const app = await buildApp();

    // First enroll as the seeded user
    const body = validBody();
    const t1 = await signToken([AppRole.Employee]);
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      headers: { authorization: `Bearer ${t1}` },
      payload: body,
    });
    expect(r1.statusCode).toBe(200);

    // Second user with a different oid tries the same device_id
    const otherOid = randomUUID();
    db.seedUser(
      {
        id: randomUUID(),
        entraObjectId: otherOid,
        workEmail: 'bob@aptask.com',
        displayName: 'Bob',
        isServiceAccount: false,
        breakGlass: false,
        employeeId: null,
      },
      otherOid,
    );
    const t2 = await signToken([AppRole.Employee], { oid: otherOid });
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      headers: { authorization: `Bearer ${t2}` },
      payload: body,
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toMatchObject({ code: 'device_owner_conflict' });
    await app.close();
  });

  it('re-enrollment by same user succeeds with updated public key', async () => {
    const app = await buildApp();
    const body = validBody();
    const token = await signToken([AppRole.Employee]);

    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(r1.statusCode).toBe(200);

    // Generate a real Ed25519 keypair to prove end-to-end that
    // enrollment accepts a real 32-byte key.
    const kp = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as webcrypto.CryptoKeyPair;
    const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
    const newPk = Buffer.from(raw).toString('base64');

    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...body, public_key_ed25519: newPk, app_version: '0.1.1' },
    });
    expect(r2.statusCode).toBe(200);
    await app.close();
  });
});
