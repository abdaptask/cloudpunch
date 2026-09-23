import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrations/runner.js';
import { PostgresDb } from './db.js';
import { createPostgresClient } from './pool.js';

/**
 * Integration tests that exercise the PostgresDb against a real
 * Postgres container. Mirrors the semantic assertions in
 * `../in-memory.test.ts` and verifies that the SQL layer enforces the
 * same invariants (unique-open session, sequence uniqueness, ULID
 * idempotency, append-only triggers).
 *
 * Requires Docker; runs only under `pnpm test:integration`.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'db',
  'migrations',
);

let container: StartedPostgreSqlContainer;
let sql: postgres.Sql;
let db: PostgresDb;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const bootstrap = postgres(container.getConnectionUri(), { onnotice: () => undefined });
  await migrate({ sql: bootstrap, migrationsDir: MIGRATIONS_DIR });
  await bootstrap.end();

  sql = createPostgresClient(container.getConnectionUri());
  db = new PostgresDb(sql);
});

afterAll(async () => {
  if (sql) await sql.end();
  if (container) await container.stop();
});

beforeEach(async () => {
  // Clean data between tests but keep the schema. Order matters — FK
  // dependencies: event → session → device/employee → user.
  await sql`DELETE FROM audit_log`;
  // time_event trigger blocks DELETE; use TRUNCATE which is DDL.
  await sql`TRUNCATE time_event, time_session, device, employee_override RESTART IDENTITY CASCADE`;
  await sql`DELETE FROM admin_review_case`;
  await sql`UPDATE app_user SET employee_id = NULL`;
  await sql`DELETE FROM employee`;
  await sql`DELETE FROM app_user`;
  await sql`DELETE FROM department`;
});

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

async function seedEmployee(
  emp: {
    id?: string;
    status?: 'active' | 'inactive' | 'terminated' | 'on_leave';
  } = {},
): Promise<string> {
  const id = emp.id ?? randomUUID();
  await sql`
    INSERT INTO employee (id, source, given_name, family_name, status)
    VALUES (${id}, 'local_admin', 'Alice', 'Test', ${emp.status ?? 'active'})
  `;
  return id;
}

async function seedUser(opts: { employeeId?: string | null; oid?: string } = {}): Promise<{
  userId: string;
  oid: string;
}> {
  const userId = randomUUID();
  const oid = opts.oid ?? randomUUID();
  await sql`
    INSERT INTO app_user (id, entra_object_id, work_email, display_name, employee_id)
    VALUES (${userId}, ${oid}, ${'alice@aptask.com'}, ${'Alice Test'}, ${opts.employeeId ?? null})
  `;
  return { userId, oid };
}

// ---------------------------------------------------------------------
// employees + users
// ---------------------------------------------------------------------

describe('PostgresDb — employees + users', () => {
  it('findByEntraObjectId resolves user → employee', async () => {
    const empId = await seedEmployee();
    const { oid } = await seedUser({ employeeId: empId });
    const found = await db.employees.findByEntraObjectId(oid);
    expect(found?.id).toBe(empId);
  });

  it('returns null for unknown oid', async () => {
    expect(await db.employees.findByEntraObjectId(randomUUID())).toBeNull();
    expect(await db.users.findByEntraObjectId(randomUUID())).toBeNull();
  });
});

// ---------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------

describe('PostgresDb — devices', () => {
  const pk = new Uint8Array(32).fill(0x11);

  it('enroll creates a new device', async () => {
    const { userId } = await seedUser();
    const d = await db.devices.enroll({
      id: randomUUID(),
      userId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: pk,
      appVersion: '0.1.0',
    });
    expect(d.userId).toBe(userId);
    expect(d.publicKeyEd25519).toEqual(pk);
    expect(d.revokedAt).toBeNull();
  });

  it('re-enrollment by same user refreshes key + version', async () => {
    const { userId } = await seedUser();
    const id = randomUUID();
    const first = await db.devices.enroll({
      id,
      userId,
      os: 'macos',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: pk,
      appVersion: '0.1.0',
    });
    const newPk = new Uint8Array(32).fill(0x22);
    const second = await db.devices.enroll({
      id,
      userId,
      os: 'macos',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: newPk,
      appVersion: '0.1.1',
    });
    expect(second.enrolledAt.getTime()).toBe(first.enrolledAt.getTime());
    expect(second.publicKeyEd25519).toEqual(newPk);
    expect(second.appVersion).toBe('0.1.1');
  });

  it('rejects re-enrollment by a different user', async () => {
    const { userId: u1 } = await seedUser();
    const { userId: u2 } = await seedUser({ oid: randomUUID() });
    const id = randomUUID();
    await db.devices.enroll({
      id,
      userId: u1,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: pk,
      appVersion: '0.1.0',
    });
    await expect(
      db.devices.enroll({
        id,
        userId: u2,
        os: 'windows',
        hostnameHash: 'sha256-' + '0'.repeat(64),
        publicKeyEd25519: pk,
        appVersion: '0.1.0',
      }),
    ).rejects.toThrow(/different user/);
  });

  it('revoke is idempotent — second revoke does not change the fields', async () => {
    const { userId } = await seedUser();
    const id = randomUUID();
    await db.devices.enroll({
      id,
      userId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: pk,
      appVersion: '0.1.0',
    });
    const firstAt = new Date(Date.now() - 60_000);
    await db.devices.revoke(id, 'first', userId, firstAt);
    await db.devices.revoke(id, 'second', userId, new Date());
    const d = await db.devices.findById(id);
    expect(d?.revokedReason).toBe('first');
    expect(d?.revokedAt?.getTime()).toBe(firstAt.getTime());
  });
});

// ---------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------

describe('PostgresDb — sessions', () => {
  it('open creates and findOpenByEmployeeId returns it', async () => {
    const empId = await seedEmployee();
    const { userId } = await seedUser({ employeeId: empId });
    const device = await db.devices.enroll({
      id: randomUUID(),
      userId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: new Uint8Array(32),
      appVersion: '0.1.0',
    });
    const s = await db.timeSessions.open({
      id: randomUUID(),
      employeeId: empId,
      deviceId: device.id,
      openedAt: new Date(),
    });
    expect(s.closedAt).toBeNull();
    const found = await db.timeSessions.findOpenByEmployeeId(empId);
    expect(found?.id).toBe(s.id);
  });

  it('unique partial index blocks a second open session per employee', async () => {
    const empId = await seedEmployee();
    const { userId } = await seedUser({ employeeId: empId });
    const device = await db.devices.enroll({
      id: randomUUID(),
      userId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: new Uint8Array(32),
      appVersion: '0.1.0',
    });
    await db.timeSessions.open({
      id: randomUUID(),
      employeeId: empId,
      deviceId: device.id,
      openedAt: new Date(),
    });
    await expect(
      db.timeSessions.open({
        id: randomUUID(),
        employeeId: empId,
        deviceId: device.id,
        openedAt: new Date(),
      }),
    ).rejects.toThrow(/23505|duplicate/i);
  });

  it('open with an existing id returns the existing session (idempotent USER_CLOCK_IN)', async () => {
    const empId = await seedEmployee();
    const { userId } = await seedUser({ employeeId: empId });
    const device = await db.devices.enroll({
      id: randomUUID(),
      userId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: new Uint8Array(32),
      appVersion: '0.1.0',
    });
    const sid = randomUUID();
    const first = await db.timeSessions.open({
      id: sid,
      employeeId: empId,
      deviceId: device.id,
      openedAt: new Date(),
    });
    const second = await db.timeSessions.open({
      id: sid,
      employeeId: empId,
      deviceId: device.id,
      openedAt: new Date(),
    });
    expect(second.id).toBe(first.id);
    expect(second.openedAt.getTime()).toBe(first.openedAt.getTime());
  });

  it('close is idempotent', async () => {
    const empId = await seedEmployee();
    const { userId } = await seedUser({ employeeId: empId });
    const device = await db.devices.enroll({
      id: randomUUID(),
      userId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: new Uint8Array(32),
      appVersion: '0.1.0',
    });
    const s = await db.timeSessions.open({
      id: randomUUID(),
      employeeId: empId,
      deviceId: device.id,
      openedAt: new Date(),
    });
    const closedAt = new Date();
    await db.timeSessions.close(s.id, closedAt, 'user_clock_out');
    await db.timeSessions.close(s.id, new Date(), 'idle_auto_clock_out');
    const reread = await db.timeSessions.findById(s.id);
    expect(reread?.closedReason).toBe('user_clock_out');
    expect(reread?.closedAt?.getTime()).toBe(closedAt.getTime());
  });
});

// ---------------------------------------------------------------------
// events
// ---------------------------------------------------------------------

describe('PostgresDb — events', () => {
  const sig = new Uint8Array(64).fill(0x01);

  async function makeSession() {
    const empId = await seedEmployee();
    const { userId } = await seedUser({ employeeId: empId });
    const device = await db.devices.enroll({
      id: randomUUID(),
      userId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: new Uint8Array(32),
      appVersion: '0.1.0',
    });
    const s = await db.timeSessions.open({
      id: randomUUID(),
      employeeId: empId,
      deviceId: device.id,
      openedAt: new Date(),
    });
    return { empId, deviceId: device.id, sessionId: s.id };
  }

  it('accepts first insert', async () => {
    const { empId, deviceId, sessionId } = await makeSession();
    const r = await db.timeEvents.insertOne({
      eventUlid: '01J8Q00000000000000000000A',
      eventType: 'USER_CLOCK_IN',
      sessionId,
      employeeId: empId,
      sequenceNumber: 1,
      clientTs: new Date(),
      monotonicNs: 0,
      tzIana: 'Asia/Kolkata',
      utcOffsetMinutes: 330,
      deviceId,
      appVersion: '0.1.0',
      origin: 'user',
      offlineCaptured: false,
      payload: {},
      integritySignature: sig,
      correlationId: randomUUID(),
      parentEventUlid: null,
    });
    expect(r.status).toBe('accepted');
  });

  it('is idempotent on duplicate ULID with same signature', async () => {
    const { empId, deviceId, sessionId } = await makeSession();
    const evt = {
      eventUlid: '01J8Q00000000000000000000A',
      eventType: 'USER_CLOCK_IN',
      sessionId,
      employeeId: empId,
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
      integritySignature: sig,
      correlationId: randomUUID(),
      parentEventUlid: null,
    };
    await db.timeEvents.insertOne(evt);
    const r = await db.timeEvents.insertOne(evt);
    expect(r.status).toBe('duplicate_noop');
  });

  it('flags duplicate_ulid_different_payload', async () => {
    const { empId, deviceId, sessionId } = await makeSession();
    const evt = {
      eventUlid: '01J8Q00000000000000000000A',
      eventType: 'USER_CLOCK_IN',
      sessionId,
      employeeId: empId,
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
      integritySignature: sig,
      correlationId: randomUUID(),
      parentEventUlid: null,
    };
    await db.timeEvents.insertOne(evt);
    const r = await db.timeEvents.insertOne({
      ...evt,
      integritySignature: new Uint8Array(64).fill(0x02),
    });
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.code).toBe('duplicate_ulid_different_payload');
  });

  it('rejects duplicate (session, sequence)', async () => {
    const { empId, deviceId, sessionId } = await makeSession();
    const evtA = {
      eventUlid: '01J8Q00000000000000000000A',
      eventType: 'USER_CLOCK_IN',
      sessionId,
      employeeId: empId,
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
      integritySignature: sig,
      correlationId: randomUUID(),
      parentEventUlid: null,
    };
    await db.timeEvents.insertOne(evtA);
    const r = await db.timeEvents.insertOne({
      ...evtA,
      eventUlid: '01J8Q00000000000000000000B',
    });
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.code).toBe('duplicate_sequence');
  });

  it('findMaxSequenceForSession tracks the max', async () => {
    const { empId, deviceId, sessionId } = await makeSession();
    for (const seq of [1, 3, 2]) {
      await db.timeEvents.insertOne({
        eventUlid: `01J8Q0000000000000000000${(seq + 0x40).toString(16).padStart(2, '0').toUpperCase()}`,
        eventType: 'USER_CLOCK_IN',
        sessionId,
        employeeId: empId,
        sequenceNumber: seq,
        clientTs: new Date(),
        monotonicNs: 0,
        tzIana: 'Asia/Kolkata',
        utcOffsetMinutes: 330,
        deviceId,
        appVersion: '0.1.0',
        origin: 'user',
        offlineCaptured: false,
        payload: {},
        integritySignature: sig,
        correlationId: randomUUID(),
        parentEventUlid: null,
      });
    }
    expect(await db.timeEvents.findMaxSequenceForSession(sessionId)).toBe(3);
  });
});
