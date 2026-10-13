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
import type { DayRow } from './day.js';
import { reportRoutes } from './routes.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'k1';

let signer: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;

const manager = randomUUID();
const report = randomUUID();
const stranger = randomUUID();
const oidOf: Record<string, string> = {};

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signer = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = KID;
  pub.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [pub] });
});

beforeEach(() => {
  db = new InMemoryDb();
  const people: [string, string, string | null][] = [
    [manager, 'Mona', null],
    [report, 'Farheen', manager],
    [stranger, 'Sam', null],
  ];
  for (const [id, name, m] of people) {
    db.seedEmployee({
      id,
      source: 'local_admin',
      greythrEmployeeId: null,
      employeeNumber: null,
      givenName: name,
      familyName: 'Test',
      displayName: `${name} Test`,
      workEmail: `${name.toLowerCase()}@aptask.com`,
      status: 'active',
      reportingManagerId: m,
    });
    const oid = randomUUID();
    oidOf[id] = oid;
    db.seedUser(
      {
        id: randomUUID(),
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
  const app = Fastify();
  await app.register(authPlugin, {
    jwks,
    issuer: ISSUER,
    audience: CLIENT_ID,
    tenantId: TENANT_ID,
    requiredScope: 'api.access',
  });
  await app.register(reportRoutes, { db });
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

const today = new Date().toISOString().slice(0, 10);
const names = (body: unknown) => (body as { people: DayRow[] }).people.map((p) => p.name).sort();

describe('GET /v1/reports/day (ADR-0040 §2, §4)', () => {
  it('a manager sees their reports; HR and Administrators everyone; one audit row each', async () => {
    const mine = await get(
      manager,
      [AppRole.Employee, AppRole.Manager],
      `/v1/reports/day?date=${today}`,
    );
    expect(mine.statusCode).toBe(200);
    expect(names(mine.json())).toEqual(['Farheen Test']);
    expect(mine.json()).toMatchObject({ date: today, counts: { off: 1 } });

    const all = await get(
      stranger,
      [AppRole.Employee, AppRole.HR],
      `/v1/reports/day?date=${today}`,
    );
    expect(names(all.json())).toEqual(['Farheen Test', 'Mona Test', 'Sam Test']);
    const admin = await get(stranger, [AppRole.Administrator], `/v1/reports/day?date=${today}`);
    expect(names(admin.json())).toEqual(['Farheen Test', 'Mona Test', 'Sam Test']);

    expect(db.reportAudit.map((a) => a.detail)).toEqual([
      { date: today, people: '1' },
      { date: today, people: '3' },
      { date: today, people: '3' },
    ]);
  });

  it('an Employee may not; a bad or old date is refused', async () => {
    expect(
      (await get(report, [AppRole.Employee], `/v1/reports/day?date=${today}`)).statusCode,
    ).toBe(403);
    for (const date of ['', '2026-13-01', '2020-01-01']) {
      const res = await get(manager, [AppRole.Manager], `/v1/reports/day?date=${date}`);
      expect(res.statusCode).toBe(400);
    }
    expect(db.reportAudit).toHaveLength(0);
  });
});

describe('GET /v1/reports/overview (ADR-0040 §3, §4)', () => {
  const week = `from=${new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)}&to=${today}`;

  it('HR and Administrators only; the four parts; one audit row', async () => {
    expect((await get(manager, [AppRole.Manager], `/v1/reports/overview?${week}`)).statusCode).toBe(
      403,
    );
    const res = await get(stranger, [AppRole.Administrator], `/v1/reports/overview?${week}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['from', 'health', 'people', 'to', 'totals', 'weeks']);
    expect((body['people'] as unknown[]).length).toBe(3);
    expect(db.reportAudit.map((a) => a.report)).toEqual(['overview']);
    const bad = await get(
      stranger,
      [AppRole.HR],
      '/v1/reports/overview?from=2026-01-01&to=2026-12-31',
    );
    expect(bad.statusCode).toBe(400);
  });

  it('CSV for one section, as a download', async () => {
    const res = await get(
      stranger,
      [AppRole.HR],
      `/v1/reports/overview.csv?${week}&section=lateness`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="cloudpunch-lateness-/,
    );
    expect(res.body.split('\r\n')[0]).toBe('Person,Late starts,Average minutes late,Missed starts');
    const bad = await get(stranger, [AppRole.HR], `/v1/reports/overview.csv?${week}&section=x`);
    expect(bad.statusCode).toBe(400);
  });
});
