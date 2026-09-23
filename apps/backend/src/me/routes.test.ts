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
import { meRoutes } from './routes.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const REQUIRED_SCOPE = 'api.access';
const KID = 'test-key-1';

let signerPrivate: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;
let userOid: string;
let userId: string;
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
  await app.register(meRoutes, { db });
  return app;
}

function seedActiveEmployee() {
  db.seedEmployee({
    id: employeeId,
    source: 'local_admin',
    greythrEmployeeId: null,
    employeeNumber: 'E123',
    givenName: 'Alice',
    familyName: 'Test',
    displayName: 'Alice T.',
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
}

describe('GET /v1/me', () => {
  it('returns 401 without auth', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 403 when oid has no CloudPunch user', async () => {
    const app = await buildApp();
    const token = await signToken([AppRole.Employee]);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'no_user_for_oid' });
    await app.close();
  });

  it('returns full profile for an active employee', async () => {
    seedActiveEmployee();
    const app = await buildApp();
    const token = await signToken([AppRole.Employee, AppRole.Manager]);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      user: { id: string; entra_object_id: string };
      employee: { id: string; status: string; work_email: string; display_name: string };
      roles: string[];
      capabilities: string[];
      clock_allowed: boolean;
    };
    expect(body.user.id).toBe(userId);
    expect(body.employee.id).toBe(employeeId);
    expect(body.employee.display_name).toBe('Alice T.');
    expect(body.employee.status).toBe('active');
    expect(body.clock_allowed).toBe(true);
    expect(new Set(body.roles)).toEqual(new Set(['Employee', 'Manager']));
    expect(body.capabilities).toContain('self.clock.write');
    expect(body.capabilities).toContain('team.timesheet.approve');
    await app.close();
  });

  it('returns clock_allowed=false when employee is on_leave', async () => {
    db.seedEmployee({
      id: employeeId,
      source: 'local_admin',
      greythrEmployeeId: null,
      employeeNumber: null,
      givenName: 'Alice',
      familyName: 'Test',
      displayName: null,
      workEmail: 'alice@aptask.com',
      status: 'on_leave',
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
    const app = await buildApp();
    const token = await signToken([AppRole.Employee]);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { clock_allowed: boolean; employee: { status: string } };
    expect(body.clock_allowed).toBe(false);
    expect(body.employee.status).toBe('on_leave');
    await app.close();
  });

  it('returns null employee for a break-glass user', async () => {
    db.seedUser(
      {
        id: userId,
        entraObjectId: userOid,
        workEmail: 'breakglass@aptask.com',
        displayName: 'Break-Glass',
        isServiceAccount: false,
        breakGlass: true,
        employeeId: null,
      },
      userOid,
    );
    const app = await buildApp();
    const token = await signToken([AppRole.Administrator]);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      employee: unknown;
      clock_allowed: boolean;
      user: { break_glass: boolean };
    };
    expect(body.employee).toBeNull();
    expect(body.clock_allowed).toBe(false);
    expect(body.user.break_glass).toBe(true);
    await app.close();
  });
});
