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
import type { ShiftMail } from '../alerts/mail.js';
import { authPlugin } from '../auth/plugin.js';
import { InMemoryDb } from '../db/in-memory.js';
import type { Employee } from '../db/index.js';
import type { DayRow, DayStatus } from '../reports/day.js';
import { refreshPerson } from './job.js';
import { insightRoutes } from './routes.js';
import { draftNudge, findingsOf, headlineOf, stripOf } from './rules.js';

const H = 3_600_000;

function row(date: string, status: DayStatus, over: Partial<DayRow> = {}): DayRow {
  return {
    employee_id: 'e1',
    name: 'Isha Test',
    manager_id: null,
    date,
    status,
    shift:
      status === 'off' ? null : { start: `${date}T03:30:00.000Z`, end: `${date}T12:30:00.000Z` },
    tz: 'Asia/Kolkata',
    clock_in: null,
    clock_out: null,
    still_in: false,
    minutes_late: status === 'late' ? 25 : null,
    worked_ms: status === 'worked' || status === 'late' ? 8.5 * H : 0,
    shift_ms: status === 'off' ? 0 : 9 * H,
    idle_ms: 0,
    breaks_ms: 0,
    breaks_over_limit: 0,
    away_ms: 0,
    corrections_waiting: 0,
    segments: [],
    ...over,
  };
}

const day = (n: number): string => `2026-10-${String(n).padStart(2, '0')}`;

describe('findings (ADR-0047 §1)', () => {
  it('opens at the thresholds; holidays and office days never count', () => {
    const rows = [
      row(day(1), 'late'),
      row(day(2), 'late'),
      row(day(3), 'holiday'),
      row(day(4), 'in_office'),
      row(day(5), 'worked'),
      row(day(6), 'not_clocked_in'),
    ];
    expect(findingsOf(rows)).toEqual([]);
    const more = [...rows, row(day(7), 'late'), row(day(8), 'not_clocked_in')];
    expect(findingsOf(more).map((f) => [f.kind, f.count, f.severity])).toEqual([
      ['late_starts', 3, 'warning'],
      ['missed_starts', 2, 'serious'],
    ]);
    expect(stripOf(more).map((d) => d.mark)).toEqual([
      'late',
      'late',
      'holiday',
      'office',
      'on_time',
      'missed',
      'late',
      'missed',
    ]);
  });

  it('hours, idle, breaks, clock-outs and long days', () => {
    const short = { worked_ms: 6 * H };
    const rows = [
      row(day(1), 'worked', short),
      row(day(2), 'worked', short),
      row(day(3), 'worked', { ...short, idle_ms: 2 * H }),
      row(day(4), 'worked', { idle_ms: H, breaks_over_limit: 3 }),
      row(day(5), 'worked', { idle_ms: H, breaks_over_limit: 2 }),
      row(day(6), 'worked', { still_in: true }),
      row(day(7), 'worked', { still_in: true, worked_ms: 11 * H }),
      row(day(8), 'worked', { worked_ms: 11 * H }),
      row(day(9), 'worked', { worked_ms: 10.5 * H }),
    ];
    expect(findingsOf(rows).map((f) => [f.kind, f.count])).toEqual([
      ['short_days', 3],
      ['long_idle', 3],
      ['breaks_over', 5],
      ['forgets_clock_out', 2],
      ['long_days', 3],
    ]);
    expect(headlineOf({ kind: 'late_starts', count: 4 })).toBe('Late 4 times in 14 days');
  });

  it('a nudge drafted with the days, friendly and editable', () => {
    const text = draftNudge('Isha', { kind: 'late_starts', dates: [day(5), day(7), day(12)] });
    expect(text).toContain('Hi Isha,');
    expect(text).toContain('on 3 days in the last two weeks (Mon 5 Oct, Wed 7 Oct, Mon 12 Oct)');
  });
});

