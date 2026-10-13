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
import { shiftOn } from './model.js';
import { shiftHistory } from './resolve.js';
import { officeRoutes } from '../office/routes.js';
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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
  await app.register(officeRoutes, { db });
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

describe('holidays (ADR-0037)', () => {
  it('HR and Administrators keep one list; everyone can read it; removal is a new row', async () => {
    const put = (as: string, roles: readonly string[], date: string, name: unknown) =>
      call(as, roles, 'PUT', `/v1/admin/holidays/${date}`, { name });
    expect((await put(roshni, EMP, '2026-11-09', 'Diwali')).statusCode).toBe(403);
    expect((await put(hema, HR, '2026-11-09', 'Diwali')).statusCode).toBe(200);
    expect((await put(admin, ADMIN, '2026-12-25', 'Christmas')).statusCode).toBe(200);
    expect((await put(admin, ADMIN, '2026-02-30', 'Nope')).statusCode).toBe(400);
    expect((await put(admin, ADMIN, '2026-12-26', '')).statusCode).toBe(400);
    // Renaming is another row; the latest wins.
    await put(admin, ADMIN, '2026-11-09', 'Diwali (Lakshmi Puja)');

    const list = async () =>
      (
        (await call(roshni, EMP, 'GET', '/v1/holidays?from=2026-11-01&to=2026-12-31')).json() as {
          holidays: { date: string; name: string }[];
        }
      ).holidays;
    expect(await list()).toEqual([
      { date: '2026-11-09', name: 'Diwali (Lakshmi Puja)' },
      { date: '2026-12-25', name: 'Christmas' },
    ]);

    expect((await call(roshni, EMP, 'DELETE', '/v1/admin/holidays/2026-12-25')).statusCode).toBe(
      403,
    );
    expect((await call(hema, HR, 'DELETE', '/v1/admin/holidays/2026-12-25')).statusCode).toBe(204);
    expect((await call(hema, HR, 'DELETE', '/v1/admin/holidays/2026-12-25')).statusCode).toBe(404);
    expect(await list()).toEqual([{ date: '2026-11-09', name: 'Diwali (Lakshmi Puja)' }]);
    expect(db.holidayRows).toHaveLength(4);
    expect(db.holidayAudit).toEqual([
      'holiday_added',
      'holiday_added',
      'holiday_added',
      'holiday_removed',
    ]);
    expect(
      (await call(roshni, EMP, 'GET', '/v1/holidays?from=2026-12-31&to=2026-11-01')).statusCode,
    ).toBe(400);
  });

  it('your shift says when today is a holiday and lists the coming ones; Team shows it', async () => {
    await seed(now());
    const window = (
      (await call(roshni, EMP, 'GET', '/v1/me/shift')).json() as { window: { date: string } }
    ).window;
    await call(admin, ADMIN, 'PUT', `/v1/admin/holidays/${window.date}`, { name: 'Diwali' });
    const me = (await call(roshni, EMP, 'GET', '/v1/me/shift')).json() as {
      day_off: unknown;
      holidays: { date: string; name: string }[];
    };
    expect(me.day_off).toEqual({ kind: 'holiday', name: 'Diwali' });
    expect(me.holidays).toContainEqual({ date: window.date, name: 'Diwali' });

    const [r, h] = await teamNow(
      db,
      [people[roshni] as Employee, people[hema] as Employee],
      new Date(),
    );
    expect(r?.status).toBe('holiday');
    expect(r?.holiday).toBe('Diwali');
    // No shift, no holiday status.
    expect(h?.status).toBe('clocked_out');
  });
});

