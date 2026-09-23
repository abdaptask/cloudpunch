import { canonicalizeSignedFields, type CanonicalJsonValue } from '@cloudpunch/event-schema';
import { AppRole } from '@cloudpunch/shared';
import Fastify from 'fastify';
import { randomUUID, webcrypto } from 'node:crypto';
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
import { eventsRoutes } from './routes.js';
import type { EventItem } from './schemas.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const REQUIRED_SCOPE = 'api.access';
const KID = 'test-key-1';

let jwtSigner: KeyLike;
let jwks: JWTVerifyGetKey;

let db: InMemoryDb;
let eventPrivateKey: webcrypto.CryptoKey;
let userOid: string;
let userId: string;
let employeeId: string;
let deviceId: string;
let sessionId: string;
let correlationId: string;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  jwtSigner = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = KID;
  pub.alg = 'RS256';
  pub.use = 'sig';
  jwks = createLocalJWKSet({ keys: [pub] });
});

beforeEach(async () => {
  const kp = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  eventPrivateKey = kp.privateKey;
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));

  db = new InMemoryDb();
  userOid = randomUUID();
  userId = randomUUID();
  employeeId = randomUUID();
  deviceId = randomUUID();
  sessionId = randomUUID();
  correlationId = randomUUID();

  db.seedEmployee({
    id: employeeId,
    source: 'local_admin',
    greythrEmployeeId: null,
    employeeNumber: null,
    givenName: 'Alice',
    familyName: 'Test',
    displayName: null,
    workEmail: 'alice@aptask.com',
    status: 'active',
  });
  db.seedUser(
    {
      id: userId,
      entraObjectId: userOid,
      workEmail: 'alice@aptask.com',
      displayName: 'Alice Test',
      isServiceAccount: false,
      breakGlass: false,
      employeeId,
    },
    userOid,
  );
  await db.devices.enroll({
    id: deviceId,
    userId,
    os: 'macos',
    hostnameHash: 'sha256-' + '0'.repeat(64),
    publicKeyEd25519: raw,
    appVersion: '0.1.0',
  });
});

async function signToken(overrides: { oid?: string; roles?: string[] } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    aud: CLIENT_ID,
    tid: TENANT_ID,
    oid: overrides.oid ?? userOid,
    scp: REQUIRED_SCOPE,
    roles: overrides.roles ?? [AppRole.Employee],
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(jwtSigner);
}

async function buildApp() {
  const app = Fastify();
  await app.register(authPlugin, {
    jwks,
    issuer: ISSUER,
    audience: CLIENT_ID,
    tenantId: TENANT_ID,
    requiredScope: REQUIRED_SCOPE,
  });
  await app.register(eventsRoutes, { db });
  return app;
}

function mkUlid(n: number): string {
  const suffix = n
    .toString(32)
    .toUpperCase()
    .replace(/[ILOU]/g, 'X');
  return ('01J8Q0000000000000000000' + suffix).slice(-26).padStart(26, '0');
}

async function signedEvent(build: {
  event_type: EventItem['event_type'];
  sequence_number: number;
  event_ulid?: string;
  client_ts?: string;
  origin?: EventItem['origin'];
  payload?: Record<string, CanonicalJsonValue>;
}): Promise<EventItem> {
  const event_ulid = build.event_ulid ?? mkUlid(build.sequence_number);
  const client_ts = build.client_ts ?? new Date().toISOString();
  const payload = build.payload ?? {};
  const bytes = canonicalizeSignedFields({
    app_version: '0.1.0',
    client_ts,
    correlation_id: correlationId,
    device_id: deviceId,
    employee_id: employeeId,
    event_type: build.event_type,
    event_ulid,
    monotonic_ns: 0,
    offline_captured: false,
    origin: (build.origin ?? 'user') as EventItem['origin'],
    parent_event_ulid: null,
    payload,
    sequence_number: build.sequence_number,
    session_id: sessionId,
    tz_iana: 'Asia/Kolkata',
    utc_offset_minutes: 330,
  });
  const sig = await webcrypto.subtle.sign({ name: 'Ed25519' }, eventPrivateKey, bytes);
  return {
    event_ulid,
    event_type: build.event_type,
    sequence_number: build.sequence_number,
    client_ts,
    monotonic_ns: 0,
    tz_iana: 'Asia/Kolkata',
    utc_offset_minutes: 330,
    app_version: '0.1.0',
    origin: (build.origin ?? 'user') as EventItem['origin'],
    offline_captured: false,
    payload,
    integrity_signature: Buffer.from(new Uint8Array(sig)).toString('base64'),
    parent_event_ulid: null,
  };
}

