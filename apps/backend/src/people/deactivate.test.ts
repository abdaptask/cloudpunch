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
import { peopleRoutes } from './routes.js';

/** ADR-0052: Deactivate a person in one step. */

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'test-key-1';

let signerPrivate: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;
let graph: FakeGraph;
let callerOid: string;

class FakeGraph implements Graph {
  assignments: RoleAssignment[] = [];
  failList: Error | null = null;
  failUnassign: Error | null = null;
  add(oid: string, role: AppRole): void {
    this.assignments.push({ id: randomUUID(), oid, name: oid, role });
  }
  searchUsers = async (): Promise<DirectoryUser[]> => [];
  getUser = async (): Promise<DirectoryUser | null> => null;
  listAssignments = async (): Promise<RoleAssignment[]> => {
    if (this.failList) throw this.failList;
    return [...this.assignments];
  };
  assign = async (oid: string, role: AppRole): Promise<void> => this.add(oid, role);
  unassign = async (id: string): Promise<void> => {
    if (this.failUnassign) throw this.failUnassign;
    this.assignments = this.assignments.filter((a) => a.id !== id);
  };
}

interface Person {
  oid: string;
  userId: string;
  employeeId: string;
}

function seedPerson(name: string, managerId: string | null = null): Person {
  const p = { oid: randomUUID(), userId: randomUUID(), employeeId: randomUUID() };
  db.seedEmployee({
    id: p.employeeId,
    source: 'local_admin',
    greythrEmployeeId: null,
    employeeNumber: null,
    givenName: name,
    familyName: 'Test',
    displayName: `${name} Test`,
    workEmail: `${name.toLowerCase()}@aptask.com`,
    status: 'active',
    reportingManagerId: managerId,
  });
  db.seedUser(
    {
      id: p.userId,
      entraObjectId: p.oid,
      workEmail: `${name.toLowerCase()}@aptask.com`,
      displayName: `${name} Test`,
      isServiceAccount: false,
      breakGlass: false,
      employeeId: p.employeeId,
    },
    p.oid,
  );
  return p;
}

async function seedDevice(owner: Person): Promise<string> {
  const id = randomUUID();
  await db.devices.enroll({
    id,
    userId: owner.userId,
    os: 'windows',
    hostnameHash: 'sha256-' + '0'.repeat(64),
    publicKeyEd25519: new Uint8Array(32).fill(0x11),
    appVersion: '0.1.47',
  });
  return id;
}

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
  graph.add(callerOid, AppRole.Administrator);
});

async function call(
  roles: readonly string[],
  url: string,
  payload: unknown,
  graphFor: ((t: string) => Promise<Graph>) | null = () => Promise.resolve(graph),
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
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });
  await app.close();
  return res;
}

const ADMIN = [AppRole.Administrator];
const HR = [AppRole.HR];
const ONE = '/v1/admin/people/deactivate';
const BULK = '/v1/admin/people/bulk/deactivate';
const rolesOf = (oid: string): AppRole[] =>
  graph.assignments.filter((a) => a.oid === oid).map((a) => a.role);

