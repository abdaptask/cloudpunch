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
import { policyAdminRoutes } from './admin-routes.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'test-key-1';

let signerPrivate: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;
let adminOid: string;
let adminUserId: string;
let employeeId: string;
let departmentId: string;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signerPrivate = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = KID;
  pub.alg = 'RS256';
  pub.use = 'sig';
  jwks = createLocalJWKSet({ keys: [pub] });
});

beforeEach(() => {
  db = new InMemoryDb();
  adminOid = randomUUID();
  adminUserId = randomUUID();
  employeeId = randomUUID();
  departmentId = randomUUID();
  db.seedDepartment(departmentId);
  db.seedEmployee({
    id: employeeId,
    source: 'local_admin',
    greythrEmployeeId: null,
    employeeNumber: null,
    givenName: 'Bob',
    familyName: 'Test',
    displayName: null,
    workEmail: 'bob@aptask.com',
    status: 'active',
    departmentId,
  });
  db.seedUser(
    {
      id: adminUserId,
      entraObjectId: adminOid,
      workEmail: 'admin@aptask.com',
      displayName: 'Admin',
      isServiceAccount: false,
      breakGlass: false,
      employeeId: null,
    },
    adminOid,
  );
});

async function call(
  roles: readonly string[],
  method: 'GET' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    aud: CLIENT_ID,
    tid: TENANT_ID,
    oid: adminOid,
    scp: 'api.access',
    roles,
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
  await app.register(policyAdminRoutes, { db });
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  await app.close();
  return res;
}

const GLOBAL = '/v1/admin/policy/global';
const dept = () => `/v1/admin/policy/departments/${departmentId}`;
const emp = () => `/v1/admin/policy/employees/${employeeId}`;

describe('policy admin routes', () => {
  it('Administrator sets, reads and clears the global override, with audit rows', async () => {
    const put = await call([AppRole.Administrator], 'PUT', GLOBAL, {
      document: { idle: { threshold_seconds: 600 } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      scope: 'global',
      scope_id: null,
      override: { document: { idle: { threshold_seconds: 600 } }, updated_by_user_id: adminUserId },
    });

    await call([AppRole.Administrator], 'PUT', GLOBAL, {
      document: { idle: { threshold_seconds: 900 } },
    });
    const del = await call([AppRole.Administrator], 'DELETE', GLOBAL);
    expect(del.statusCode).toBe(204);
    expect((await call([AppRole.Administrator], 'GET', GLOBAL)).json()).toMatchObject({
      override: null,
    });

    expect(db.audit.map((a) => a.action)).toEqual(['policy_set', 'policy_set', 'policy_clear']);
    expect(db.audit[1]).toMatchObject({
      actorUserId: adminUserId,
      entityType: 'policy_override',
      entityId: null,
      previousValue: { scope: 'global', document: { idle: { threshold_seconds: 600 } } },
      newValue: { scope: 'global', document: { idle: { threshold_seconds: 900 } } },
    });
    expect(db.audit[2]?.newValue).toBeNull();
    expect(new Set(db.audit.map((a) => a.correlationId)).size).toBe(3);
  });

  it('HR may change department and employee policy but not global', async () => {
    const hr = [AppRole.HR];
    expect(
      (await call(hr, 'PUT', GLOBAL, { document: { idle: { grace_seconds: 60 } } })).statusCode,
    ).toBe(403);
    expect(
      (await call(hr, 'PUT', dept(), { document: { idle: { grace_seconds: 60 } } })).statusCode,
    ).toBe(200);
    expect(
      (
        await call(hr, 'PUT', emp(), {
          document: { break: { bio: { max_minutes: 20 } } },
          reason: 'medical accommodation',
        })
      ).statusCode,
    ).toBe(200);
  });

  it('employees, managers and payroll cannot read or write; auditors read only', async () => {
    for (const role of [AppRole.Employee, AppRole.Manager, AppRole.Payroll]) {
      expect((await call([role], 'GET', GLOBAL)).statusCode).toBe(403);
      expect((await call([role], 'PUT', dept(), { document: {} })).statusCode).toBe(403);
    }
    expect((await call([AppRole.Auditor], 'GET', emp())).statusCode).toBe(200);
    expect((await call([AppRole.Auditor], 'PUT', emp(), { document: {} })).statusCode).toBe(403);
    expect(db.audit).toEqual([]);
  });

  it('a per-employee change needs a reason, including removal', async () => {
    const admin = [AppRole.Administrator];
    const noReason = await call(admin, 'PUT', emp(), { document: { idle: { grace_seconds: 60 } } });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json()).toMatchObject({ code: 'reason_required' });

    await call(admin, 'PUT', emp(), { document: { idle: { grace_seconds: 60 } }, reason: 'r' });
    expect((await call(admin, 'DELETE', emp())).statusCode).toBe(400);
    expect((await call(admin, 'DELETE', emp(), { reason: 'accommodation ended' })).statusCode).toBe(
      204,
    );
    expect(db.audit.at(-1)).toMatchObject({
      action: 'policy_clear',
      reason: 'accommodation ended',
    });
  });

  it('rejects invalid documents with the schema issues, and writes nothing', async () => {
    const res = await call([AppRole.Administrator], 'PUT', GLOBAL, {
      document: { idle: { threshold_seconds: 5, bogus: true } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; issues: string[] };
    expect(body.code).toBe('policy_invalid');
    expect(body.issues.join(' ')).toMatch(/bogus/);
    expect(body.issues.join(' ')).toMatch(/threshold_seconds/);
    expect(db.audit).toEqual([]);
  });

  it('404s unknown departments and employees, and removing nothing', async () => {
    const admin = [AppRole.Administrator];
    const unknownDept = await call(admin, 'PUT', `/v1/admin/policy/departments/${randomUUID()}`, {
      document: {},
    });
    expect(unknownDept.json()).toMatchObject({ code: 'unknown_department' });
    expect(
      (await call(admin, 'GET', `/v1/admin/policy/employees/${randomUUID()}`)).statusCode,
    ).toBe(404);
    expect((await call(admin, 'GET', '/v1/admin/policy/employees/not-a-uuid')).statusCode).toBe(
      400,
    );
    expect((await call(admin, 'DELETE', GLOBAL)).statusCode).toBe(404);
    expect(db.audit).toEqual([]);
  });

  it("shows an employee's effective policy with every layer applied", async () => {
    const admin = [AppRole.Administrator];
    await call(admin, 'PUT', GLOBAL, { document: { idle: { threshold_seconds: 600 } } });
    await call(admin, 'PUT', dept(), { document: { idle: { grace_seconds: 60 } } });
    await call(admin, 'PUT', emp(), {
      document: { idle: { threshold_seconds: 1200 } },
      reason: 'r',
    });
    const res = await call(admin, 'GET', `${emp()}/effective`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { version: string; policy: { idle: Record<string, unknown> } };
    expect(body.policy.idle['threshold_seconds']).toBe(1200);
    expect(body.policy.idle['grace_seconds']).toBe(60);
    expect(body.version).toMatch(/^sha256-/);
  });
});