describe('a finding as a case (ADR-0047 §2)', () => {
  let db: InMemoryDb;
  const person: Employee = {
    id: 'e1',
    source: 'local_admin',
    greythrEmployeeId: null,
    employeeNumber: null,
    givenName: 'Isha',
    familyName: 'Test',
    displayName: 'Isha Test',
    workEmail: 'isha@aptask.com',
    status: 'active',
    reportingManagerId: null,
  };
  const window = { from: day(1), to: day(14) };
  const late = [row(day(5), 'late'), row(day(7), 'late'), row(day(12), 'late')];
  const at = new Date('2026-10-15T03:00:00Z');
  const live = () => db.insights.list(['open', 'nudged']);

  beforeEach(() => {
    db = new InMemoryDb();
  });

  it('opens once, updates on new evidence, and resolves when the pattern goes', async () => {
    expect(await refreshPerson(db, person, late, [], window, day(15), at)).toEqual([
      'late_starts opened',
    ]);
    // Same evidence again: nothing changes (idempotent).
    expect(await refreshPerson(db, person, late, await live(), window, day(15), at)).toEqual([]);
    expect(db.insightEvents.map((e) => e.action)).toEqual(['opened']);
    const four = [...late, row(day(13), 'late')];
    await refreshPerson(db, person, four, await live(), window, day(16), at);
    expect(db.insightEvents.map((e) => e.action)).toEqual(['opened', 'updated']);
    expect(await refreshPerson(db, person, [], await live(), window, day(30), at)).toEqual([
      'late_starts resolved',
    ]);
    expect(await live()).toEqual([]);
  });

  it('after a nudge: improved by the follow-up day → resolved; not → back to open, "no change"', async () => {
    await refreshPerson(db, person, late, [], window, day(15), at);
    const [ins] = await live();
    await db.insights.change(
      ins!.id,
      { status: 'nudged', followUpOn: day(29) },
      { action: 'nudged', actorUserId: null, note: 'Hi', detail: null, at },
    );
    // Before the follow-up day: left alone even if the pattern faded.
    expect(await refreshPerson(db, person, [], await live(), window, day(20), at)).toEqual([]);
    // Follow-up day, still late: reopened with "no change".
    expect(await refreshPerson(db, person, late, await live(), window, day(29), at)).toEqual([
      'late_starts reopened',
    ]);
    const [again] = await live();
    expect(again).toMatchObject({ status: 'open', noChange: true, followUpOn: null });
    // Nudged again, then improved by the next follow-up.
    await db.insights.change(
      again!.id,
      { status: 'nudged', followUpOn: day(31) },
      { action: 'nudged', actorUserId: null, note: 'Hi again', detail: null, at },
    );
    expect(await refreshPerson(db, person, [], await live(), window, day(31), at)).toEqual([
      'late_starts resolved',
    ]);
    expect(db.insightEvents.at(-1)).toMatchObject({
      action: 'resolved',
      note: 'Improved since the nudge',
    });
  });
});

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'k1';
let signer: KeyLike;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signer = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = KID;
  pub.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [pub] });
});

