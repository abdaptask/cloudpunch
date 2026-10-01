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
import type { Employee } from '../db/index.js';
import { connectionRoutes, type ConnectionView } from './routes.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'k1';
const DAY = 86_400_000;

let signer: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;
let clock: Date;
let app: Awaited<ReturnType<typeof build>> | null;

// A manager with one report, someone else, HR, an Administrator.
const manager = randomUUID();
const report = randomUUID();
const stranger = randomUUID();
const hr = randomUUID();
const admin = randomUUID();
const oidOf: Record<string, string> = {};
const userOf: Record<string, string> = {};

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signer = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = KID;
  pub.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [pub] });
});

function person(id: string, name: string, managerId: string | null): Employee {
  return {
    id,
    source: 'local_admin',
    greythrEmployeeId: null,
    employeeNumber: null,
    givenName: name,
    familyName: 'Test',
    displayName: `${name} Test`,
    workEmail: `${name.toLowerCase()}@aptask.com`,
    status: 'active',
    reportingManagerId: managerId,
  };
}

async function seedConnection(employeeId: string, ip: string, daysAgo: number, city = 'Pune') {
  const at = new Date(clock.getTime() - daysAgo * DAY);
  await db.connections.insert({
    employeeId,
    deviceId: randomUUID(),
    ip,
    city,
    region: 'Maharashtra',
    country: 'IN',
    asn: 134674,
    provider: 'Tata Play Broadband Private Limited',
    firstSeenAt: at,
    lastSeenAt: at,
  });
}

beforeEach(() => {
  db = new InMemoryDb();
  app = null;
  clock = new Date('2026-10-01T09:00:00Z');
  const people: [string, string, string | null][] = [
    [manager, 'Mona', null],
    [report, 'Farheen', manager],
    [stranger, 'Sam', null],
    [hr, 'Hema', null],
    [admin, 'Abdulla', null],
  ];
  for (const [id, name, m] of people) {
    db.seedEmployee(person(id, name, m));
    const oid = randomUUID();
    const userId = randomUUID();
    oidOf[id] = oid;
    userOf[id] = userId;
    db.seedUser(
      {
        id: userId,
        entraObjectId: oid,
        workEmail: `${name.toLowerCase()}@aptask.com`,
        displayName: `${name} Test`,
        isServiceAccount: false,
        breakGlass: false,
        employeeId: id,
      },
      oid,
    );
  }
});

async function build() {
  const a = Fastify();
  await a.register(authPlugin, {
    jwks,
    issuer: ISSUER,
    audience: CLIENT_ID,
    tenantId: TENANT_ID,
    requiredScope: 'api.access',
  });
  await a.register(connectionRoutes, { db, now: () => clock });
  return a;
}

async function get(as: string, roles: readonly string[], url: string) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    aud: CLIENT_ID,
    tid: TENANT_ID,
    oid: oidOf[as],
    scp: 'api.access',
    roles,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signer);
  app ??= await build();
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

const MANAGER = [AppRole.Employee, AppRole.Manager];

describe('GET /v1/me/connections', () => {
  it('shows your own last 30 days, newest first, with the DB-IP credit', async () => {
    await seedConnection(report, '58.84.61.202', 2);
    await seedConnection(report, '202.71.156.179', 0);
    await seedConnection(report, '1.2.3.4', 31); // past the 30 days
    await seedConnection(stranger, '9.9.9.9', 0);
    const res = await get(report, [AppRole.Employee], '/v1/me/connections');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      recording: boolean;
      attribution: string;
      connections: ConnectionView[];
    };
    expect(body.recording).toBe(false);
    expect(body.attribution).toBe('IP data by DB-IP');
    expect(body.connections.map((c) => c.ip)).toEqual(['202.71.156.179', '58.84.61.202']);
    expect(body.connections[0]).toMatchObject({
      city: 'Pune',
      provider: 'Tata Play Broadband Private Limited',
    });
    expect(db.viewAudit).toHaveLength(0); // your own isn't audited
  });
});

describe('GET /v1/team/:employeeId/connections', () => {
  it("lets a Manager see a direct report's history, audited", async () => {
    await seedConnection(report, '58.84.61.202', 1);
    const res = await get(manager, MANAGER, `/v1/team/${report}/connections`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe('Farheen Test');
    expect(db.viewAudit).toEqual([
      expect.objectContaining({
        actorUserId: userOf[manager],
        employeeId: report,
        action: 'connections_viewed',
        detail: { view: 'history' },
      }),
    ]);
  });

  it("gives a Manager 404 for someone who isn't their report", async () => {
    const res = await get(manager, MANAGER, `/v1/team/${stranger}/connections`);
    expect(res.statusCode).toBe(404);
    expect(db.viewAudit).toHaveLength(0);
  });

  it('lets an Administrator see anyone', async () => {
    const res = await get(admin, [AppRole.Administrator], `/v1/team/${stranger}/connections`);
    expect(res.statusCode).toBe(200);
  });

  it("refuses HR and Auditors, even with HR's org-wide team view", async () => {
    for (const roles of [[AppRole.HR], [AppRole.Auditor], [AppRole.Employee]]) {
      const res = await get(hr, roles, `/v1/team/${report}/connections`);
      expect(res.statusCode).toBe(403);
    }
  });

  it('a Manager who is also HR still sees only direct reports', async () => {
    const res = await get(manager, [...MANAGER, AppRole.HR], `/v1/team/${stranger}/connections`);
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/team/connections', () => {
  it("gives each in-scope person's latest connection", async () => {
    await seedConnection(report, '58.84.61.202', 3, 'Pune');
    await seedConnection(report, '202.71.156.179', 0, 'Mumbai');
    await seedConnection(stranger, '9.9.9.9', 0);
    const res = await get(manager, MANAGER, '/v1/team/connections');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { people: (ConnectionView & { employee_id: string })[] };
    expect(body.people).toEqual([
      expect.objectContaining({ employee_id: report, city: 'Mumbai', ip: '202.71.156.179' }),
    ]);
  });

  it('audits each person at most once an hour per viewer', async () => {
    await seedConnection(report, '58.84.61.202', 0);
    await get(manager, MANAGER, '/v1/team/connections');
    clock = new Date(clock.getTime() + 59 * 60_000);
    await get(manager, MANAGER, '/v1/team/connections');
    expect(db.viewAudit).toHaveLength(1);
    clock = new Date(clock.getTime() + 60_000);
    await get(manager, MANAGER, '/v1/team/connections');
    expect(db.viewAudit).toEqual([
      expect.objectContaining({ employeeId: report, detail: { view: 'team_list' } }),
      expect.objectContaining({ employeeId: report, detail: { view: 'team_list' } }),
    ]);
  });

  it('refuses HR', async () => {
    const res = await get(hr, [AppRole.HR], '/v1/team/connections');
    expect(res.statusCode).toBe(403);
  });
});
