import { canonicalizeSignedFields } from '@cloudpunch/event-schema';
import { randomUUID, webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryDb } from '../db/in-memory.js';
import type { CanonicalJsonValue } from '@cloudpunch/event-schema';
import { MAX_SEQUENCE_GAP, ingestBatch } from './ingest.js';
import type { EventItem } from './schemas.js';

interface Ctx {
  db: InMemoryDb;
  privateKey: webcrypto.CryptoKey;
  publicKeyRaw: Uint8Array;
  userOid: string;
  userId: string;
  employeeId: string;
  deviceId: string;
  sessionId: string;
  correlationId: string;
}

async function makeCtx(): Promise<Ctx> {
  const kp = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
  const db = new InMemoryDb();
  const userOid = randomUUID();
  const userId = randomUUID();
  const employeeId = randomUUID();
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const correlationId = randomUUID();
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
    os: 'windows',
    hostnameHash: 'sha256-' + '0'.repeat(64),
    publicKeyEd25519: publicKeyRaw,
    appVersion: '0.1.0',
  });
  return {
    db,
    privateKey: kp.privateKey,
    publicKeyRaw,
    userOid,
    userId,
    employeeId,
    deviceId,
    sessionId,
    correlationId,
  };
}

interface EventBuild {
  event_type: EventItem['event_type'];
  sequence_number: number;
  event_ulid?: string;
  client_ts?: string;
  payload?: Record<string, CanonicalJsonValue>;
  origin?: EventItem['origin'];
  parent_event_ulid?: string | null;
}

async function signedEvent(
  ctx: Ctx,
  build: EventBuild,
  overrideSignatureBytes?: Uint8Array,
): Promise<EventItem> {
  const event_ulid = build.event_ulid ?? mkUlid(build.sequence_number);
  const client_ts = build.client_ts ?? new Date().toISOString();
  const payload = build.payload ?? {};
  const partial = {
    app_version: '0.1.0',
    client_ts,
    correlation_id: ctx.correlationId,
    device_id: ctx.deviceId,
    employee_id: ctx.employeeId,
    event_type: build.event_type,
    event_ulid,
    monotonic_ns: 0,
    offline_captured: false,
    origin: (build.origin ?? 'user') as EventItem['origin'],
    parent_event_ulid: build.parent_event_ulid ?? null,
    payload,
    sequence_number: build.sequence_number,
    session_id: ctx.sessionId,
    tz_iana: 'Asia/Kolkata',
    utc_offset_minutes: 330,
  };
  const bytes = canonicalizeSignedFields(partial);
  const sig =
    overrideSignatureBytes ??
    new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, ctx.privateKey, bytes));
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
    integrity_signature: Buffer.from(sig).toString('base64'),
    parent_event_ulid: build.parent_event_ulid ?? null,
  };
}

// Deterministic ULIDs for tests. Real ULIDs are Crockford; keep only
// legal characters and pad to 26.
function mkUlid(n: number): string {
  const suffix = n
    .toString(32)
    .toUpperCase()
    .replace(/[ILOU]/g, 'X');
  return ('01J8Q0000000000000000000' + suffix).slice(-26).padStart(26, '0');
}

let ctx: Ctx;
beforeEach(async () => {
  ctx = await makeCtx();
});

