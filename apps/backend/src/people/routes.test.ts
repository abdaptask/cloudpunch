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
import { GraphError, type DirectoryUser, type Graph, type RoleAssignment } from './graph.js';
import { OboError } from './obo.js';
import { peopleRoutes } from './routes.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'test-key-1';

let signerPrivate: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;
let callerOid: string;

const FARHEEN: DirectoryUser = {
  oid: '8afe98ae-5b43-4c12-86c5-b4473225f7f0',
  name: 'Farheen Khanam',
  email: 'farheen@aptask.com',
  givenName: 'Farheen',
  surname: 'Khanam',
};

/** An in-memory directory standing in for Microsoft Graph. */
class FakeGraph implements Graph {
  users = new Map<string, DirectoryUser>([[FARHEEN.oid, FARHEEN]]);
  assignments: RoleAssignment[] = [];
  /** Tokens it was built from (the caller's, for OBO). */
  tokens: string[] = [];
  fail: Error | null = null;

  add(oid: string, name: string, role: AppRole): void {
    this.assignments.push({ id: randomUUID(), oid, name, role });
  }
  searchUsers = async (q: string): Promise<DirectoryUser[]> =>
    [...this.users.values()].filter((u) => u.name.toLowerCase().includes(q.toLowerCase()));
  getUser = async (oid: string): Promise<DirectoryUser | null> => this.users.get(oid) ?? null;
  listAssignments = async (): Promise<RoleAssignment[]> => {
    if (this.fail) throw this.fail;
    return [...this.assignments];
  };
  assign = async (oid: string, role: AppRole): Promise<void> => {
    this.add(oid, this.users.get(oid)?.name ?? oid, role);
  };
  unassign = async (id: string): Promise<void> => {
    this.assignments = this.assignments.filter((a) => a.id !== id);
  };
}

let graph: FakeGraph;

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
  graph = new FakeGraph();
  callerOid = randomUUID();
  db.seedUser(
    {
      id: randomUUID(),
      entraObjectId: callerOid,
      workEmail: 'owner@aptask.com',
      displayName: 'Owner',
      isServiceAccount: false,
      breakGlass: false,
      employeeId: null,
    },
    callerOid,
  );
  graph.add(callerOid, 'Owner', AppRole.Administrator);
});

async function call(
  roles: readonly string[],
  method: 'GET' | 'PUT',
  url: string,
  payload?: unknown,
  graphFor: ((t: string) => Promise<Graph>) | null = (t) => {
    graph.tokens.push(t);
    return Promise.resolve(graph);
  },
) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    aud: CLIENT_ID,
    tid: TENANT_ID,
    oid: callerOid,
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
  await app.register(peopleRoutes, { db, graphFor });
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  await app.close();
  return { res, token };
}

const ADMIN = [AppRole.Administrator];
const HR = [AppRole.HR];
const roles = (oid: string): AppRole[] =>
  graph.assignments.filter((a) => a.oid === oid).map((a) => a.role);