describe('insight routes (ADR-0047 §3–5)', () => {
  let db: InMemoryDb;
  let outbox: ShiftMail[];
  const ids: Record<string, { emp: string; oid: string }> = {};
  let finding = '';

  beforeEach(async () => {
    db = new InMemoryDb();
    outbox = [];
    for (const [name, manager] of [
      ['Mona', null],
      ['Isha', 'Mona'],
      ['Sam', null],
    ] as const) {
      const emp = randomUUID();
      const oid = randomUUID();
      ids[name] = { emp, oid };
      db.seedEmployee({
        id: emp,
        source: 'local_admin',
        greythrEmployeeId: null,
        employeeNumber: null,
        givenName: name,
        familyName: 'Test',
        displayName: `${name} Test`,
        workEmail: `${name.toLowerCase()}@aptask.com`,
        status: 'active',
        reportingManagerId: manager ? (ids[manager]?.emp ?? null) : null,
      });
      db.seedUser(
        {
          id: randomUUID(),
          entraObjectId: oid,
          workEmail: `${name.toLowerCase()}@aptask.com`,
          displayName: `${name} Test`,
          isServiceAccount: false,
          breakGlass: false,
          employeeId: emp,
        },
        oid,
      );
    }
    const ins = await db.insights.open(
      {
        employeeId: ids['Isha']!.emp,
        kind: 'late_starts',
        severity: 'warning',
        evidence: {
          from: day(1),
          to: day(14),
          count: 3,
          dates: [day(5), day(7), day(12)],
          strip: [],
        },
      },
      { action: 'opened', actorUserId: null, note: null, detail: null, at: new Date() },
    );
    finding = ins.id;
  });

  async function call(
    as: string,
    roles: string[],
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
  ) {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      aud: CLIENT_ID,
      tid: TENANT_ID,
      oid: ids[as]!.oid,
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
    await app.register(insightRoutes, {
      db,
      send: async (m) => {
        outbox.push(m);
      },
      siteUrl: 'https://cloudpunch.aptask.com',
    });
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
  }

  it('the manager sees their report’s finding with a draft; someone else’s manager does not', async () => {
    const res = await call('Mona', [AppRole.Manager], 'GET', '/v1/insights');
    expect(res.statusCode).toBe(200);
    const [i] = (
      res.json() as {
        insights: { name: string; headline: string; draft: string; manager_name: string }[];
      }
    ).insights;
    expect(i).toMatchObject({
      name: 'Isha Test',
      headline: 'Late 3 times in 14 days',
      manager_name: 'Mona Test',
    });
    expect(i?.draft).toContain('Hi Isha,');
    const other = await call('Sam', [AppRole.Manager], 'GET', '/v1/insights');
    expect((other.json() as { insights: unknown[] }).insights).toEqual([]);
    expect((await call('Isha', [AppRole.Employee], 'GET', '/v1/insights')).statusCode).toBe(403);
  });

  it('nudge: emails the person, manager and sender copied; the case moves to nudged with a follow-up', async () => {
    const res = await call('Sam', [AppRole.HR], 'POST', `/v1/insights/${finding}/nudge`, {
      message: 'Hi Isha, is anything making mornings hard?',
    });
    expect(res.statusCode).toBe(200);
    const nudged = res.json() as { status: string; follow_up_on: string };
    expect(nudged.status).toBe('nudged');
    expect(nudged.follow_up_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(outbox).toEqual([
      expect.objectContaining({
        to: ['isha@aptask.com'],
        cc: ['mona@aptask.com', 'sam@aptask.com'],
        subject: 'Your start times in the last two weeks',
      }),
    ]);
    expect(outbox[0]?.text).toContain('Hi Isha, is anything making mornings hard?');
    const history = await call('Sam', [AppRole.HR], 'GET', `/v1/insights/${finding}/history`);
    expect(
      (history.json() as { events: { action: string; by: string | null }[] }).events.map((e) => [
        e.action,
        e.by,
      ]),
    ).toEqual([
      ['opened', null],
      ['nudged', 'Sam Test'],
    ]);
  });

  it('dismiss needs a reason; closed findings refuse more actions', async () => {
    expect(
      (await call('Sam', [AppRole.HR], 'POST', `/v1/insights/${finding}/dismiss`, {})).statusCode,
    ).toBe(400);
    expect(
      (
        await call('Sam', [AppRole.HR], 'POST', `/v1/insights/${finding}/dismiss`, {
          reason: 'Shift was wrong; fixed',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call('Sam', [AppRole.HR], 'POST', `/v1/insights/${finding}/nudge`, {
          message: 'Hello there Isha',
        })
      ).statusCode,
    ).toBe(409);
    const closed = await call('Sam', [AppRole.HR], 'GET', '/v1/insights?status=closed');
    expect(
      (closed.json() as { insights: { status: string }[] }).insights.map((i) => i.status),
    ).toEqual(['dismissed']);
  });

  it('My week: only my own findings, with what was said to me; I can add context', async () => {
    await call('Mona', [AppRole.Manager], 'POST', `/v1/insights/${finding}/nudge`, {
      message: 'Hi Isha, all well?',
    });
    const mine = await call('Isha', [AppRole.Employee], 'GET', '/v1/me/insights');
    expect(mine.statusCode).toBe(200);
    const body = mine.json() as {
      strip: unknown[];
      findings: { headline: string; nudges: { message: string }[] }[];
    };
    expect(body.strip).toHaveLength(14);
    expect(body.findings).toEqual([
      expect.objectContaining({
        headline: 'Late 3 times in 14 days',
        nudges: [expect.objectContaining({ message: 'Hi Isha, all well?', by: 'Mona Test' })],
      }),
    ]);
    expect(
      (
        await call('Isha', [AppRole.Employee], 'POST', `/v1/me/insights/${finding}/context`, {
          text: 'Bus timings changed',
        })
      ).statusCode,
    ).toBe(200);
    // Someone else's finding: not found.
    expect(
      (
        await call('Sam', [AppRole.Employee], 'POST', `/v1/me/insights/${finding}/context`, {
          text: 'Not mine',
        })
      ).statusCode,
    ).toBe(404);
    expect((await call('Sam', [AppRole.Employee], 'GET', '/v1/me/insights')).json()).toMatchObject({
      findings: [],
    });
  });
});