describe('ingestBatch — batch-level gates', () => {
  it('rejects when auth oid has no user', async () => {
    const evt = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: 'unknown-oid',
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [evt],
    });
    expect(r.status).toBe('no_user_for_oid');
  });

  it('rejects when employee_id in body mismatches user.employeeId', async () => {
    const evt = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: randomUUID(),
      correlationId: ctx.correlationId,
      events: [evt],
    });
    expect(r.status).toBe('employee_id_mismatch');
  });

  it('rejects when device is unknown', async () => {
    const evt = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: randomUUID(),
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [evt],
    });
    expect(r.status).toBe('device_unknown');
  });

  it('rejects when device is revoked', async () => {
    await ctx.db.devices.revoke(ctx.deviceId, 'test', randomUUID(), new Date());
    const evt = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [evt],
    });
    expect(r.status).toBe('device_revoked');
  });

  it('rejects when employee status is not active', async () => {
    // Rebuild ctx with an inactive employee
    ctx.db.seedEmployee({
      id: ctx.employeeId,
      source: 'local_admin',
      greythrEmployeeId: null,
      employeeNumber: null,
      givenName: 'Alice',
      familyName: 'Test',
      displayName: null,
      workEmail: 'alice@aptask.com',
      status: 'on_leave',
    });
    const evt = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [evt],
    });
    expect(r.status).toBe('employee_status_forbidden');
  });

  it('rejects when session does not exist and first event is not USER_CLOCK_IN', async () => {
    const evt = await signedEvent(ctx, {
      event_type: 'INPUT_ACTIVITY',
      sequence_number: 2,
      origin: 'system_watcher',
    });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [evt],
    });
    expect(r.status).toBe('session_not_open');
  });
});

describe('ingestBatch — happy paths', () => {
  it('opens a session on USER_CLOCK_IN and accepts the event', async () => {
    const evt = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [evt],
    });
    expect(r.status).toBe('batch_accepted');
    if (r.status === 'batch_accepted') {
      expect(r.results[0]?.status).toBe('accepted');
      expect(r.sessionClosedWith).toBeNull();
    }
    const session = await ctx.db.timeSessions.findById(ctx.sessionId);
    expect(session).not.toBeNull();
    expect(session?.closedAt).toBeNull();
  });

  it('closes the session on USER_CLOCK_OUT', async () => {
    const in1 = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [in1],
    });
    const out = await signedEvent(ctx, { event_type: 'USER_CLOCK_OUT', sequence_number: 2 });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [out],
    });
    expect(r.status).toBe('batch_accepted');
    if (r.status === 'batch_accepted') {
      expect(r.sessionClosedWith).toBe('user_clock_out');
    }
    const session = await ctx.db.timeSessions.findById(ctx.sessionId);
    expect(session?.closedAt).not.toBeNull();
    expect(session?.closedReason).toBe('user_clock_out');
  });

  it('is idempotent — retry of same event returns duplicate_noop', async () => {
    const evt = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [evt],
    });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [evt],
    });
    expect(r.status).toBe('batch_accepted');
    if (r.status === 'batch_accepted') {
      expect(r.results[0]?.status).toBe('duplicate_noop');
    }
  });
});

