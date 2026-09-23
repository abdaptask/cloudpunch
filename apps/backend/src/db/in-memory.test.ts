import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryDb, SessionOpenConflictError } from './in-memory.js';
import type { AppUser, Employee } from './types.js';

const mkEmployee = (id: string = randomUUID(), overrides: Partial<Employee> = {}): Employee => ({
  id,
  source: 'local_admin',
  greythrEmployeeId: null,
  employeeNumber: null,
  givenName: 'Alice',
  familyName: 'Test',
  displayName: null,
  workEmail: 'alice@aptask.com',
  status: 'active',
  ...overrides,
});

const mkUser = (employeeId: string | null, overrides: Partial<AppUser> = {}): AppUser => ({
  id: randomUUID(),
  entraObjectId: randomUUID(),
  workEmail: 'alice@aptask.com',
  displayName: 'Alice Test',
  isServiceAccount: false,
  breakGlass: false,
  employeeId,
  ...overrides,
});

let db: InMemoryDb;
beforeEach(() => {
  db = new InMemoryDb();
});

describe('InMemoryDb — employees + users', () => {
  it('findByEntraObjectId resolves through the user table', async () => {
    const emp = mkEmployee();
    const user = mkUser(emp.id);
    db.seedEmployee(emp).seedUser(user);
    const found = await db.employees.findByEntraObjectId(user.entraObjectId);
    expect(found?.id).toBe(emp.id);
  });

  it('returns null for unknown oid', async () => {
    expect(await db.employees.findByEntraObjectId('unknown')).toBeNull();
    expect(await db.users.findByEntraObjectId('unknown')).toBeNull();
  });
});

describe('InMemoryDb — devices', () => {
  const userId = randomUUID();
  const pk = new Uint8Array(32).fill(0x11);

  it('enroll creates a new device', async () => {
    const d = await db.devices.enroll({
      id: randomUUID(),
      userId,
      os: 'windows',
      hostnameHash: 'sha256-abc',
      publicKeyEd25519: pk,
      appVersion: '0.1.0',
    });
    expect(d.userId).toBe(userId);
    expect(d.revokedAt).toBeNull();
    expect(d.enrolledAt).toBeInstanceOf(Date);
  });

  it('re-enrollment by same user refreshes key + version, preserves enrolled_at', async () => {
    const id = randomUUID();
    const first = await db.devices.enroll({
      id,
      userId,
      os: 'windows',
      hostnameHash: 'h1',
      publicKeyEd25519: pk,
      appVersion: '0.1.0',
    });
    await new Promise((r) => setTimeout(r, 5));
    const newPk = new Uint8Array(32).fill(0x22);
    const second = await db.devices.enroll({
      id,
      userId,
      os: 'windows',
      hostnameHash: 'h1',
      publicKeyEd25519: newPk,
      appVersion: '0.1.1',
    });
    expect(second.enrolledAt).toEqual(first.enrolledAt);
    expect(second.publicKeyEd25519).toEqual(newPk);
    expect(second.appVersion).toBe('0.1.1');
  });

  it('rejects re-enrollment by a different user', async () => {
    const id = randomUUID();
    await db.devices.enroll({
      id,
      userId,
      os: 'macos',
      hostnameHash: 'h1',
      publicKeyEd25519: pk,
      appVersion: '0.1.0',
    });
    await expect(
      db.devices.enroll({
        id,
        userId: randomUUID(),
        os: 'macos',
        hostnameHash: 'h1',
        publicKeyEd25519: pk,
        appVersion: '0.1.0',
      }),
    ).rejects.toThrow(/different user/);
  });

  it('revoke sets triple (revoked_at, revoked_reason, revoked_by_user_id)', async () => {
    const id = randomUUID();
    await db.devices.enroll({
      id,
      userId,
      os: 'windows',
      hostnameHash: 'h1',
      publicKeyEd25519: pk,
      appVersion: '0.1.0',
    });
    const admin = randomUUID();
    await db.devices.revoke(id, 'security_review', admin, new Date());
    const d = await db.devices.findById(id);
    expect(d?.revokedAt).toBeInstanceOf(Date);
    expect(d?.revokedReason).toBe('security_review');
    expect(d?.revokedByUserId).toBe(admin);
  });

  it('revoke is idempotent', async () => {
    const id = randomUUID();
    await db.devices.enroll({
      id,
      userId,
      os: 'windows',
      hostnameHash: 'h1',
      publicKeyEd25519: pk,
      appVersion: '0.1.0',
    });
    const admin = randomUUID();
    const firstRevokedAt = new Date();
    await db.devices.revoke(id, 'first', admin, firstRevokedAt);
    await db.devices.revoke(id, 'second', admin, new Date());
    const d = await db.devices.findById(id);
    expect(d?.revokedReason).toBe('first');
    expect(d?.revokedAt).toEqual(firstRevokedAt);
  });
});

