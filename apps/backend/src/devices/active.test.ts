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
import type { DeviceOs, TimeSession } from '../db/index.js';
import { meRoutes } from '../me/routes.js';
import { peopleRoutes } from '../people/routes.js';
import { lastEventAt } from './active.js';
import { enrollDeviceService } from './enroll.js';

/**
 * ADR-0028 (one machine at a time), backend half:
 *   GET  /v1/me/active-device
 *   GET  /v1/people/:employeeId/active-device
 *   POST /v1/people/:employeeId/active-device/sign-out
 *   enrolment clears an admin sign-out
 * The ingest side (device_signed_out, take_over) is in events/routes.test.ts.
 */

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'test-key-1';

let signerPrivate: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;

interface Person {
  oid: string;
  userId: string;
  employeeId: string;
}
let alice: Person;
let bob: Person;
let admin: Person;
let laptop: string; // Alice's
let desktop: string; // Alice's
let bobs: string; // Bob's

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signerPrivate = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = KID;
  pub.alg = 'RS256';
  pub.use = 'sig';
  jwks = createLocalJWKSet({ keys: [pub] });
});

function seedPerson(name: string): Person {
  const p = { oid: randomUUID(), userId: randomUUID(), employeeId: randomUUID() };
  db.seedEmployee({
    id: p.employeeId,
    source: 'local_admin',
    greythrEmployeeId: null,
    employeeNumber: null,
    givenName: name,
    familyName: 'Test',
    displayName: null,
    workEmail: `${name.toLowerCase()}@aptask.com`,
    status: 'active',
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

async function seedDevice(owner: Person, os: DeviceOs): Promise<string> {
  const id = randomUUID();
  await db.devices.enroll({
    id,
    userId: owner.userId,
    os,
    hostnameHash: 'sha256-' + '0'.repeat(64),
    publicKeyEd25519: new Uint8Array(32).fill(0x11),
    appVersion: '0.1.8',
  });
  return id;
}

/** An event on `session` at `at` (the in-memory repo doesn't verify signatures). */
async function eventAt(session: TimeSession, seq: number, at: Date, type = 'INPUT_ACTIVITY') {
  await db.timeEvents.insertOne({
    eventUlid: randomUUID(),
    eventType: type,
    sessionId: session.id,
    employeeId: session.employeeId,
    sequenceNumber: seq,
    clientTs: at,
    monotonicNs: 0,
    tzIana: 'Asia/Kolkata',
    utcOffsetMinutes: 330,
    deviceId: session.deviceId,
    appVersion: '0.1.8',
    origin: 'user',
    offlineCaptured: false,
    payload: {},
    integritySignature: new Uint8Array(64),
    correlationId: randomUUID(),
    parentEventUlid: null,
  });
}

beforeEach(async () => {
  db = new InMemoryDb();
  alice = seedPerson('Alice');
  bob = seedPerson('Bob');
  admin = seedPerson('Admin');
  laptop = await seedDevice(alice, 'windows');
  desktop = await seedDevice(alice, 'macos');
  bobs = await seedDevice(bob, 'windows');
});

async function call(
  as: Person,
  roles: readonly string[],
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    aud: CLIENT_ID,
    tid: TENANT_ID,
    oid: as.oid,
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
  await app.register(meRoutes, { db });
  await app.register(peopleRoutes, { db, graphFor: null, welcome: null });
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  await app.close();
  return res;
}

const EMPLOYEE = [AppRole.Employee];
const ADMIN = [AppRole.Administrator];

describe('GET /v1/me/active-device (ADR-0028 §2)', () => {
  it('nothing open: not blocked, not signed out', async () => {
    const res = await call(alice, EMPLOYEE, 'GET', `/v1/me/active-device?device_id=${laptop}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ this_device: { signed_out: false }, elsewhere: null });
  });

  it('clocked in on another of my machines: elsewhere names it', async () => {
    const openedAt = new Date('2026-09-30T03:32:00Z');
    await db.timeSessions.open({ employeeId: alice.employeeId, deviceId: laptop, openedAt });
    const res = await call(alice, EMPLOYEE, 'GET', `/v1/me/active-device?device_id=${desktop}`);
    expect(res.statusCode).toBe(200);
    const enrolled = await db.devices.findById(laptop);
    expect(res.json()).toEqual({
      this_device: { signed_out: false },
      elsewhere: {
        device_id: laptop,
        os: 'windows',
        enrolled_at: enrolled?.enrolledAt.toISOString(),
        opened_at: openedAt.toISOString(),
      },
    });
  });

  it('clocked in on this machine: elsewhere is null', async () => {
    await db.timeSessions.open({
      employeeId: alice.employeeId,
      deviceId: laptop,
      openedAt: new Date(),
    });
    const res = await call(alice, EMPLOYEE, 'GET', `/v1/me/active-device?device_id=${laptop}`);
    expect(res.json()).toMatchObject({ elsewhere: null });
  });

  it('only my own sessions count', async () => {
    await db.timeSessions.open({
      employeeId: bob.employeeId,
      deviceId: bobs,
      openedAt: new Date(),
    });
    const res = await call(alice, EMPLOYEE, 'GET', `/v1/me/active-device?device_id=${laptop}`);
    expect(res.json()).toMatchObject({ elsewhere: null });
  });

  it("someone else's device or an unknown one is 404 unknown_device", async () => {
    const other = await call(alice, EMPLOYEE, 'GET', `/v1/me/active-device?device_id=${bobs}`);
    expect(other.statusCode).toBe(404);
    expect(other.json()).toMatchObject({ code: 'unknown_device' });
    const unknown = await call(
      alice,
      EMPLOYEE,
      'GET',
      `/v1/me/active-device?device_id=${randomUUID()}`,
    );
    expect(unknown.statusCode).toBe(404);
  });

  it('a missing or malformed device_id is 400', async () => {
    expect((await call(alice, EMPLOYEE, 'GET', '/v1/me/active-device')).statusCode).toBe(400);
    expect(
      (await call(alice, EMPLOYEE, 'GET', '/v1/me/active-device?device_id=nope')).statusCode,
    ).toBe(400);
  });

  it('any signed-in role may ask about its own machine', async () => {
    const res = await call(
      alice,
      [AppRole.Auditor],
      'GET',
      `/v1/me/active-device?device_id=${laptop}`,
    );
    expect(res.statusCode).toBe(200);
  });

  it('signed_out follows an admin sign-out, and clears on the next enrolment', async () => {
    const out = await call(
      admin,
      ADMIN,
      'POST',
      `/v1/people/${alice.employeeId}/active-device/sign-out`,
      {
        device_id: laptop,
      },
    );
    expect(out.statusCode).toBe(200);
    const after = await call(alice, EMPLOYEE, 'GET', `/v1/me/active-device?device_id=${laptop}`);
    expect(after.json()).toMatchObject({ this_device: { signed_out: true } });

    const enrolled = await enrollDeviceService({
      db,
      authOid: alice.oid,
      deviceId: laptop,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: new Uint8Array(32).fill(0x22),
      appVersion: '0.1.9',
    });
    expect(enrolled.ok && enrolled.device.signoutRequestedAt).toBeNull();
    expect((await db.devices.findById(laptop))?.signoutRequestedAt).toBeNull();
    expect((await db.devices.findById(laptop))?.signoutRequestedBy).toBeNull();
    const again = await call(alice, EMPLOYEE, 'GET', `/v1/me/active-device?device_id=${laptop}`);
    expect(again.json()).toMatchObject({ this_device: { signed_out: false } });
  });
});

describe('GET /v1/people/:employeeId/active-device (ADR-0028 §4)', () => {
  it('204 when the person has no open session', async () => {
    const res = await call(admin, ADMIN, 'GET', `/v1/people/${alice.employeeId}/active-device`);
    expect(res.statusCode).toBe(204);
  });

  it('the open session’s machine, with its last event time', async () => {
    const openedAt = new Date(Date.now() - 3 * 3600_000);
    const s = await db.timeSessions.open({
      employeeId: alice.employeeId,
      deviceId: laptop,
      openedAt,
    });
    await eventAt(s, 1, openedAt, 'USER_CLOCK_IN');
    const last = new Date(Date.now() - 3600_000);
    await eventAt(s, 2, last);
    const res = await call(admin, ADMIN, 'GET', `/v1/people/${alice.employeeId}/active-device`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      device_id: laptop,
      os: 'windows',
      enrolled_at: (await db.devices.findById(laptop))?.enrolledAt.toISOString(),
      opened_at: openedAt.toISOString(),
      last_event_at: last.toISOString(),
    });
  });

  it('Administrator only: HR, Manager, Employee and Auditor get 403', async () => {
    for (const role of [AppRole.HR, AppRole.Manager, AppRole.Employee, AppRole.Auditor]) {
      const res = await call(admin, [role], 'GET', `/v1/people/${alice.employeeId}/active-device`);
      expect(res.statusCode).toBe(403);
    }
  });

  it('unknown employee is 404, a malformed id 400', async () => {
    expect(
      (await call(admin, ADMIN, 'GET', `/v1/people/${randomUUID()}/active-device`)).statusCode,
    ).toBe(404);
    expect((await call(admin, ADMIN, 'GET', '/v1/people/nope/active-device')).statusCode).toBe(400);
  });
});

describe('POST /v1/people/:employeeId/active-device/sign-out (ADR-0028 §4)', () => {
  const url = () => `/v1/people/${alice.employeeId}/active-device/sign-out`;

  it('closes the session at its last event (remote_takeover, reconstructed), marks the device and audits', async () => {
    const openedAt = new Date(Date.now() - 3 * 3600_000);
    const s = await db.timeSessions.open({
      employeeId: alice.employeeId,
      deviceId: laptop,
      openedAt,
    });
    await eventAt(s, 1, openedAt, 'USER_CLOCK_IN');
    const last = new Date(Date.now() - 2 * 3600_000);
    await eventAt(s, 2, last);

    const res = await call(admin, ADMIN, 'POST', url(), { device_id: laptop });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ closed_at: last.toISOString() });

    const closed = await db.timeSessions.findById(s.id);
    expect(closed).toMatchObject({
      closedAt: last,
      closedReason: 'remote_takeover',
      reconstructed: true,
    });
    const device = await db.devices.findById(laptop);
    expect(device?.signoutRequestedAt).toBeInstanceOf(Date);
    expect(device?.signoutRequestedBy).toBe(admin.userId);
    expect(db.signOutAudit).toHaveLength(1);
    expect(db.signOutAudit[0]).toMatchObject({
      actorUserId: admin.userId,
      employeeId: alice.employeeId,
      deviceId: laptop,
      sessionId: s.id,
      closed: last,
    });
    // Nothing in time_event changed (invariant 2).
    expect((await db.timeEvents.findBySessionOrderedBySequence(s.id)).length).toBe(2);

    // Now she can clock in elsewhere, and the laptop is signed out.
    const now = await call(alice, EMPLOYEE, 'GET', `/v1/me/active-device?device_id=${desktop}`);
    expect(now.json()).toEqual({ this_device: { signed_out: false }, elsewhere: null });
  });

  it('a session with no events closes at opened_at', async () => {
    const openedAt = new Date(Date.now() - 3600_000);
    await db.timeSessions.open({ employeeId: alice.employeeId, deviceId: laptop, openedAt });
    const res = await call(admin, ADMIN, 'POST', url(), { device_id: laptop });
    expect(res.json()).toEqual({ closed_at: openedAt.toISOString() });
  });

  it('no open session on that machine: still signs it out, closed_at null', async () => {
    const s = await db.timeSessions.open({
      employeeId: alice.employeeId,
      deviceId: desktop,
      openedAt: new Date(),
    });
    const res = await call(admin, ADMIN, 'POST', url(), { device_id: laptop });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ closed_at: null });
    expect((await db.devices.findById(laptop))?.signoutRequestedAt).toBeInstanceOf(Date);
    // The session on the other machine is untouched.
    expect((await db.timeSessions.findById(s.id))?.closedAt).toBeNull();
    expect(db.signOutAudit[0]).toMatchObject({ sessionId: null, closed: null });
  });

  it('repeating is harmless', async () => {
    await db.timeSessions.open({
      employeeId: alice.employeeId,
      deviceId: laptop,
      openedAt: new Date(Date.now() - 60_000),
    });
    expect((await call(admin, ADMIN, 'POST', url(), { device_id: laptop })).json()).toHaveProperty(
      'closed_at',
    );
    const again = await call(admin, ADMIN, 'POST', url(), { device_id: laptop });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ closed_at: null });
  });

  it("another person's device, or an unknown one, is 404", async () => {
    const other = await call(admin, ADMIN, 'POST', url(), { device_id: bobs });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toMatchObject({ code: 'unknown_device' });
    expect((await db.devices.findById(bobs))?.signoutRequestedAt ?? null).toBeNull();
    expect((await call(admin, ADMIN, 'POST', url(), { device_id: randomUUID() })).statusCode).toBe(
      404,
    );
    expect(db.signOutAudit).toHaveLength(0);
  });

  it('Administrator only: HR, Manager, Employee and Auditor get 403 and change nothing', async () => {
    const s = await db.timeSessions.open({
      employeeId: alice.employeeId,
      deviceId: laptop,
      openedAt: new Date(),
    });
    for (const role of [AppRole.HR, AppRole.Manager, AppRole.Employee, AppRole.Auditor]) {
      const res = await call(alice, [role], 'POST', url(), { device_id: laptop });
      expect(res.statusCode).toBe(403);
    }
    expect((await db.timeSessions.findById(s.id))?.closedAt).toBeNull();
    expect(db.signOutAudit).toHaveLength(0);
  });

  it('a bad body is 400', async () => {
    expect((await call(admin, ADMIN, 'POST', url(), { device_id: 'nope' })).statusCode).toBe(400);
    expect((await call(admin, ADMIN, 'POST', url(), {})).statusCode).toBe(400);
  });
});

describe('lastEventAt', () => {
  const openedAt = new Date('2026-09-30T03:00:00Z');
  const session: TimeSession = {
    id: randomUUID(),
    employeeId: randomUUID(),
    deviceId: randomUUID(),
    openedAt,
    closedAt: null,
    closedReason: null,
    reconstructed: false,
  };

  it('is kept within [opened_at, now]', async () => {
    const now = new Date('2026-09-30T05:00:00Z');
    await eventAt(session, 1, new Date('2026-09-30T02:00:00Z'));
    expect(await lastEventAt(db, session, now)).toEqual(openedAt);
    await eventAt(session, 2, new Date('2026-09-30T09:00:00Z'));
    expect(await lastEventAt(db, session, now)).toEqual(now);
    // A clock-in dated after now still closes at opened_at, never before it.
    expect(await lastEventAt(db, session, new Date('2026-09-30T02:30:00Z'))).toEqual(openedAt);
  });
});