describe('named shifts (ADR-0038 §6)', () => {
  const INDIA = {
    name: 'India day',
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '18:00',
    tz_iana: 'Asia/Kolkata',
  };
  const todayIst = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const plus = (days: number) =>
    new Date(Date.parse(`${todayIst()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  type Listed = {
    id: string;
    name: string;
    start: string;
    people: number;
    retired: boolean;
    next: { start: string; effective_from: string } | null;
  };
  const list = async () =>
    (await call(admin, ADMIN, 'GET', '/v1/admin/shift-templates')).json() as {
      templates: Listed[];
      custom: number;
      none: number;
    };
  const create = async () => {
    const res = await call(admin, ADMIN, 'POST', '/v1/admin/shift-templates', INDIA);
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  };

  it('an Administrator makes one, gives it by name, and it is what the person gets', async () => {
    expect((await call(hema, HR, 'POST', '/v1/admin/shift-templates', INDIA)).statusCode).toBe(403);
    const id = await create();
    const dup = await call(admin, ADMIN, 'POST', '/v1/admin/shift-templates', {
      ...INDIA,
      name: 'india DAY ',
    });
    expect(dup.statusCode).toBe(409);

    const set = await call(admin, ADMIN, 'PUT', `/v1/admin/employees/${roshni}/shift`, {
      template_id: id,
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({
      template_id: id,
      shift: { start: '09:00', tz_iana: 'Asia/Kolkata' },
    });

    const shifts = (await call(admin, ADMIN, 'GET', '/v1/admin/shifts')).json() as {
      people: { employee_id: string; template: { name: string } | null }[];
    };
    expect(shifts.people.find((p) => p.employee_id === roshni)?.template).toEqual({
      id,
      name: 'India day',
    });
    const l = await list();
    expect(l.templates).toMatchObject([{ id, name: 'India day', people: 1, retired: false }]);
    expect(l.none).toBe(2);
  });

  it('editing it moves everyone on it from the chosen date, after a count', async () => {
    const id = await create();
    await call(admin, ADMIN, 'PUT', '/v1/admin/employees/bulk/shift', {
      idempotency_key: randomUUID(),
      employee_ids: [roshni, hema],
      template_id: id,
    });
    const change = { ...INDIA, start: '08:00', end: '17:00', effective_from: plus(7) };
    const dry = await call(admin, ADMIN, 'PUT', `/v1/admin/shift-templates/${id}`, {
      ...change,
      dry_run: true,
    });
    expect(dry.json()).toEqual({ people: 2, effective_from: plus(7) });
    expect((await list()).templates[0]?.next).toBeNull();

    const past = await call(admin, ADMIN, 'PUT', `/v1/admin/shift-templates/${id}`, {
      ...change,
      effective_from: plus(-1),
    });
    expect(past.json()).toMatchObject({ code: 'past_date' });

    const saved = await call(admin, ADMIN, 'PUT', `/v1/admin/shift-templates/${id}`, change);
    expect(saved.json()).toMatchObject({ people: 2, start: '08:00', effective_from: plus(7) });
    const l = await list();
    // Still 09:00 today; 08:00 is coming.
    expect(l.templates[0]).toMatchObject({
      start: '09:00',
      next: { start: '08:00', effective_from: plus(7) },
    });
    // Every reader gets the resolved shift: today's, then the new one.
    const rows = await shiftHistory(db, [roshni]);
    expect(shiftOn(rows, plus(1))?.start).toBe('09:00');
    expect(shiftOn(rows, plus(8))?.start).toBe('08:00');
  });

  it('retired: not offered, but people keep it', async () => {
    const id = await create();
    await call(admin, ADMIN, 'PUT', `/v1/admin/employees/${roshni}/shift`, { template_id: id });
    const r = await call(admin, ADMIN, 'POST', `/v1/admin/shift-templates/${id}/retire`, {});
    expect(r.json()).toEqual({ id, retired: true });
    expect((await list()).templates[0]).toMatchObject({ retired: true, people: 1 });
    expect(shiftOn(await shiftHistory(db, [roshni]), plus(1))?.start).toBe('09:00');
    const again = await call(admin, ADMIN, 'PUT', `/v1/admin/employees/${hema}/shift`, {
      template_id: id,
    });
    expect(again.json()).toMatchObject({ code: 'template_retired' });
  });

  it('bulk shift: all or nothing, once per key, unchanged left as they are', async () => {
    const id = await create();
    await call(admin, ADMIN, 'PUT', `/v1/admin/employees/${roshni}/shift`, { template_id: id });
    const body = {
      idempotency_key: randomUUID(),
      employee_ids: [roshni, hema],
      template_id: id,
      reason: 'new team',
    };
    const res = await call(admin, ADMIN, 'PUT', '/v1/admin/employees/bulk/shift', body);
    expect(res.json()).toEqual({
      template_id: id,
      effective_from: todayIst(),
      changed: [hema],
      unchanged: [roshni],
    });
    const rows = db.shiftRows.length;
    const again = await call(admin, ADMIN, 'PUT', '/v1/admin/employees/bulk/shift', body);
    expect(again.json()).toEqual(res.json());
    expect(db.shiftRows).toHaveLength(rows);

    const missing = await call(admin, ADMIN, 'PUT', '/v1/admin/employees/bulk/shift', {
      ...body,
      idempotency_key: randomUUID(),
      employee_ids: [hema, randomUUID()],
    });
    expect(missing.statusCode).toBe(404);
    expect(db.shiftRows).toHaveLength(rows);

    // A custom pattern for many, from a later date.
    const custom = await call(admin, ADMIN, 'PUT', '/v1/admin/employees/bulk/shift', {
      idempotency_key: randomUUID(),
      employee_ids: [roshni, hema],
      days: [1, 2, 3],
      start: '10:00',
      end: '19:00',
      tz_iana: 'Asia/Kolkata',
      effective_from: plus(3),
    });
    expect(custom.json()).toMatchObject({ template_id: null, changed: [roshni, hema] });
    expect(shiftOn(await shiftHistory(db, [hema]), plus(4))?.start).toBe('10:00');
    expect((await call(hema, HR, 'PUT', '/v1/admin/employees/bulk/shift', body)).statusCode).toBe(
      403,
    );
  });
});

describe('in-office days (ADR-0039)', () => {
  const today = () => new Date().toISOString().slice(0, 10);
  const ALL = [1, 2, 3, 4, 5, 6, 7];

  it('an office day steps back: no popups in the app, In office on Team', async () => {
    await seed(now());
    // Employees can't set it; HR (and Administrators) can.
    const url = `/v1/admin/employees/${roshni}/office-pattern`;
    expect((await call(roshni, EMP, 'PUT', url, { weekdays: ALL })).statusCode).toBe(403);
    const set = await call(hema, HR, 'PUT', url, { weekdays: ALL, reason: 'hybrid' });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ weekdays: ALL, effective_from: today() });

    const mine = (await call(roshni, EMP, 'GET', '/v1/me/shift')).json() as {
      day_off: { kind: string; name: string } | null;
      holidays: { date: string; name: string }[];
    };
    expect(mine.day_off).toEqual({ kind: 'office', name: 'In office' });
    // On the app's own list, so its popups stop, offline too.
    expect(mine.holidays).toContainEqual({ date: today(), name: 'In office' });

    const [r] = await teamNow(db, [people[roshni] as Employee], new Date());
    expect(r).toMatchObject({ status: 'holiday', holiday: 'In office', in_office: true });
    expect(db.officeAudit).toEqual(['office_pattern_set']);
  });

  it('a one-off untick puts the day back to normal', async () => {
    await seed(now());
    await call(hema, HR, 'PUT', `/v1/admin/employees/${roshni}/office-pattern`, { weekdays: ALL });
    const day = `/v1/admin/employees/${roshni}/office-days/${today()}`;
    expect((await call(hema, HR, 'PUT', day, { in_office: false })).json()).toMatchObject({
      in_office: false,
    });
    const mine = (await call(roshni, EMP, 'GET', '/v1/me/shift')).json() as {
      day_off: unknown;
    };
    expect(mine.day_off).toBeNull();
    const [r] = await teamNow(db, [people[roshni] as Employee], new Date());
    expect(r?.status).toBe('shift_not_started');
    // A one-off can't be far in the past.
    const old = `/v1/admin/employees/${roshni}/office-days/2020-01-01`;
    expect((await call(hema, HR, 'PUT', old, { in_office: true })).statusCode).toBe(400);

    const list = (
      await call(hema, HR, 'GET', `/v1/admin/office-days?from=${today()}&to=${today()}`)
    ).json() as { people: { employee_id: string; weekdays: number[]; days: unknown[] }[] };
    expect(list.people.find((p) => p.employee_id === roshni)).toEqual({
      employee_id: roshni,
      weekdays: ALL,
      days: [{ date: today(), in_office: false }],
    });
  });

  it('bulk office weekdays: all or nothing, once per key', async () => {
    const body = {
      idempotency_key: randomUUID(),
      employee_ids: [roshni, hema],
      weekdays: [2, 4],
    };
    const url = '/v1/admin/employees/bulk/office-pattern';
    const res = await call(admin, ADMIN, 'PUT', url, body);
    expect(res.json()).toMatchObject({ weekdays: [2, 4], changed: [roshni, hema], unchanged: [] });
    const again = await call(admin, ADMIN, 'PUT', url, body);
    expect(again.json()).toEqual(res.json());
    expect(db.officePatternRows).toHaveLength(2);
    const missing = await call(admin, ADMIN, 'PUT', url, {
      ...body,
      idempotency_key: randomUUID(),
      employee_ids: [roshni, randomUUID()],
    });
    expect(missing.statusCode).toBe(404);
    expect(db.officePatternRows).toHaveLength(2);
  });
});