describe('InMemoryDb — sessions', () => {
  const emp = mkEmployee();
  const deviceId = randomUUID();

  beforeEach(() => {
    db.seedEmployee(emp);
  });

  it('open creates a session and findOpenByEmployeeId returns it', async () => {
    const s = await db.timeSessions.open({
      employeeId: emp.id,
      deviceId,
      openedAt: new Date(),
    });
    expect(s.closedAt).toBeNull();
    const found = await db.timeSessions.findOpenByEmployeeId(emp.id);
    expect(found?.id).toBe(s.id);
  });

  it('cannot open a second session while one is open (unique-open invariant)', async () => {
    await db.timeSessions.open({ employeeId: emp.id, deviceId, openedAt: new Date() });
    await expect(
      db.timeSessions.open({ employeeId: emp.id, deviceId, openedAt: new Date() }),
    ).rejects.toBeInstanceOf(SessionOpenConflictError);
  });

  it('close sets closed_at + reason; second close is idempotent', async () => {
    const s = await db.timeSessions.open({
      employeeId: emp.id,
      deviceId,
      openedAt: new Date(),
    });
    const closedAt = new Date();
    const closed = await db.timeSessions.close(s.id, closedAt, 'user_clock_out');
    expect(closed.closedAt).toEqual(closedAt);
    expect(closed.closedReason).toBe('user_clock_out');
    const again = await db.timeSessions.close(s.id, new Date(), 'idle_auto_clock_out');
    expect(again.closedAt).toEqual(closedAt);
    expect(again.closedReason).toBe('user_clock_out');
  });

  it('can open a new session after closing the previous one', async () => {
    const s1 = await db.timeSessions.open({
      employeeId: emp.id,
      deviceId,
      openedAt: new Date(),
    });
    await db.timeSessions.close(s1.id, new Date(), 'user_clock_out');
    const s2 = await db.timeSessions.open({
      employeeId: emp.id,
      deviceId,
      openedAt: new Date(),
    });
    expect(s2.id).not.toBe(s1.id);
  });
});

describe('InMemoryDb — events (idempotency + sequence)', () => {
  const emp = mkEmployee();
  const deviceId = randomUUID();
  let sessionId: string;

  beforeEach(async () => {
    db.seedEmployee(emp);
    const s = await db.timeSessions.open({
      employeeId: emp.id,
      deviceId,
      openedAt: new Date(),
    });
    sessionId = s.id;
  });

  const mkEvent = (overrides: Partial<Parameters<typeof db.timeEvents.insertOne>[0]> = {}) => ({
    eventUlid: '01J8Q00000000000000000000A',
    eventType: 'USER_CLOCK_IN',
    sessionId,
    employeeId: emp.id,
    sequenceNumber: 1,
    clientTs: new Date(),
    monotonicNs: 0,
    tzIana: 'Asia/Kolkata',
    utcOffsetMinutes: 330,
    deviceId,
    appVersion: '0.1.0',
    origin: 'user' as const,
    offlineCaptured: false,
    payload: {},
    integritySignature: new Uint8Array(64).fill(0x01),
    correlationId: randomUUID(),
    parentEventUlid: null,
    ...overrides,
  });

  it('accepts a first insert', async () => {
    const r = await db.timeEvents.insertOne(mkEvent());
    expect(r.status).toBe('accepted');
  });

  it('is idempotent on duplicate ULID with identical signature', async () => {
    const evt = mkEvent();
    await db.timeEvents.insertOne(evt);
    const r = await db.timeEvents.insertOne(evt);
    expect(r.status).toBe('duplicate_noop');
  });

  it('flags duplicate ULID with a different signature', async () => {
    const evt = mkEvent();
    await db.timeEvents.insertOne(evt);
    const r = await db.timeEvents.insertOne({
      ...evt,
      integritySignature: new Uint8Array(64).fill(0x02),
    });
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') {
      expect(r.code).toBe('duplicate_ulid_different_payload');
    }
  });

  it('rejects a duplicate (session_id, sequence_number)', async () => {
    await db.timeEvents.insertOne(mkEvent());
    const r = await db.timeEvents.insertOne(mkEvent({ eventUlid: '01J8Q00000000000000000000B' }));
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.code).toBe('duplicate_sequence');
  });

  it('findMaxSequenceForSession tracks max', async () => {
    await db.timeEvents.insertOne(mkEvent({ sequenceNumber: 1 }));
    await db.timeEvents.insertOne(
      mkEvent({ eventUlid: '01J8Q00000000000000000000B', sequenceNumber: 3 }),
    );
    const max = await db.timeEvents.findMaxSequenceForSession(sessionId);
    expect(max).toBe(3);
  });

  it('findMaxSequenceForSession returns null for an unknown session', async () => {
    expect(await db.timeEvents.findMaxSequenceForSession(randomUUID())).toBeNull();
  });
});
