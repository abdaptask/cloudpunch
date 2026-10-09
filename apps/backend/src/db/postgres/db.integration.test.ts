import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrations/runner.js';
import { CorrectionDecisionConflictError } from '../types.js';
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
  // time_event and audit_log are append-only (row triggers reject
  // DELETE); TRUNCATE is DDL and resets them between tests.
  await sql`TRUNCATE audit_log, policy_override, time_event, time_session, device, employee_override, time_correction_decision, time_correction, shift_assignment, not_working_day, holiday, shift_alert RESTART IDENTITY CASCADE`;
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

  it('ADR-0025: sets a manager (audited), lists reports and active people, audits views', async () => {
    const mgr = await seedEmployee();
    const a = await seedEmployee();
    const gone = await seedEmployee({ status: 'terminated' });
    const { userId } = await seedUser({ employeeId: mgr });
    for (const id of [a, gone]) {
      await db.employees.setReportingManager({
        employeeId: id,
        managerId: mgr,
        actorUserId: userId,
        reason: 'pilot team',
        correlationId: randomUUID(),
        at: new Date(),
      });
    }
    expect((await db.employees.findById(a))?.reportingManagerId).toBe(mgr);
    expect((await db.employees.listReports(mgr)).map((e) => e.id)).toEqual([a]);
    expect((await db.employees.listActive()).map((e) => e.id).sort()).toEqual([mgr, a].sort());

    await db.employees.auditView({
      actorUserId: userId,
      employeeId: a,
      action: 'day_viewed',
      detail: { date: '2026-09-29' },
      correlationId: randomUUID(),
      at: new Date(),
    });
    // The client camelCases column names.
    const rows = await sql<{ action: string; before: unknown; after: unknown }[]>`
      SELECT action, previous_value AS before, new_value AS after FROM audit_log
      WHERE entity_type = 'employee' AND entity_id = ${a} ORDER BY occurred_at`;
    expect(rows.map((r) => r.action)).toEqual(['reporting_manager_set', 'day_viewed']);
    expect(rows[0]?.before).toEqual({ manager_employee_id: null });
    expect(rows[0]?.after).toEqual({ manager_employee_id: mgr });
    expect(rows[1]?.after).toEqual({ date: '2026-09-29' });
  });

  it('ADR-0020 §4: a record turned off frees its reports (audited); turned on again', async () => {
    const mgr = await seedEmployee();
    const a = await seedEmployee();
    const { userId } = await seedUser({ employeeId: mgr });
    const base = {
      actorUserId: userId,
      reason: 'left',
      correlationId: randomUUID(),
      at: new Date(),
    };
    await db.employees.setReportingManager({ ...base, employeeId: a, managerId: mgr });

    const off = await db.people.setRecordActive({ ...base, employeeId: mgr, active: false });
    expect(off).toEqual({ changed: true, unassigned: [{ id: a, name: 'Alice Test' }] });
    expect((await db.employees.findById(mgr))?.status).toBe('inactive');
    expect((await db.employees.findById(a))?.reportingManagerId).toBeNull();
    expect((await db.employees.listActive()).map((e) => e.id)).toEqual([a]);
    // Already off: nothing more.
    expect(await db.people.setRecordActive({ ...base, employeeId: mgr, active: false })).toEqual({
      changed: false,
      unassigned: [],
    });

    expect(await db.people.setRecordActive({ ...base, employeeId: mgr, active: true })).toEqual({
      changed: true,
      unassigned: [],
    });
    expect((await db.employees.findById(mgr))?.status).toBe('active');

    const rows = await sql<{ entityId: string; action: string; after: unknown }[]>`
      SELECT entity_id, action, new_value AS after FROM audit_log
      WHERE entity_type = 'employee'`;
    // One timestamp for all four, so compared as a set.
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => [r.entityId, r.action, r.after])).toEqual(
      expect.arrayContaining([
        [a, 'reporting_manager_set', { manager_employee_id: mgr }],
        [mgr, 'status_set', { status: 'inactive' }],
        [a, 'reporting_manager_set', { manager_employee_id: null }],
        [mgr, 'status_set', { status: 'active' }],
      ]),
    );
  });

  it('a terminated record is left alone', async () => {
    const gone = await seedEmployee({ status: 'terminated' });
    const { userId } = await seedUser({ employeeId: gone });
    const base = { actorUserId: userId, reason: null, correlationId: randomUUID(), at: new Date() };
    for (const active of [true, false]) {
      expect(await db.people.setRecordActive({ ...base, employeeId: gone, active })).toMatchObject({
        changed: false,
      });
    }
    expect((await db.employees.findById(gone))?.status).toBe('terminated');
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

  it('touchLastSeen records the version the device now runs (ADR-0025 §3)', async () => {
    const { userId } = await seedUser();
    const d = await db.devices.enroll({
      id: randomUUID(),
      userId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: pk,
      appVersion: '0.1.0',
    });
    await db.devices.touchLastSeen(d.id, new Date(), '0.1.4');
    expect((await db.devices.findById(d.id))?.appVersion).toBe('0.1.4');
    await db.devices.touchLastSeen(d.id, new Date());
    expect((await db.devices.findById(d.id))?.appVersion).toBe('0.1.4');
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

  it('ADR-0028: signOut closes the open session, marks the device, audits; clearSignOut undoes the mark', async () => {
    const empId = await seedEmployee();
    const { userId } = await seedUser({ employeeId: empId });
    const { userId: adminId } = await seedUser({ oid: randomUUID() });
    const d = await db.devices.enroll({
      id: randomUUID(),
      userId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: pk,
      appVersion: '0.1.8',
    });
    expect(d.signoutRequestedAt).toBeNull();
    const openedAt = new Date(Date.now() - 3 * 3600_000);
    const s = await db.timeSessions.open({ employeeId: empId, deviceId: d.id, openedAt });
    const closedAt = new Date(Date.now() - 3600_000);
    const at = new Date();
    const input = {
      deviceId: d.id,
      employeeId: empId,
      sessionId: s.id,
      closedAt,
      actorUserId: adminId,
      correlationId: randomUUID(),
      at,
    };

    expect(await db.devices.signOut(input)).toEqual({ closedAt });
    expect(await db.timeSessions.findById(s.id)).toMatchObject({
      closedAt,
      closedReason: 'remote_takeover',
      reconstructed: true,
    });
    const marked = await db.devices.findById(d.id);
    expect(marked?.signoutRequestedAt?.getTime()).toBe(at.getTime());
    expect(marked?.signoutRequestedBy).toBe(adminId);
    const rows = await sql<{ actorUserId: string; action: string; after: unknown }[]>`
      SELECT actor_user_id, action, new_value AS after FROM audit_log
      WHERE entity_type = 'device' AND entity_id = ${d.id}`;
    expect(rows).toEqual([
      {
        actorUserId: adminId,
        action: 'device_signed_out',
        after: { employee_id: empId, session_id: s.id, closed_at: closedAt.toISOString() },
      },
    ]);

    // Repeating: the session is already closed, so nothing more closes.
    expect(await db.devices.signOut({ ...input, correlationId: randomUUID() })).toEqual({
      closedAt: null,
    });

    await db.devices.clearSignOut(d.id);
    const cleared = await db.devices.findById(d.id);
    expect(cleared?.signoutRequestedAt).toBeNull();
    expect(cleared?.signoutRequestedBy).toBeNull();
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

  it('findByEmployeeOpenedBetween returns only that employee in [from, to), oldest first', async () => {
    const empId = await seedEmployee();
    const otherId = await seedEmployee();
    const { userId } = await seedUser({ employeeId: empId });
    const device = await db.devices.enroll({
      id: randomUUID(),
      userId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: new Uint8Array(32),
      appVersion: '0.1.0',
    });
    const at = (iso: string) => new Date(iso);
    const openClosed = async (employeeId: string, openedAt: Date) => {
      const s = await db.timeSessions.open({ employeeId, deviceId: device.id, openedAt });
      await db.timeSessions.close(s.id, new Date(openedAt.getTime() + 3_600_000), 'user_clock_out');
      return s.id;
    };
    const late = await openClosed(empId, at('2026-09-25T18:30:00Z'));
    const early = await openClosed(empId, at('2026-09-25T09:00:00Z'));
    await openClosed(empId, at('2026-09-26T00:00:00Z')); // at `to`: excluded
    await openClosed(empId, at('2026-09-24T23:59:59Z')); // before `from`
    await openClosed(otherId, at('2026-09-25T10:00:00Z'));
    const found = await db.timeSessions.findByEmployeeOpenedBetween(
      empId,
      at('2026-09-25T00:00:00Z'),
      at('2026-09-26T00:00:00Z'),
    );
    expect(found.map((s) => s.id)).toEqual([early, late]);
    expect(found[0]?.closedReason).toBe('user_clock_out');
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

  it('returns payload keys exactly as stored (no camelCasing inside jsonb)', async () => {
    const { empId, deviceId, sessionId } = await makeSession();
    await db.timeEvents.insertOne({
      eventUlid: '01J8Q00000000000000000000P',
      eventType: 'USER_START_BREAK',
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
      payload: { break_kind: 'meal', note: null },
      integritySignature: sig,
      correlationId: randomUUID(),
      parentEventUlid: null,
    });
    const [evt] = await db.timeEvents.findBySessionOrderedBySequence(sessionId);
    expect(evt?.payload).toEqual({ break_kind: 'meal', note: null });
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

// ---------------------------------------------------------------------
// device connections (ADR-0029)
// ---------------------------------------------------------------------

describe('PostgresDb — device connections', () => {
  async function seedDevice() {
    const employeeId = await seedEmployee();
    const { userId } = await seedUser({ employeeId });
    const device = await db.devices.enroll({
      id: randomUUID(),
      userId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: new Uint8Array(32).fill(7),
      appVersion: '0.1.11',
    });
    return { employeeId, deviceId: device.id };
  }

  it('inserts, finds the latest and only moves last_seen_at forward', async () => {
    const { employeeId, deviceId } = await seedDevice();
    const t0 = new Date('2026-10-01T09:00:00Z');
    const t1 = new Date('2026-10-01T10:00:00Z');
    const base = {
      employeeId,
      deviceId,
      city: 'Pune',
      region: 'Maharashtra',
      country: 'IN',
      asn: null,
      provider: null,
    };
    await db.connections.insert({ ...base, ip: '58.84.61.202', firstSeenAt: t0, lastSeenAt: t0 });
    const v6 = await db.connections.insert({
      ...base,
      ip: '2402:e280:3e8f:1d7:4db:8a24:7d9e:5c4',
      firstSeenAt: t1,
      lastSeenAt: t1,
    });
    expect(v6.ip).toBe('2402:e280:3e8f:1d7:4db:8a24:7d9e:5c4');

    expect(await db.connections.latestForDevice(deviceId)).toEqual(v6);
    await db.connections.touch(v6.id, t0); // earlier: ignored
    expect((await db.connections.latestForDevice(deviceId))?.lastSeenAt).toEqual(t1);
    const t2 = new Date('2026-10-01T10:15:00Z');
    await db.connections.touch(v6.id, t2);
    expect((await db.connections.latestForDevice(deviceId))?.lastSeenAt).toEqual(t2);
    expect(await db.connections.latestForDevice(randomUUID())).toBeNull();
  });

  it("lists an employee's connections since a date, and each one's latest", async () => {
    const one = await seedDevice();
    const two = await seedDevice();
    const row = (who: { employeeId: string; deviceId: string }, ip: string, at: string) => ({
      ...who,
      ip,
      city: null,
      region: null,
      country: 'IN',
      asn: 134674,
      provider: 'Tata Play Broadband Private Limited',
      firstSeenAt: new Date(at),
      lastSeenAt: new Date(at),
    });
    await db.connections.insert(row(one, '1.1.1.1', '2026-08-01T00:00:00Z'));
    await db.connections.insert(row(one, '2.2.2.2', '2026-09-20T00:00:00Z'));
    await db.connections.insert(row(one, '3.3.3.3', '2026-09-30T00:00:00Z'));
    await db.connections.insert(row(two, '4.4.4.4', '2026-09-25T00:00:00Z'));
    const since = new Date('2026-09-01T00:00:00Z');

    const list = await db.connections.listForEmployee(one.employeeId, since);
    expect(list.map((c) => c.ip)).toEqual(['3.3.3.3', '2.2.2.2']);

    const latest = await db.connections.latestForEmployees(
      [one.employeeId, two.employeeId, randomUUID()],
      since,
    );
    expect(latest.get(one.employeeId)?.ip).toBe('3.3.3.3');
    expect(latest.get(two.employeeId)?.provider).toBe('Tata Play Broadband Private Limited');
    expect(latest.size).toBe(2);
    expect((await db.connections.latestForEmployees([], since)).size).toBe(0);
  });

  it('rejects a malformed country code', async () => {
    const { employeeId, deviceId } = await seedDevice();
    const at = new Date();
    await expect(
      db.connections.insert({
        employeeId,
        deviceId,
        ip: '1.2.3.4',
        city: null,
        region: null,
        country: 'india',
        asn: null,
        provider: null,
        firstSeenAt: at,
        lastSeenAt: at,
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------
// time corrections (ADR-0030)
// ---------------------------------------------------------------------

describe('PostgresDb — time corrections', () => {
  it('stores a manager correction endorsed, audits it, one final decision only', async () => {
    const employeeId = await seedEmployee();
    const { userId: mgr } = await seedUser();
    const { userId: admin } = await seedUser();
    const at = new Date('2026-10-07T15:00:00Z');
    const c = await db.corrections.request({
      employeeId,
      fromAt: new Date('2026-10-05T12:00:00Z'),
      toAt: new Date('2026-10-05T20:00:00Z'),
      tzIana: 'Asia/Kolkata',
      utcOffsetMinutes: 330,
      kind: 'working',
      reason: 'App did not record the day',
      requestedByUserId: mgr,
      endorse: true,
      correlationId: randomUUID(),
      at,
    });
    expect(c.decisions.map((d) => d.decision)).toEqual(['endorsed']);
    expect((await db.corrections.listOpen()).map((x) => x.id)).toEqual([c.id]);

    const decide = (decision: 'endorsed' | 'approved' | 'rejected', by: string) =>
      db.corrections.decide({
        correctionId: c.id,
        employeeId,
        decision,
        decidedByUserId: by,
        note: 'ok',
        correlationId: randomUUID(),
        at,
      });
    await expect(decide('endorsed', admin)).rejects.toBeInstanceOf(CorrectionDecisionConflictError);
    await decide('approved', admin);
    await expect(decide('rejected', admin)).rejects.toBeInstanceOf(CorrectionDecisionConflictError);
    expect(await db.corrections.listOpen()).toEqual([]);
    const found = await db.corrections.findById(c.id);
    expect(found?.decisions.map((d) => d.decision)).toEqual(['endorsed', 'approved']);
    expect(found?.fromAt.toISOString()).toBe('2026-10-05T12:00:00.000Z');

    const audit = await sql<{ action: string }[]>`
      SELECT action FROM audit_log WHERE entity_type = 'time_correction'`;
    expect(audit.map((a) => a.action).sort()).toEqual([
      'correction_approved',
      'correction_requested',
    ]);

    const listed = await db.corrections.listForEmployee(
      employeeId,
      new Date('2026-10-05T00:00:00Z'),
      new Date('2026-10-06T00:00:00Z'),
    );
    expect(listed.map((x) => x.id)).toEqual([c.id]);
  });

  it('both tables are append-only and keep their limits', async () => {
    const employeeId = await seedEmployee();
    const { userId } = await seedUser();
    const c = await db.corrections.request({
      employeeId,
      fromAt: new Date('2026-10-05T12:00:00Z'),
      toAt: new Date('2026-10-05T13:00:00Z'),
      tzIana: 'Asia/Kolkata',
      utcOffsetMinutes: 330,
      kind: 'working',
      reason: 'x',
      requestedByUserId: userId,
      endorse: false,
      correlationId: randomUUID(),
      at: new Date(),
    });
    // Planted on purpose: the triggers must refuse these.
    await expect(sql`UPDATE time_correction SET reason = 'y' WHERE id = ${c.id}`).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`DELETE FROM time_correction WHERE id = ${c.id}`).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`DELETE FROM time_correction_decision`).rejects.toThrow(/append-only/);
    // More than 16 hours, or a blank reason: refused.
    const bad = (from: string, to: string, reason: string) =>
      db.corrections.request({
        employeeId,
        fromAt: new Date(from),
        toAt: new Date(to),
        tzIana: 'Asia/Kolkata',
        utcOffsetMinutes: 330,
        kind: 'working',
        reason,
        requestedByUserId: userId,
        endorse: false,
        correlationId: randomUUID(),
        at: new Date(),
      });
    await expect(bad('2026-10-05T00:00:00Z', '2026-10-05T16:00:01Z', 'x')).rejects.toThrow();
    await expect(bad('2026-10-05T00:00:00Z', '2026-10-05T01:00:00Z', '  ')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------
// shifts (ADR-0031)
// ---------------------------------------------------------------------

describe('PostgresDb — shifts', () => {
  it('assigns (audited), lists newest first, and records "not working" once', async () => {
    const employeeId = await seedEmployee();
    const { userId } = await seedUser();
    const base = {
      employeeId,
      tzIana: 'Asia/Kolkata',
      reason: null,
      assignedByUserId: userId,
      correlationId: randomUUID(),
    };
    await db.shifts.assign({
      ...base,
      days: [1, 2, 3, 4, 5],
      start: '12:00',
      end: '21:00',
      effectiveFrom: '2026-10-01',
      at: new Date('2026-10-01T00:00:00Z'),
    });
    const later = await db.shifts.assign({
      ...base,
      days: [],
      start: null,
      end: null,
      effectiveFrom: '2026-10-08',
      at: new Date('2026-10-08T00:00:00Z'),
    });
    expect(later).toMatchObject({ days: [], start: null, end: null, effectiveFrom: '2026-10-08' });
    const rows = await db.shifts.history([employeeId]);
    expect(rows.map((r) => [r.effectiveFrom, r.start, r.end, r.days])).toEqual([
      ['2026-10-08', null, null, []],
      ['2026-10-01', '12:00', '21:00', [1, 2, 3, 4, 5]],
    ]);

    const declare = () =>
      db.shifts.declareNotWorking({
        employeeId,
        shiftDate: '2026-10-05',
        declaredByUserId: userId,
        correlationId: randomUUID(),
        at: new Date(),
      });
    expect(await declare()).toBe(true);
    expect(await declare()).toBe(false);
    expect(await db.shifts.notWorking([employeeId], ['2026-10-05', '2026-10-06'])).toEqual(
      new Set([`${employeeId}:2026-10-05`]),
    );

    const audit = await sql<{ action: string }[]>`
      SELECT action FROM audit_log WHERE entity_id = ${employeeId} ORDER BY action`;
    expect(audit.map((a) => a.action)).toEqual([
      'not_working_declared',
      'shift_assigned',
      'shift_assigned',
    ]);
  });

  it('both tables are append-only, and a shift needs a start and a different end', async () => {
    const employeeId = await seedEmployee();
    const { userId } = await seedUser();
    const bad = (start: string | null, end: string | null) =>
      db.shifts.assign({
        employeeId,
        days: [1],
        start,
        end,
        tzIana: 'UTC',
        effectiveFrom: '2026-10-01',
        reason: null,
        assignedByUserId: userId,
        correlationId: randomUUID(),
        at: new Date(),
      });
    await expect(bad('09:00', null)).rejects.toThrow();
    await expect(bad('09:00', '09:00')).rejects.toThrow();
    await bad('09:00', '17:00');
    // Planted on purpose: the triggers must refuse these.
    await expect(sql`UPDATE shift_assignment SET tz_iana = 'UTC'`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM not_working_day`).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------
// holidays (ADR-0037)
// ---------------------------------------------------------------------

describe('PostgresDb — holidays', () => {
  it('the latest row per date wins, removals drop out, and changes are audited', async () => {
    const { userId } = await seedUser();
    const add = (date: string, name: string, cancelled: boolean, at: string) =>
      db.holidays.record({
        date,
        name,
        cancelled,
        addedByUserId: userId,
        correlationId: randomUUID(),
        at: new Date(at),
      });
    expect(await add('2026-11-09', 'Diwali', false, '2026-10-01T00:00:00Z')).toMatchObject({
      date: '2026-11-09',
      name: 'Diwali',
      cancelled: false,
    });
    await add('2026-11-09', 'Diwali (Lakshmi Puja)', false, '2026-10-02T00:00:00Z');
    await add('2026-12-25', 'Christmas', false, '2026-10-01T00:00:00Z');
    await add('2026-12-25', 'Christmas', true, '2026-10-03T00:00:00Z');
    await add('2027-01-26', 'Republic Day', false, '2026-10-01T00:00:00Z');

    const list = await db.holidays.between('2026-11-01', '2026-12-31');
    expect(list.map((h) => [h.date, h.name])).toEqual([['2026-11-09', 'Diwali (Lakshmi Puja)']]);

    const audit = await sql<{ action: string }[]>`
      SELECT action FROM audit_log WHERE entity_type = 'holiday' ORDER BY occurred_at, action`;
    expect(audit.map((a) => a.action)).toEqual([
      'holiday_added',
      'holiday_added',
      'holiday_added',
      'holiday_added',
      'holiday_removed',
    ]);
    // Planted on purpose: the triggers must refuse these.
    await expect(sql`UPDATE holiday SET name = 'x'`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM shift_alert`).rejects.toThrow(/append-only/);
  });
});
