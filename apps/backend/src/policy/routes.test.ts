import { AppRole } from '@cloudpunch/shared';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
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
import type { PolicyScope } from '../db/index.js';
import { policyRoutes } from './routes.js';
import { policyVersion, schemaDefaults } from './resolve.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'test-key-1';

let signerPrivate: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;
let oid: string;
let userId: string;
let employeeId: string;
const departmentId = randomUUID();

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signerPrivate = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = KID;
  pub.alg = 'RS256';
  pub.use = 'sig';
  jwks = createLocalJWKSet({ keys: [pub] });
});

function seedEmployee(linked: boolean) {
  db = new InMemoryDb();
  oid = randomUUID();
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
    departmentId,
  });
  db.seedUser(
    {
      id: userId,
      entraObjectId: oid,
      workEmail: 'alice@aptask.com',
      displayName: 'Alice Test',
      isServiceAccount: false,
      breakGlass: false,
      employeeId: linked ? employeeId : null,
    },
    oid,
  );
}

beforeEach(() => seedEmployee(true));

function override(scope: PolicyScope, scopeId: string | null, document: Record<string, unknown>) {
  db.seedPolicy({
    scope,
    scopeId,
    document,
    reason: scope === 'employee' ? 'test' : null,
    updatedByUserId: userId,
    updatedAt: new Date(),
  });
}

async function get(headers: Record<string, string> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    aud: CLIENT_ID,
    tid: TENANT_ID,
    oid,
    scp: 'api.access',
    roles: [AppRole.Employee],
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signerPrivate);
  const app = Fastify();
  await app.register(authPlugin, {
    jwks,
    issuer: ISSUER,
    audience: CLIENT_ID,
    tenantId: TENANT_ID,
    requiredScope: 'api.access',
  });
  await app.register(policyRoutes, { db });
  const res = await app.inject({
    method: 'GET',
    url: '/v1/me/policy',
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
  await app.close();
  return res;
}

interface Body {
  version: string;
  policy: { idle: Record<string, unknown>; reminders: Record<string, unknown> };
}

describe('GET /v1/me/policy', () => {
  it('returns the schema defaults when nothing is overridden', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json() as Body;
    expect(body.policy).toEqual(schemaDefaults());
    expect(body.version).toBe(policyVersion(schemaDefaults()));
    expect(res.headers['etag']).toBe(`"${body.version}"`);
  });

  it('layers global, department and employee overrides, most specific wins', async () => {
    override('global', null, { idle: { threshold_seconds: 600, grace_seconds: 60 } });
    override('department', departmentId, { idle: { threshold_seconds: 900 } });
    override('employee', employeeId, {
      idle: { threshold_seconds: 1200 },
      reminders: { on_clock_minutes: 60 },
    });
    // Another department's override never applies.
    override('department', randomUUID(), { idle: { grace_seconds: 300 } });

    const body = (await get()).json() as Body;
    expect(body.policy.idle['threshold_seconds']).toBe(1200);
    expect(body.policy.idle['grace_seconds']).toBe(60);
    expect(body.policy.reminders['on_clock_minutes']).toBe(60);
    expect(body.version).not.toBe(policyVersion(schemaDefaults()));
  });

  it('answers 304 when the caller already has this version', async () => {
    const first = await get();
    const etag = String(first.headers['etag']);
    const again = await get({ 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');

    override('global', null, { idle: { threshold_seconds: 600 } });
    const changed = await get({ 'if-none-match': etag });
    expect(changed.statusCode).toBe(200);
  });

  it('is 404 for an account with no employee record', async () => {
    seedEmployee(false);
    const res = await get();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'no_employee' });
  });

  it('is 500 policy_invalid when a stored override is invalid, never silent defaults', async () => {
    override('employee', employeeId, { idle: { threshold_seconds: 5 } });
    const res = await get();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'policy_invalid' });
  });

  it('requires sign-in', async () => {
    const app = Fastify();
    await app.register(authPlugin, {
      jwks,
      issuer: ISSUER,
      audience: CLIENT_ID,
      tenantId: TENANT_ID,
      requiredScope: 'api.access',
    });
    await app.register(policyRoutes, { db });
    const res = await app.inject({ method: 'GET', url: '/v1/me/policy' });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});