describe('Deactivate (ADR-0052)', () => {
  it('does all five steps at once and keeps the time history', async () => {
    const manager = seedPerson('Nilesh');
    const report = seedPerson('Roshni', manager.employeeId);
    graph.add(manager.oid, AppRole.Employee);
    graph.add(manager.oid, AppRole.Manager);
    const laptop = await seedDevice(manager);
    const openedAt = new Date(Date.now() - 3 * 3600_000);
    const s = await db.timeSessions.open({
      employeeId: manager.employeeId,
      deviceId: laptop,
      openedAt,
    });

    const res = await call(ADMIN, ONE, {
      oid: manager.oid,
      employee_id: manager.employeeId,
      reason: 'Left ApTask on 7 Nov',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      oid: manager.oid,
      employee_id: manager.employeeId,
      outcome: 'done',
      entra: 'removed',
      closed_at: openedAt.toISOString(),
      devices_signed_out: 1,
      unassigned_reports: [{ id: report.employeeId, name: 'Roshni Test' }],
    });
    // 1. Session closed, machine asked to sign out.
    const closed = await db.timeSessions.findById(s.id);
    expect(closed?.closedReason).toBe('remote_takeover');
    expect((await db.devices.findById(laptop))?.signoutRequestedAt).not.toBeNull();
    // 2. Roles gone from Entra.
    expect(rolesOf(manager.oid)).toEqual([]);
    // 3. Record off, out of Team.
    expect((await db.employees.findById(manager.employeeId))?.status).toBe('inactive');
    expect((await db.employees.listActive()).map((e) => e.id)).not.toContain(manager.employeeId);
    // 4. Reports have no manager.
    expect((await db.employees.findById(report.employeeId))?.reportingManagerId).toBeNull();
    // 5. One audit row for the whole action, nothing else.
    expect(db.deactivateAudit).toHaveLength(1);
    expect(db.deactivateAudit[0]).toMatchObject({
      employeeId: manager.employeeId,
      reason: 'Left ApTask on 7 Nov',
      entra: { outcome: 'removed', roles: [AppRole.Employee, AppRole.Manager] },
      devices: 1,
      unassigned: [report.employeeId],
    });
    expect(db.statusAudit).toHaveLength(0);
    expect(db.managerAudit).toHaveLength(0);
    expect(db.signOutAudit).toHaveLength(0);
    expect(db.roleAudit).toHaveLength(0);
  });

  it('a second time is a no-op with no audit row', async () => {
    const p = seedPerson('Gloria');
    graph.add(p.oid, AppRole.Employee);
    await call(ADMIN, ONE, { oid: p.oid, reason: 'Left ApTask' });
    const again = await call(ADMIN, ONE, { oid: p.oid, reason: 'Left ApTask' });
    expect(again.json()).toMatchObject({ outcome: 'already', entra: 'none' });
    expect(db.deactivateAudit).toHaveLength(1);
  });

  it('needs a reason', async () => {
    const p = seedPerson('Gloria');
    expect((await call(ADMIN, ONE, { oid: p.oid })).statusCode).toBe(400);
    expect((await call(ADMIN, ONE, { oid: p.oid, reason: '  ' })).statusCode).toBe(400);
    expect((await call(ADMIN, ONE, { reason: 'Left' })).statusCode).toBe(400);
  });

  it('keeps going when the Entra account is already deleted', async () => {
    const p = seedPerson('Sohail');
    graph.add(p.oid, AppRole.Employee);
    graph.failUnassign = new GraphError(404, 'Request_ResourceNotFound', 'gone');
    const res = await call(ADMIN, ONE, { employee_id: p.employeeId, oid: p.oid, reason: 'Left' });
    expect(res.json()).toMatchObject({ outcome: 'done', entra: 'gone' });
    expect((await db.employees.findById(p.employeeId))?.status).toBe('inactive');
  });

  it('deactivates a record with no roles left (no Entra link)', async () => {
    const p = seedPerson('Kanchan');
    const res = await call(ADMIN, ONE, { employee_id: p.employeeId, reason: 'Left' });
    expect(res.json()).toMatchObject({ outcome: 'done', entra: 'none' });
    expect((await db.employees.findById(p.employeeId))?.status).toBe('inactive');
  });

  it('Administrator: Entra down still deactivates; roles reported as still there', async () => {
    const p = seedPerson('Benjamin');
    graph.add(p.oid, AppRole.Employee);
    graph.failList = new GraphError(503, 'serviceUnavailable', 'down');
    const res = await call(ADMIN, ONE, { oid: p.oid, reason: 'Left' });
    expect(res.json()).toMatchObject({
      outcome: 'done',
      entra: 'failed',
      entra_code: 'directory_error',
    });
    expect((await db.employees.findById(p.employeeId))?.status).toBe('inactive');
    expect(db.deactivateAudit[0]?.entra).toMatchObject({ outcome: 'failed' });

    // Retry once Entra is back: the roles go, and that is audited.
    graph.failList = null;
    const retry = await call(ADMIN, ONE, { oid: p.oid, reason: 'Left' });
    expect(retry.json()).toMatchObject({ outcome: 'done', entra: 'removed' });
    expect(rolesOf(p.oid)).toEqual([]);
    expect(db.deactivateAudit).toHaveLength(2);
  });

  it('Graph not set up: Administrator goes on, HR is refused', async () => {
    const p = seedPerson('Sweta');
    const admin = await call(ADMIN, ONE, { oid: p.oid, reason: 'Left' }, null);
    expect(admin.json()).toMatchObject({ outcome: 'done', entra: 'failed' });
    const q = seedPerson('Masrat');
    const hr = await call(HR, ONE, { oid: q.oid, reason: 'Left' }, null);
    expect(hr.statusCode).toBe(503);
    expect((await db.employees.findById(q.employeeId))?.status).toBe('active');
  });

  it('HR: Employee/Manager only', async () => {
    const emp = seedPerson('Eela');
    graph.add(emp.oid, AppRole.Employee);
    graph.add(emp.oid, AppRole.Manager);
    expect((await call(HR, ONE, { oid: emp.oid, reason: 'Left' })).statusCode).toBe(200);

    const hrPerson = seedPerson('Priya');
    graph.add(hrPerson.oid, AppRole.HR);
    const refused = await call(HR, ONE, { oid: hrPerson.oid, reason: 'Left' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'not_allowed_for_role' });
    expect(rolesOf(hrPerson.oid)).toEqual([AppRole.HR]);
    expect((await db.employees.findById(hrPerson.employeeId))?.status).toBe('active');

    // An Administrator may.
    expect((await call(ADMIN, ONE, { oid: hrPerson.oid, reason: 'Left' })).statusCode).toBe(200);
  });

  it('never yourself, never the last Administrator', async () => {
    const self = await call(ADMIN, ONE, { oid: callerOid, reason: 'Testing' });
    expect(self.json()).toMatchObject({ code: 'cannot_deactivate_self' });

    // The caller's role is in the token, but Entra lists only the target.
    graph.assignments = [];
    const other = seedPerson('Admin2');
    graph.add(other.oid, AppRole.Administrator);
    const last = await call(ADMIN, ONE, { oid: other.oid, reason: 'Left' });
    expect(last.json()).toMatchObject({ code: 'last_administrator' });
  });

  it('never yourself by record either', async () => {
    const me = seedPerson('Me');
    // The caller's own app_user, linked to a record.
    db.seedUser(
      {
        id: randomUUID(),
        entraObjectId: callerOid,
        workEmail: 'owner@aptask.com',
        displayName: 'Owner',
        isServiceAccount: false,
        breakGlass: false,
        employeeId: me.employeeId,
      },
      callerOid,
    );
    const res = await call(ADMIN, ONE, { employee_id: me.employeeId, reason: 'Testing' });
    expect(res.json()).toMatchObject({ code: 'cannot_deactivate_self' });
    expect((await db.employees.findById(me.employeeId))?.status).toBe('active');
  });

  it('refuses an oid and employee_id that are different people', async () => {
    const a = seedPerson('A');
    const b = seedPerson('B');
    const res = await call(ADMIN, ONE, { oid: a.oid, employee_id: b.employeeId, reason: 'Left' });
    expect(res.statusCode).toBe(400);
    expect((await db.employees.findById(b.employeeId))?.status).toBe('active');
  });

  it('Deactivate selected: each answered, refusals don’t stop the rest, replay by key', async () => {
    const a = seedPerson('Anil');
    const b = seedPerson('Bina');
    const hrPerson = seedPerson('Hari');
    graph.add(a.oid, AppRole.Employee);
    graph.add(b.oid, AppRole.Manager);
    graph.add(hrPerson.oid, AppRole.HR);
    const body = {
      idempotency_key: randomUUID(),
      people: [{ oid: a.oid }, { oid: hrPerson.oid }, { employee_id: b.employeeId, oid: b.oid }],
      reason: 'Project ended',
    };
    const res = await call(HR, BULK, body);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ results: { outcome: string }[] }>().results.map((r) => r.outcome)).toEqual([
      'done',
      'refused',
      'done',
    ]);
    expect(db.deactivateAudit).toHaveLength(2);
    expect(new Set(db.deactivateAudit.map((r) => r.correlationId)).size).toBe(1);

    const again = await call(HR, BULK, body);
    expect(again.json()).toEqual(res.json());
    expect(db.deactivateAudit).toHaveLength(2);

    const reused = await call(HR, BULK, { ...body, reason: 'Something else' });
    expect(reused.statusCode).toBe(409);
  });

  it('Deactivate selected: can’t remove every Administrator in one go', async () => {
    graph.assignments = [];
    graph.add(callerOid, AppRole.Administrator);
    const x = seedPerson('X');
    graph.add(x.oid, AppRole.Administrator);
    const res = await call(ADMIN, BULK, {
      idempotency_key: randomUUID(),
      people: [{ oid: x.oid }, { oid: callerOid }],
      reason: 'Tidy up',
    });
    expect(res.json<{ results: { code?: string }[] }>().results.map((r) => r.code ?? 'ok')).toEqual(
      ['ok', 'cannot_deactivate_self'],
    );
    expect(rolesOf(callerOid)).toEqual([AppRole.Administrator]);
  });
});
