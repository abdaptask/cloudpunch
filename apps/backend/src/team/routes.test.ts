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
import { teamRoutes } from './routes.js';
import type { PersonNow, TeamException } from './service.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'k1';
const MIN = 60_000;

let signer: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;

// People: a manager, two direct reports, someone else's report, HR.
const manager = randomUUID();
const report = randomUUID();
const report2 = randomUUID();
const stranger = randomUUID();
const hr = randomUUID();
const oidOf: Record<string, string> = {};

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signer = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = KID;
  pub.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [pub] });
});

function person(id: string, name: string, managerId: string | null = null): Employee {
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

beforeEach(() => {
  db = new InMemoryDb();
  const people: [string, string, string | null][] = [
    [manager, 'Mona', null],
    [report, 'Farheen', manager],
    [report2, 'Roshni', manager],
    [stranger, 'Sam', null],
    [hr, 'Hema', null],
  ];
  for (const [id, name, m] of people) {
    db.seedEmployee(person(id, name, m));
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

async function call(
  as: string,
  roles: readonly string[],
  method: 'GET' | 'PUT',
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
  await app.register(teamRoutes, { db });
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

/** An open session for `emp` from `minutesAgo`, with these events after the clock-in. */
async function seedOpen(
  emp: string,
  minutesAgo: number,
  after: [string, number, Record<string, unknown>][] = [],
  close?: { minutesAgo: number; reason: 'user_clock_out' | 'idle_cap' },
): Promise<void> {
  // One clock for every event, so lengths are exact.
  const t0 = Date.now();
  const from = new Date(t0 - minutesAgo * MIN);
  const session = await db.timeSessions.open({
    employeeId: emp,
    deviceId: randomUUID(),
    openedAt: from,
  });
  const base = {
    sessionId: session.id,
    employeeId: emp,
    monotonicNs: 0,
    // UTC, so the working day's date is the UTC date whatever the hour.
    tzIana: 'UTC',
    utcOffsetMinutes: 0,
    deviceId: session.deviceId,
    appVersion: '0.1.4',
    origin: 'user' as const,
    offlineCaptured: false,
    integritySignature: new Uint8Array(64),
    correlationId: randomUUID(),
    parentEventUlid: null,
  };
  const events: [string, Date, Record<string, unknown>][] = [
    ['USER_CLOCK_IN', from, {}],
    ...after.map(([t, ago, p]): [string, Date, Record<string, unknown>] => [
      t,
      new Date(t0 - ago * MIN),
      p,
    ]),
  ];
  if (close) events.push(['USER_CLOCK_OUT', new Date(t0 - close.minutesAgo * MIN), {}]);
  for (const [i, [eventType, clientTs, payload]] of events.entries()) {
    await db.timeEvents.insertOne({
      ...base,
      eventUlid: randomUUID(),
      eventType,
      sequenceNumber: i + 1,
      clientTs,
      payload,
    });
  }
  if (close) {
    await db.timeSessions.close(session.id, new Date(t0 - close.minutesAgo * MIN), close.reason);
  }
}

const today = (): string => new Date().toISOString().slice(0, 10);
/** The UTC date `minutesAgo` minutes ago: a session's working day. */
const dateOf = (minutesAgo: number): string =>
  new Date(Date.now() - minutesAgo * MIN).toISOString().slice(0, 10);
const yesterday = (): string => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const MANAGER = [AppRole.Employee, AppRole.Manager];
const HR = [AppRole.Employee, AppRole.HR];

describe('scope (ADR-0025 §2, invariant 5)', () => {
  it('a manager sees only direct reports; HR sees everyone; others see no one', async () => {
    const mine = await call(manager, MANAGER, 'GET', '/v1/team');
    expect(mine.statusCode).toBe(200);
    const names = (mine.json() as { people: PersonNow[] }).people.map((p) => p.name);
    expect(names).toEqual(['Farheen Test', 'Roshni Test']);

    const all = await call(hr, HR, 'GET', '/v1/team');
    expect((all.json() as { people: PersonNow[] }).people).toHaveLength(5);

    expect((await call(report, [AppRole.Employee], 'GET', '/v1/team')).statusCode).toBe(403);
    expect((await call(manager, [AppRole.Administrator], 'GET', '/v1/team')).statusCode).toBe(403);
  });

  it("someone outside the manager's team is 404, and nothing is audited", async () => {
    for (const id of [stranger, hr, randomUUID(), 'not-a-uuid']) {
      const res = await call(manager, MANAGER, 'GET', `/v1/team/${id}/days/${today()}`);
      expect(res.statusCode).toBe(404);
    }
    const exc = await call(
      manager,
      MANAGER,
      'GET',
      `/v1/team/exceptions?from=${today()}&to=${today()}&employee_id=${stranger}`,
    );
    expect(exc.statusCode).toBe(404);
    expect(db.viewAudit).toEqual([]);
  });

  it('a report moved to another manager drops out of scope', async () => {
    await db.employees.setReportingManager({
      employeeId: report2,
      managerId: stranger,
      actorUserId: 'x',
      reason: null,
      correlationId: 'c',
      at: new Date(),
    });
    const names = (
      (await call(manager, MANAGER, 'GET', '/v1/team')).json() as { people: PersonNow[] }
    ).people.map((p) => p.name);
    expect(names).toEqual(['Farheen Test']);
    expect(
      (await call(manager, MANAGER, 'GET', `/v1/team/${report2}/days/${today()}`)).statusCode,
    ).toBe(404);
  });
});

describe('Team today', () => {
  it('shows live status, a planned break with back-by, and clocked out', async () => {
    await seedOpen(report, 120, [
      ['USER_START_BREAK', 10, { break_kind: 'personal', planned_minutes: 20 }],
    ]);
    await seedOpen(report2, 180, [], { minutesAgo: 30, reason: 'user_clock_out' });
    const people = (
      (await call(manager, MANAGER, 'GET', '/v1/team')).json() as {
        people: PersonNow[];
      }
    ).people;
    const f = people.find((p) => p.employee_id === report);
    expect(f).toMatchObject({ status: 'on_break', kind: 'personal_break' });
    expect(Date.parse(f?.back_by ?? '') - Date.parse(f?.since ?? '')).toBe(20 * MIN); // one event
    expect(Math.abs((f?.worked_ms ?? 0) - 110 * MIN)).toBeLessThan(1000);
    const r = people.find((p) => p.employee_id === report2);
    expect(r).toMatchObject({ status: 'clocked_out', kind: null });
    expect(Math.abs((r?.worked_ms ?? 0) - 150 * MIN)).toBeLessThan(1000);
    expect(db.viewAudit).toEqual([]); // the status board isn't audited
  });
});

describe("a person's day", () => {
  it('returns the day view with planned minutes, and audits the view', async () => {
    await seedOpen(report, 60, [
      ['USER_START_BREAK', 40, { break_kind: 'rest', planned_minutes: 15 }],
      ['USER_END_BREAK', 20, {}],
    ]);
    const res = await call(manager, MANAGER, 'GET', `/v1/team/${report}/days/${dateOf(60)}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      name: string;
      sessions: { segments: { kind: string; planned_minutes?: number }[] }[];
      totals: { paid_break_ms: number; unpaid_break_ms: number };
    };
    expect(body.name).toBe('Farheen Test');
    const tea = body.sessions[0]?.segments.find((s) => s.kind === 'rest_break');
    expect(tea?.planned_minutes).toBe(15);
    expect(body.totals.paid_break_ms).toBe(15 * MIN);
    expect(body.totals.unpaid_break_ms).toBe(5 * MIN);
    expect(db.viewAudit).toMatchObject([
      { employeeId: report, action: 'day_viewed', detail: { date: dateOf(60) } },
    ]);
  });

  it('checks the date and the range', async () => {
    const bad = await call(manager, MANAGER, 'GET', `/v1/team/${report}/days/2020-01-01`);
    expect(bad.statusCode).toBe(400);
    const sums = await call(
      manager,
      MANAGER,
      'GET',
      `/v1/team/${report}/days?from=${today()}&to=${today()}`,
    );
    expect(sums.statusCode).toBe(200);
  });
});

describe('presence checks (ADR-0024)', () => {
  it('marks the prompt and its idle, and lists answered and unanswered checks', async () => {
    const since = (ago: number) => new Date(Date.now() - ago * MIN).toISOString();
    await seedOpen(report, 300, [
      // Answered: a check, then "still working".
      ['INPUT_IDLE_5M', 200, { trigger: 'input_pattern', pattern: 'periodic' }],
      ['USER_PROMPT_RESPONSE', 199, { response: 'still_working' }],
      // Unanswered: idle from when the held key began (20 min before).
      ['INPUT_IDLE_5M', 100, { trigger: 'input_pattern', pattern: 'continuous' }],
      ['IDLE_STARTED', 99, { idle_since: since(120) }],
      ['IDLE_ENDED', 60, { idle_since: since(120) }],
    ]);
    const day = await call(manager, MANAGER, 'GET', `/v1/team/${report}/days/${dateOf(300)}`);
    const segs = (
      day.json() as { sessions: { segments: { kind: string; presence_check?: string }[] }[] }
    ).sessions[0]?.segments;
    expect(segs?.filter((g) => g.presence_check).map((g) => [g.kind, g.presence_check])).toEqual([
      ['prompt', 'periodic'],
      ['idle', 'continuous'],
    ]);

    const res = await call(
      manager,
      MANAGER,
      'GET',
      `/v1/team/exceptions?from=${yesterday()}&to=${today()}`,
    );
    const checks = (res.json() as { exceptions: TeamException[] }).exceptions
      .filter((e) => e.kind === 'presence_check')
      .map((e) => [e.pattern, e.answered]);
    expect(checks.sort()).toEqual([
      ['continuous', false],
      ['periodic', true],
    ]);
  });
});

describe('exceptions', () => {
  it('lists long idle, breaks over plan and limit, and idle clock-outs, and audits each person', async () => {
    await seedOpen(report, 300, [
      // Personal, planned 20, took 35 (limit 30): over plan and over limit.
      ['USER_START_BREAK', 280, { break_kind: 'personal', planned_minutes: 20 }],
      ['USER_END_BREAK', 245, {}],
      // 20 minutes idle.
      ['INPUT_IDLE_5M', 200, {}],
      ['IDLE_STARTED', 199, { idle_since: new Date(Date.now() - 200 * MIN).toISOString() }],
      ['IDLE_ENDED', 180, { idle_since: new Date(Date.now() - 200 * MIN).toISOString() }],
    ]);
    await seedOpen(report2, 200, [], { minutesAgo: 60, reason: 'idle_cap' });
    const res = await call(
      manager,
      MANAGER,
      'GET',
      `/v1/team/exceptions?from=${yesterday()}&to=${today()}`,
    );
    expect(res.statusCode).toBe(200);
    const kinds = (res.json() as { exceptions: TeamException[] }).exceptions
      .map((e) => `${e.name}:${e.kind}${e.over_minutes !== null ? `+${e.over_minutes}` : ''}`)
      .sort();
    expect(kinds).toEqual(
      expect.arrayContaining([
        'Farheen Test:break_over_limit+5',
        'Farheen Test:break_over_planned+15',
        'Farheen Test:long_idle',
        'Roshni Test:auto_clock_out',
      ]),
    );
    expect(db.viewAudit.map((a) => [a.employeeId, a.action]).sort()).toEqual(
      [
        [report, 'exceptions_viewed'],
        [report2, 'exceptions_viewed'],
      ].sort(),
    );
  });
});

describe('reporting lines (ADR-0025 §1)', () => {
  it('HR sets and clears a manager, audited; no self or loops', async () => {
    const set = await call(hr, HR, 'PUT', `/v1/admin/employees/${stranger}/manager`, {
      manager_employee_id: manager,
      reason: 'joined the team',
    });
    expect(set.statusCode).toBe(200);
    expect((await db.employees.findById(stranger))?.reportingManagerId).toBe(manager);
    expect(db.managerAudit.at(-1)).toMatchObject({
      employeeId: stranger,
      managerId: manager,
      reason: 'joined the team',
    });

    const self = await call(hr, HR, 'PUT', `/v1/admin/employees/${manager}/manager`, {
      manager_employee_id: manager,
    });
    expect(self.statusCode).toBe(400);
    // Farheen reports to Mona; making Mona report to Farheen is a loop.
    const loop = await call(hr, HR, 'PUT', `/v1/admin/employees/${manager}/manager`, {
      manager_employee_id: report,
    });
    expect((loop.json() as { code: string }).code).toBe('manager_loop');

    const clear = await call(hr, HR, 'PUT', `/v1/admin/employees/${stranger}/manager`, {
      manager_employee_id: null,
    });
    expect(clear.statusCode).toBe(200);
    expect((await db.employees.findById(stranger))?.reportingManagerId).toBeNull();
  });

  it('only HR and Administrators may set it; the list shows managers', async () => {
    const res = await call(manager, MANAGER, 'PUT', `/v1/admin/employees/${stranger}/manager`, {
      manager_employee_id: manager,
    });
    expect(res.statusCode).toBe(403);
    const list = await call(hr, HR, 'GET', '/v1/admin/employees');
    const rows = (
      list.json() as { employees: { name: string; reporting_manager_id: string | null }[] }
    ).employees;
    expect(rows.find((r) => r.name === 'Farheen Test')?.reporting_manager_id).toBe(manager);
    const admin = await call(manager, [AppRole.Administrator], 'GET', '/v1/admin/employees');
    expect(admin.statusCode).toBe(200);
  });
});