function batch(events: EventItem[]) {
  return {
    device_id: deviceId,
    session_id: sessionId,
    employee_id: employeeId,
    correlation_id: correlationId,
    events,
  };
}

describe('POST /v1/events — auth + validation', () => {
  it('returns 401 without a bearer token', async () => {
    const app = await buildApp();
    const evt = await signedEvent({ event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: batch([evt]),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 on an unknown event_type', async () => {
    const app = await buildApp();
    const token = await signToken();
    const evt = await signedEvent({ event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    const bad = { ...evt, event_type: 'BOGUS' as EventItem['event_type'] };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${token}` },
      payload: batch([bad]),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 on an empty events array', async () => {
    const app = await buildApp();
    const token = await signToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${token}` },
      payload: batch([]),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /v1/events — happy paths (real signed events)', () => {
  it('accepts USER_CLOCK_IN and opens the session', async () => {
    const app = await buildApp();
    const token = await signToken();
    const evt = await signedEvent({ event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${token}` },
      payload: batch([evt]),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      correlation_id: string;
      session_closed_with: string | null;
      results: Array<{ status: string; event_ulid: string }>;
    };
    expect(body.results[0]?.status).toBe('accepted');
    expect(body.session_closed_with).toBeNull();
    expect(body.correlation_id).toBe(correlationId);
    await app.close();
  });

  it('closes the session on USER_CLOCK_OUT', async () => {
    const app = await buildApp();
    const token = await signToken();
    const inEvt = await signedEvent({ event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${token}` },
      payload: batch([inEvt]),
    });
    const outEvt = await signedEvent({ event_type: 'USER_CLOCK_OUT', sequence_number: 2 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${token}` },
      payload: batch([outEvt]),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_closed_with: string | null };
    expect(body.session_closed_with).toBe('user_clock_out');
    await app.close();
  });
});

describe('POST /v1/events — batch-level rejections', () => {
  it('returns 403 employee_id_mismatch when body employee_id differs from auth', async () => {
    const app = await buildApp();
    const token = await signToken();
    const evt = await signedEvent({ event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...batch([evt]), employee_id: randomUUID() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'employee_id_mismatch' });
    await app.close();
  });

  it('returns 409 device_revoked when the device is revoked', async () => {
    await db.devices.revoke(deviceId, 'test', randomUUID(), new Date());
    const app = await buildApp();
    const token = await signToken();
    const evt = await signedEvent({ event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${token}` },
      payload: batch([evt]),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'device_revoked' });
    await app.close();
  });

  it('returns 409 session_not_open when first event is not USER_CLOCK_IN and no session exists', async () => {
    const app = await buildApp();
    const token = await signToken();
    const evt = await signedEvent({
      event_type: 'INPUT_ACTIVITY',
      sequence_number: 2,
      origin: 'system_watcher',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${token}` },
      payload: batch([evt]),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'session_not_open' });
    await app.close();
  });
});

describe('POST /v1/events — per-event rejections in a 200 batch', () => {
  it('signature_invalid + duplicate_noop coexist inside a single 200 response', async () => {
    const app = await buildApp();
    const token = await signToken();

    const inEvt = await signedEvent({ event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${token}` },
      payload: batch([inEvt]),
    });

    const seq2 = await signedEvent({
      event_type: 'INPUT_ACTIVITY',
      sequence_number: 2,
      origin: 'system_watcher',
    });
    const badSig: EventItem = {
      ...seq2,
      event_ulid: mkUlid(3),
      sequence_number: 3,
      integrity_signature: Buffer.from(new Uint8Array(64).fill(0x77)).toString('base64'),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${token}` },
      payload: batch([inEvt, seq2, badSig]),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      results: Array<{ status: string; code?: string }>;
    };
    // inEvt was already accepted; retry -> duplicate_noop
    expect(body.results[0]?.status).toBe('duplicate_noop');
    expect(body.results[1]?.status).toBe('accepted');
    expect(body.results[2]?.status).toBe('rejected');
    expect(body.results[2]?.code).toBe('signature_invalid');
    await app.close();
  });
});