describe('People (ADR-0020)', () => {
  it('lists people with their roles, using the caller’s own token for Graph', async () => {
    graph.add(FARHEEN.oid, FARHEEN.name, AppRole.Employee);
    const { res, token } = await call(ADMIN, 'GET', '/v1/admin/people');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      people: [
        {
          oid: FARHEEN.oid,
          name: 'Farheen Khanam',
          roles: ['Employee'],
          has_employee_record: false,
        },
        { oid: callerOid, name: 'Owner', roles: ['Administrator'], has_employee_record: false },
      ],
    });
    expect(graph.tokens).toEqual([token]);
  });

  it('searches the directory', async () => {
    const { res } = await call(HR, 'GET', '/v1/admin/people/search?q=farh');
    expect(res.json()).toEqual({ users: [FARHEEN] });
    expect((await call(HR, 'GET', '/v1/admin/people/search?q=f')).res.statusCode).toBe(400);
  });

  it('giving Employee creates the employee record from the directory, and is audited', async () => {
    const { res } = await call(ADMIN, 'PUT', `/v1/admin/people/${FARHEEN.oid}/roles`, {
      roles: ['Employee'],
      reason: 'pilot',
    });
    expect(res.json()).toEqual({ oid: FARHEEN.oid, roles: ['Employee'], changed: true });
    expect(roles(FARHEEN.oid)).toEqual(['Employee']);
    const employee = await db.employees.findByEntraObjectId(FARHEEN.oid);
    expect(employee).toMatchObject({ givenName: 'Farheen', familyName: 'Khanam' });
    expect(db.roleAudit).toHaveLength(1);
    expect(db.roleAudit[0]).toMatchObject({
      targetOid: FARHEEN.oid,
      previousRoles: [],
      newRoles: ['Employee'],
      reason: 'pilot',
    });
    // Same roles again: nothing changes, nothing audited.
    const again = await call(ADMIN, 'PUT', `/v1/admin/people/${FARHEEN.oid}/roles`, {
      roles: ['Employee'],
    });
    expect(again.res.json()).toMatchObject({ changed: false });
    expect(db.roleAudit).toHaveLength(1);
  });

  it('an Administrator can add and remove any role', async () => {
    graph.add(FARHEEN.oid, FARHEEN.name, AppRole.Employee);
    await call(ADMIN, 'PUT', `/v1/admin/people/${FARHEEN.oid}/roles`, {
      roles: ['Employee', 'Administrator', 'HR'],
    });
    expect(roles(FARHEEN.oid).sort()).toEqual(['Administrator', 'Employee', 'HR']);
    await call(ADMIN, 'PUT', `/v1/admin/people/${FARHEEN.oid}/roles`, { roles: ['Employee'] });
    expect(roles(FARHEEN.oid)).toEqual(['Employee']);
  });

  it('HR may give Employee and Manager only', async () => {
    const ok = await call(HR, 'PUT', `/v1/admin/people/${FARHEEN.oid}/roles`, {
      roles: ['Employee', 'Manager'],
    });
    expect(ok.res.statusCode).toBe(200);
    const no = await call(HR, 'PUT', `/v1/admin/people/${FARHEEN.oid}/roles`, {
      roles: ['Employee', 'Manager', 'Administrator'],
    });
    expect(no.res.statusCode).toBe(403);
    expect(no.res.json()).toMatchObject({ code: 'not_allowed_for_role' });
    expect(roles(FARHEEN.oid).sort()).toEqual(['Employee', 'Manager']);
  });

  it('no removing your own Administrator role, or the last Administrator', async () => {
    const own = await call(ADMIN, 'PUT', `/v1/admin/people/${callerOid}/roles`, { roles: [] });
    expect(own.res.json()).toMatchObject({ code: 'cannot_remove_own_admin' });
    // Someone else is the only other admin; removing the caller's co-admin is fine,
    // but not when they'd be the last one.
    graph.assignments = [];
    graph.add(FARHEEN.oid, FARHEEN.name, AppRole.Administrator);
    const last = await call(ADMIN, 'PUT', `/v1/admin/people/${FARHEEN.oid}/roles`, { roles: [] });
    expect(last.res.json()).toMatchObject({ code: 'last_administrator' });
  });

  it('employees, managers and payroll cannot use People', async () => {
    for (const r of [AppRole.Employee, AppRole.Manager, AppRole.Payroll, AppRole.Auditor]) {
      expect((await call([r], 'GET', '/v1/admin/people')).res.statusCode).toBe(403);
    }
  });

  it('rejects bad input', async () => {
    const bad = [
      [`/v1/admin/people/not-a-uuid/roles`, { roles: ['Employee'] }],
      [`/v1/admin/people/${FARHEEN.oid}/roles`, { roles: ['Owner'] }],
      [`/v1/admin/people/${FARHEEN.oid}/roles`, { roles: 'Employee' }],
    ] as const;
    for (const [url, body] of bad) {
      expect((await call(ADMIN, 'PUT', url, body)).res.statusCode).toBe(400);
    }
  });

  it('explains setup and directory problems', async () => {
    const off = await call(ADMIN, 'GET', '/v1/admin/people', undefined, null);
    expect(off.res.json()).toMatchObject({ code: 'people_not_configured' });
    const consent = await call(ADMIN, 'GET', '/v1/admin/people', undefined, () =>
      Promise.reject(new OboError('consent_required', 'x')),
    );
    expect(consent.res.json()).toMatchObject({ code: 'consent_required' });
    graph.fail = new GraphError(403, 'Authorization_RequestDenied', 'no');
    const denied = await call(ADMIN, 'GET', '/v1/admin/people');
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.json()).toMatchObject({ code: 'directory_forbidden' });
  });
});
