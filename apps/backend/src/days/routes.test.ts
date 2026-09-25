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
import { dayRoutes } from './routes.js';
import type { DayView } from './service.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'k1';
const IST = 330;
const MIN = 60_000;

let signer: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;
const oid = randomUUID();
const employeeId = randomUUID();
const otherEmployee = randomUUID();

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signer = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = KID;
  pub.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [pub] });
});

function employee(id: string) {
  return {
    id,
    source: 'local_admin' as const,
    greythrEmployeeId: null,
    employeeNumber: null,
    givenName: 'A',
    familyName: 'B',
    displayName: null,
    workEmail: 'a@aptask.com',
    status: 'active' as const,
  };
}

beforeEach(() => {
  db = new InMemoryDb();
  db.seedEmployee(employee(employeeId));
  db.seedEmployee(employee(otherEmployee));
  db.seedUser(
    {
      id: randomUUID(),
      entraObjectId: oid,
      workEmail: 'a@aptask.com',
      displayName: 'A B',
      isServiceAccount: false,
      breakGlass: false,
      employeeId,
    },
    oid,
  );
});

/** YYYY-MM-DD, `days` before today (UTC). */
function dateAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** UTC instant of a local wall time on `date` at IST, plus `addDays`. */
function ist(date: string, hhmm: string, addDays = 0): Date {
  const t = Date.parse(`${date}T${hhmm}:00Z`) + addDays * 86_400_000;
  return new Date(t - IST * MIN);
}

/** A clock-in … clock-out session with a Teams call in the middle. */
async function seedShift(emp: string, from: Date, to: Date): Promise<string> {
  const session = await db.timeSessions.open({
    employeeId: emp,
    deviceId: randomUUID(),
    openedAt: from,
  });
  const base = {
    sessionId: session.id,
    employeeId: emp,
    monotonicNs: 0,
    tzIana: 'Asia/Kolkata',
    utcOffsetMinutes: IST,
    deviceId: session.deviceId,
    appVersion: '0.1.0',
    origin: 'user' as const,
    offlineCaptured: false,
    integritySignature: new Uint8Array(64),
    correlationId: randomUUID(),
    parentEventUlid: null,
  };
  const mid = new Date((from.getTime() + to.getTime()) / 2);
  const events: [string, Date, Record<string, unknown>][] = [
    ['USER_CLOCK_IN', from, {}],
    ['MEDIA_DEVICE_STATE', mid, { in_use: true, call_type: 'teams' }],
    ['MEDIA_DEVICE_STATE', new Date(mid.getTime() + 30 * MIN), { in_use: false }],
    ['USER_CLOCK_OUT', to, {}],
  ];
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
  await db.timeSessions.close(session.id, to, 'user_clock_out');
  return session.id;
}

async function get(url: string, roles: readonly string[] = [AppRole.Employee]) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ aud: CLIENT_ID, tid: TENANT_ID, oid, scp: 'api.access', roles })
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
  await app.register(dayRoutes, { db });
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
  await app.close();
  return res;
}

describe('GET /v1/me/days/{date}', () => {
  it('owner example: an IST night shift across midnight is one working day on its first date', async () => {
    const d = dateAgo(3);
    const a = await seedShift(employeeId, ist(d, '18:30'), ist(d, '23:30'));
    const b = await seedShift(employeeId, ist(d, '00:15', 1), ist(d, '03:30', 1));
    // Somebody else's day never shows.
    await seedShift(otherEmployee, ist(d, '10:00'), ist(d, '12:00'));

    const res = await get(`/v1/me/days/${d}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as DayView;
    expect(body.sessions.map((s) => s.session_id)).toEqual([a, b]);
    expect(body.sessions[0]?.clock_in).toBe(`${d}T18:30:00.000+05:30`);
    expect(body.sessions[1]?.clock_out).toMatch(/T03:30:00\.000\+05:30$/);
    expect(body.sessions[0]?.segments.map((s) => s.kind)).toEqual([
      'working',
      'call_teams',
      'working',
    ]);
    expect(body.totals.worked_ms).toBe((5 * 60 + 3 * 60 + 15) * MIN);
    expect(body.totals.calls_ms).toBe(60 * MIN);

    // The next date has nothing: the early-morning session belongs to the day before.
    const next = (await get(`/v1/me/days/${dateAgo(2)}`)).json() as DayView;
    expect(next.sessions).toEqual([]);
  });

  it('rejects dates outside the 30-day look-back or malformed', async () => {
    expect((await get(`/v1/me/days/${dateAgo(40)}`)).statusCode).toBe(400);
    expect((await get('/v1/me/days/2026-13-01')).statusCode).toBe(400);
    expect((await get('/v1/me/days/yesterday')).statusCode).toBe(400);
    expect((await get(`/v1/me/days/${dateAgo(30)}`)).statusCode).toBe(200);
  });

  it('needs self.timeline.read', async () => {
    expect((await get(`/v1/me/days/${dateAgo(1)}`, [AppRole.Auditor])).statusCode).toBe(403);
  });
});

describe('GET /v1/me/days?from&to', () => {
  it('returns totals per working day in range', async () => {
    const d1 = dateAgo(5);
    const d2 = dateAgo(4);
    await seedShift(employeeId, ist(d1, '09:00'), ist(d1, '17:00'));
    await seedShift(employeeId, ist(d2, '09:00'), ist(d2, '13:00'));
    const res = await get(`/v1/me/days?from=${d1}&to=${dateAgo(1)}`);
    expect(res.statusCode).toBe(200);
    const { days } = res.json() as {
      days: { date: string; worked_ms: number; sessions: number }[];
    };
    expect(days.map((d) => [d.date, d.worked_ms / MIN, d.sessions])).toEqual([
      [d1, 480, 1],
      [d2, 240, 1],
    ]);
  });

  it('rejects a reversed or too-long range', async () => {
    expect((await get(`/v1/me/days?from=${dateAgo(1)}&to=${dateAgo(3)}`)).statusCode).toBe(400);
    expect((await get(`/v1/me/days?from=${dateAgo(40)}&to=${dateAgo(1)}`)).statusCode).toBe(400);
    expect((await get('/v1/me/days')).statusCode).toBe(400);
  });
});