describe('ingestBatch — per-event rejections', () => {
  it('rejects with signature_invalid when the sig does not verify', async () => {
    const badSig = new Uint8Array(64).fill(0x99);
    const evt = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 }, badSig);
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [evt],
    });
    expect(r.status).toBe('batch_accepted');
    if (r.status === 'batch_accepted') {
      const first = r.results[0];
      expect(first?.status).toBe('rejected');
      if (first?.status === 'rejected') expect(first.code).toBe('signature_invalid');
    }
  });

  it('rejects with sequence_gap_too_large when jump > MAX_SEQUENCE_GAP', async () => {
    const in1 = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [in1],
    });
    const jump = await signedEvent(ctx, {
      event_type: 'INPUT_ACTIVITY',
      sequence_number: 1 + MAX_SEQUENCE_GAP + 5,
      origin: 'system_watcher',
    });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [jump],
    });
    expect(r.status).toBe('batch_accepted');
    if (r.status === 'batch_accepted') {
      const first = r.results[0];
      expect(first?.status).toBe('rejected');
      if (first?.status === 'rejected') expect(first.code).toBe('sequence_gap_too_large');
    }
  });

  it('rejects duplicate_sequence when two different ULIDs share (session, sequence)', async () => {
    const first = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [first],
    });
    // Same sequence, different ULID
    const conflict = await signedEvent(ctx, {
      event_type: 'INPUT_ACTIVITY',
      sequence_number: 1,
      origin: 'system_watcher',
      event_ulid: '01J8Q00000000000000000000Z',
    });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [conflict],
    });
    expect(r.status).toBe('batch_accepted');
    if (r.status === 'batch_accepted') {
      const only = r.results[0];
      expect(only?.status).toBe('rejected');
      if (only?.status === 'rejected') expect(only.code).toBe('duplicate_sequence');
    }
  });

  it('state_transition_invalid — USER_END_BREAK when not on break', async () => {
    const in1 = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [in1],
    });
    const badEnd = await signedEvent(ctx, {
      event_type: 'USER_END_BREAK',
      sequence_number: 2,
    });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [badEnd],
    });
    expect(r.status).toBe('batch_accepted');
    if (r.status === 'batch_accepted') {
      const first = r.results[0];
      expect(first?.status).toBe('rejected');
      if (first?.status === 'rejected') expect(first.code).toBe('state_transition_invalid');
    }
  });

  it('state_transition_invalid — second USER_CLOCK_IN on the same session', async () => {
    const in1 = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [in1],
    });
    const in2 = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 2 });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [in2],
    });
    expect(r.status).toBe('batch_accepted');
    if (r.status === 'batch_accepted') {
      const first = r.results[0];
      expect(first?.status).toBe('rejected');
      if (first?.status === 'rejected') expect(first.code).toBe('state_transition_invalid');
    }
  });

  it('state_transition_invalid — USER_PROMPT_RESPONSE without an idle prompt', async () => {
    const in1 = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [in1],
    });
    const promptResp = await signedEvent(ctx, {
      event_type: 'USER_PROMPT_RESPONSE',
      sequence_number: 2,
      payload: { response: 'bio_break', prompt_shown_at: new Date().toISOString() },
    });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [promptResp],
    });
    expect(r.status).toBe('batch_accepted');
    if (r.status === 'batch_accepted') {
      const first = r.results[0];
      expect(first?.status).toBe('rejected');
      if (first?.status === 'rejected') expect(first.code).toBe('state_transition_invalid');
    }
  });

  it('legal transition chain within a single batch: CLOCK_IN → START_BREAK → END_BREAK → CLOCK_OUT', async () => {
    const in1 = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    const start = await signedEvent(ctx, {
      event_type: 'USER_START_BREAK',
      sequence_number: 2,
      payload: { break_kind: 'bio' },
    });
    const end = await signedEvent(ctx, { event_type: 'USER_END_BREAK', sequence_number: 3 });
    const out = await signedEvent(ctx, { event_type: 'USER_CLOCK_OUT', sequence_number: 4 });
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [in1, start, end, out],
    });
    expect(r.status).toBe('batch_accepted');
    if (r.status === 'batch_accepted') {
      expect(r.results.every((x) => x.status === 'accepted')).toBe(true);
      expect(r.sessionClosedWith).toBe('user_clock_out');
    }
  });

  it('accepts a mixed batch: [accepted, duplicate_noop, rejected] per event', async () => {
    // First send seq 1 so we can retry it
    const in1 = await signedEvent(ctx, { event_type: 'USER_CLOCK_IN', sequence_number: 1 });
    await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [in1],
    });
    const seq2 = await signedEvent(ctx, {
      event_type: 'INPUT_ACTIVITY',
      sequence_number: 2,
      origin: 'system_watcher',
    });
    const seq1Retry = in1; // identical bytes -> duplicate_noop
    const badSig = await signedEvent(
      ctx,
      { event_type: 'INPUT_ACTIVITY', sequence_number: 3, origin: 'system_watcher' },
      new Uint8Array(64).fill(0x77),
    );
    const r = await ingestBatch({
      db: ctx.db,
      authOid: ctx.userOid,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      correlationId: ctx.correlationId,
      events: [seq2, seq1Retry, badSig],
    });
    expect(r.status).toBe('batch_accepted');
    if (r.status === 'batch_accepted') {
      expect(r.results[0]?.status).toBe('accepted');
      expect(r.results[1]?.status).toBe('duplicate_noop');
      expect(r.results[2]?.status).toBe('rejected');
    }
  });
});
