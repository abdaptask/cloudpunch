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
import { teamNow } from '../team/service.js';
import { shiftRoutes } from './routes.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'k1';
const MIN = 60_000;

let signer: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;

const admin = randomUUID();
const roshni = randomUUID();
const hema = randomUUID();
const oidOf: Record<string, string> = {};
const people: Record<string, Employee> = {};

const ADMIN = [AppRole.Employee, AppRole.Administrator];
const EMP = [AppRole.Employee];
const HR = [AppRole.Employee, AppRole.HR, AppRole.Manager];

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
  for (const [id, name] of [
    [admin, 'Nilesh'],
    [roshni, 'Roshni'],
    [hema, 'Hema'],
  ] as const) {
    const e: Employee = {
      id,
      source: 'local_admin',
      greythrEmployeeId: null,
      employeeNumber: null,
      givenName: name,
      familyName: 'Test',
      displayName: `${name} Test`,
      workEmail: `${name.toLowerCase()}@aptask.com`,
      status: 'active',
      reportingManagerId: null,
    };
    people[id] = e;
    db.seedEmployee(e);
    const oid = randomUUID();
    oidOf[id] = oid;
    db.seedUser(
      {
        id: randomUUID(),
        entraObjectId: oid,
        workEmail: e.workEmail ?? '',
        displayName: e.displayName ?? name,
        isServiceAccount: false,
        breakGlass: false,
        employeeId: id,
      },
      oid,
    );
  }
});

async function call(
  as: string,
  roles: readonly string[],
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
) {
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
  await app.register(shiftRoutes, { db });
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

/** `HH:MM` in UTC, `minutes` from now. */
const at = (minutes: number): string =>
  new Date(Date.now() + minutes * MIN).toISOString().slice(11, 16);
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
/** A shift every day, in UTC, that started an hour ago (or starts later). */
const now = (startIn = -60, endIn = 120) => ({
  days: ALL_DAYS,
  start: at(startIn),
  end: at(endIn),
  tz_iana: 'UTC',
});

/**
 * Roshni's shift, in force since long ago, so a window that began
 * yesterday (a test run just after midnight UTC) still has it.
 */
const seed = (s: { days: number[]; start: string; end: string; tz_iana: string }) =>
  db.shifts.assign({
    employeeId: roshni,
    days: s.days,
    start: s.start,
    end: s.end,
    tzIana: s.tz_iana,
    effectiveFrom: '2026-01-01',
    reason: null,
    assignedByUserId: 'test',
    correlationId: randomUUID(),
    at: new Date(),
  });

describe('assigning shifts (ADR-0031 §1)', () => {
  it('only an Administrator sets one; it is listed and audited', async () => {
    const put = (as: string, roles: readonly string[]) =>
      call(as, roles, 'PUT', `/v1/admin/employees/${roshni}/shift`, {
        days: [1, 2, 3, 4, 5],
        start: '12:00',
        end: '21:00',
        tz_iana: 'Asia/Kolkata',
      });
    expect((await put(hema, HR)).statusCode).toBe(403);
    expect((await put(roshni, EMP)).statusCode).toBe(403);
    const ok = await put(admin, ADMIN);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      shift: { days: [1, 2, 3, 4, 5], start: '12:00', end: '21:00', tz_iana: 'Asia/Kolkata' },
    });
    const list = (await call(admin, ADMIN, 'GET', '/v1/admin/shifts')).json() as {
      people: { employee_id: string; shift: unknown }[];
    };
    expect(list.people.find((p) => p.employee_id === roshni)?.shift).toMatchObject({
      start: '12:00',
    });
    expect(list.people.find((p) => p.employee_id === hema)?.shift).toBeNull();
    expect(db.shiftAudit).toEqual(['shift_assigned']);
  });

  it('refuses a shift with no end, the same start and end, or an unknown zone; empty clears', async () => {
    const put = (body: unknown) =>
      call(admin, ADMIN, 'PUT', `/v1/admin/employees/${roshni}/shift`, body);
    expect((await put({ days: [1], start: '09:00', tz_iana: 'UTC' })).statusCode).toBe(400);
    expect(
      (await put({ days: [1], start: '09:00', end: '09:00', tz_iana: 'UTC' })).statusCode,
    ).toBe(400);
    expect(
      (await put({ days: [1], start: '09:00', end: '17:00', tz_iana: 'Mars/Base' })).statusCode,
    ).toBe(400);
    expect(
      (await put({ days: [8], start: '09:00', end: '17:00', tz_iana: 'UTC' })).statusCode,
    ).toBe(400);
    await put({ days: [1], start: '09:00', end: '17:00', tz_iana: 'UTC' });
    const cleared = await put({ days: [], tz_iana: 'UTC' });
    expect(cleared.json()).toMatchObject({ shift: null });
  });
});

describe('your shift and "Not working today" (ADR-0031 §2)', () => {
  it('shows the window you are in, and records "Not working today" once', async () => {
    await seed(now());
    const before = (await call(roshni, EMP, 'GET', '/v1/me/shift')).json() as {
      shift: unknown;
      window: { date: string } | null;
      not_working: boolean;
    };
    expect(before.shift).toMatchObject({ days: ALL_DAYS, tz_iana: 'UTC' });
    expect(before.window).not.toBeNull();
    expect(before.not_working).toBe(false);

    const said = await call(roshni, EMP, 'POST', '/v1/me/not-working-today');
    expect(said.statusCode).toBe(200);
    expect((said.json() as { date: string }).date).toBe(before.window?.date);
    expect((await call(roshni, EMP, 'POST', '/v1/me/not-working-today')).statusCode).toBe(200);
    expect(db.notWorkingRows).toHaveLength(1);
    expect(
      ((await call(roshni, EMP, 'GET', '/v1/me/shift')).json() as { not_working: boolean })
        .not_working,
    ).toBe(true);
  });

  it('outside a shift there is nothing to say "not working" to', async () => {
    expect((await call(roshni, EMP, 'POST', '/v1/me/not-working-today')).statusCode).toBe(409);
    await seed(now(60, 120));
    const me = (await call(roshni, EMP, 'GET', '/v1/me/shift')).json() as { window: unknown };
    expect(me.window).toBeNull();
    expect((await call(roshni, EMP, 'POST', '/v1/me/not-working-today')).statusCode).toBe(409);
  });
});

describe('Team today knows the shift', () => {
  it('not clocked in since the shift started, or said not working', async () => {
    await seed(now());
    const people0 = [people[roshni] as Employee, people[hema] as Employee];
    const [r, h] = await teamNow(db, people0, new Date());
    expect(r?.status).toBe('shift_not_started');
    expect(r?.since).not.toBeNull();
    expect(h?.status).toBe('clocked_out');

    await call(roshni, EMP, 'POST', '/v1/me/not-working-today');
    const [r2] = await teamNow(db, people0, new Date());
    expect(r2?.status).toBe('not_working');
  });
});
