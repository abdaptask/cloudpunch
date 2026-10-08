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
import { peopleRoutes, type PeopleRoutesOptions } from './routes.js';
import type { WelcomeMessage } from './welcome.js';

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
let sent: WelcomeMessage[];
let welcome: NonNullable<PeopleRoutesOptions['welcome']> | null;

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
  sent = [];
  welcome = {
    settings: {
      from: 'noreply@aptask.com',
      cc: ['support@aptask.com', 'abdulla@aptask.com', 'nileshd@aptask.com'],
      siteUrl: 'https://cloudpunch.aptask.com',
      supportEmail: 'support@aptask.com',
    },
    version: () => Promise.resolve('0.1.0'),
    send: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
  };
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
  method: 'GET' | 'PUT' | 'POST',
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
  await app.register(peopleRoutes, { db, graphFor, welcome });
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

  it('giving Manager or HR creates the record too, so they can be in a reporting line', async () => {
    await call(ADMIN, 'PUT', `/v1/admin/people/${FARHEEN.oid}/roles`, { roles: ['Manager'] });
    expect(await db.employees.findByEntraObjectId(FARHEEN.oid)).toMatchObject({
      givenName: 'Farheen',
    });
    const list = await call(ADMIN, 'GET', '/v1/admin/people');
    const { people } = list.res.json<{ people: { oid: string }[] }>();
    expect(people.find((p) => p.oid === FARHEEN.oid)).toMatchObject({
      roles: ['Manager'],
      has_employee_record: true,
    });
  });

  it('a save with no change adds a missing record (Manager given before this rule)', async () => {
    graph.add(FARHEEN.oid, FARHEEN.name, AppRole.Manager);
    expect(await db.employees.findByEntraObjectId(FARHEEN.oid)).toBeNull();
    const { res } = await call(ADMIN, 'PUT', `/v1/admin/people/${FARHEEN.oid}/roles`, {
      roles: ['Manager'],
    });
    expect(res.json()).toMatchObject({ changed: false });
    expect(await db.employees.findByEntraObjectId(FARHEEN.oid)).not.toBeNull();
    expect(db.roleAudit).toHaveLength(0);
  });

  it('Auditor or Administrator alone: no record', async () => {
    await call(ADMIN, 'PUT', `/v1/admin/people/${FARHEEN.oid}/roles`, { roles: ['Auditor'] });
    expect(await db.employees.findByEntraObjectId(FARHEEN.oid)).toBeNull();
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

  it('previews and sends the welcome email from noreply with the Cc list, audited once', async () => {
    const url = `/v1/admin/people/${FARHEEN.oid}/welcome`;
    const preview = await call(ADMIN, 'GET', url);
    expect(preview.res.statusCode).toBe(200);
    expect(preview.res.json()).toMatchObject({
      from: 'noreply@aptask.com',
      to: 'farheen@aptask.com',
      cc: ['support@aptask.com', 'abdulla@aptask.com', 'nileshd@aptask.com'],
      subject: 'Welcome to CloudPunch: how to get started',
    });
    expect(sent).toHaveLength(0);

    const send = await call(HR, 'POST', url, { note: 'Welcome aboard!' });
    expect(send.res.json()).toEqual({
      sent: true,
      to: 'farheen@aptask.com',
      cc: ['support@aptask.com', 'abdulla@aptask.com', 'nileshd@aptask.com'],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.html).toContain('Welcome to CloudPunch, Farheen');
    expect(sent[0]?.html).toContain('Welcome aboard!');
    expect(db.welcomeAudit).toHaveLength(1);
    expect(db.welcomeAudit[0]).toMatchObject({ targetOid: FARHEEN.oid, to: 'farheen@aptask.com' });

    // A double click doesn't send twice.
    const again = await call(ADMIN, 'POST', url, {});
    expect(again.res.statusCode).toBe(429);
    expect(sent).toHaveLength(1);
  });

  it('welcome emails: not set up, send refused, and not for employees', async () => {
    const url = `/v1/admin/people/${FARHEEN.oid}/welcome`;
    expect((await call([AppRole.Employee], 'POST', url, {})).res.statusCode).toBe(403);
    welcome!.send = () => Promise.reject(Object.assign(new Error('denied'), { status: 403 }));
    const refused = await call(ADMIN, 'POST', url, {});
    expect(refused.res.json()).toMatchObject({ code: 'welcome_not_permitted' });
    expect(db.welcomeAudit).toHaveLength(0);
    welcome = null;
    const off = await call(ADMIN, 'GET', url);
    expect(off.res.json()).toMatchObject({ code: 'welcome_not_configured' });
  });
});
