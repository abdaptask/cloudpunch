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
  await sql`TRUNCATE audit_log, policy_override, time_event, time_session, device, employee_override, time_correction_decision, time_correction, shift_assignment, not_working_day, holiday, shift_alert, role_seen, weekly_report_sent, admin_bulk_request, shift_template_version, shift_template, office_pattern, office_day, location_alert, report_sent, upload_refusal, insight_event, insight RESTART IDENTITY CASCADE`;
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

  it('ADR-0041: a new-place email is claimed once per person, place and day', async () => {
    const a = await seedEmployee();
    const claim = {
      employeeId: a,
      city: 'mumbai',
      country: 'in',
      sentOn: '2026-10-13',
      at: new Date(),
    };
    let sent = 0;
    expect(await db.locationAlerts.claimAndSend(claim, async () => void sent++)).toBe(true);
    expect(await db.locationAlerts.claimAndSend(claim, async () => void sent++)).toBe(false);
    expect(sent).toBe(1);
    // A failed send leaves nothing claimed.
    const other = { ...claim, city: 'pune' };
    await expect(
      db.locationAlerts.claimAndSend(other, async () => {
        throw new Error('mail down');
      }),
    ).rejects.toThrow('mail down');
    expect(await db.locationAlerts.claimAndSend(other, async () => void sent++)).toBe(true);
    await expect(sql`DELETE FROM location_alert`).rejects.toThrow(/append-only/);
  });

  it('ADR-0040: a report email is claimed once per day and recipient; opening one is audited', async () => {
    const claim = {
      report: 'day' as const,
      date: '2026-10-12',
      recipient: 'Boss@aptask.com',
      people: 3,
      at: new Date(),
    };
    let sent = 0;
    expect(await db.reports.claimAndSend(claim, async () => void sent++)).toBe(true);
    const lower = { ...claim, recipient: 'boss@aptask.com' };
    expect(await db.reports.claimAndSend(lower, async () => void sent++)).toBe(false);
    expect(sent).toBe(1);
    const other = { ...claim, date: '2026-10-13' };
    await expect(
      db.reports.claimAndSend(other, async () => {
        throw new Error('mail down');
      }),
    ).rejects.toThrow('mail down');
    expect(await db.reports.claimAndSend(other, async () => void sent++)).toBe(true);
    await expect(sql`DELETE FROM report_sent`).rejects.toThrow(/append-only/);
    // ADR-0043 §3 (migration 0020): the daily Teams post, once a day.
    const teams = { ...claim, report: 'teams_corrections' as const, recipient: 'teams' };
    expect(await db.reports.claimAndSend(teams, async () => void sent++)).toBe(true);
    expect(await db.reports.claimAndSend(teams, async () => void sent++)).toBe(false);

    const { userId } = await seedUser({});
    const correlationId = randomUUID();
    await db.reports.auditView({
      actorUserId: userId,
      report: 'day',
      detail: { date: '2026-10-12', people: '3' },
      correlationId,
      at: new Date(),
    });
    const rows = await sql<{ action: string; entityType: string; newValue: unknown }[]>`
      SELECT action, entity_type AS "entityType", new_value AS "newValue" FROM audit_log WHERE correlation_id = ${correlationId}`;
    expect(rows).toEqual([
      {
        action: 'day_report_viewed',
        entityType: 'report',
        newValue: { date: '2026-10-12', people: '3' },
      },
    ]);
  });

  it("ADR-0038 §8: change history reads a person's changes and a scope's saves", async () => {
    const a = await seedEmployee();
    const oid = randomUUID();
    const { userId } = await seedUser({ employeeId: a, oid });
    const other = await seedEmployee();
    const at = (m: number) => new Date(Date.UTC(2026, 9, 13, 10, m));
    await db.employees.setReportingManager({
      employeeId: a,
      managerId: other,
      actorUserId: userId,
      reason: 'new team',
      correlationId: randomUUID(),
      at: at(1),
    });
    await db.employees.auditView({
      actorUserId: userId,
      employeeId: a,
      action: 'day_viewed',
      detail: { date: '2026-10-12' },
      correlationId: randomUUID(),
      at: at(2),
    });
    await db.people.auditRoleChange({
      actorUserId: userId,
      targetOid: oid,
      previousRoles: ['Employee'],
      newRoles: ['Employee', 'Manager'],
      reason: null,
      correlationId: randomUUID(),
      at: at(3),
    });
    // Someone else's change isn't theirs.
    await db.employees.setReportingManager({
      employeeId: other,
      managerId: null,
      actorUserId: userId,
      reason: null,
      correlationId: randomUUID(),
      at: at(4),
    });
    const rows = await db.history.personHistory(a, oid, 10);
    expect(rows.map((r) => [r.action, r.entityType, r.reason])).toEqual([
      ['roles_set', 'app_role_assignment', null],
      ['reporting_manager_set', 'employee', 'new team'],
    ]);
    expect(rows[1]).toMatchObject({
      before: { manager_employee_id: null },
      after: { manager_employee_id: other },
    });
    expect(rows[0]?.at).toBeInstanceOf(Date);
    expect(await db.history.personHistory(a, null, 10)).toHaveLength(1);

    const change = (m: number) => ({
      scope: 'global' as const,
      scopeId: null,
      reason: `save ${m}`,
      actorUserId: userId,
      correlationId: randomUUID(),
      at: at(m),
    });
    await db.policies.put(change(5), { idle: { threshold_seconds: 180 } });
    await db.policies.put(change(6), { idle: { threshold_seconds: 240 } });
    const saves = await db.history.policyHistory('global', null, 1);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      action: 'policy_set',
      reason: 'save 6',
      before: { scope: 'global', document: { idle: { threshold_seconds: 180 } } },
      after: { scope: 'global', document: { idle: { threshold_seconds: 240 } } },
    });
  });

  it('ADR-0040 §3.4: refused uploads add up per computer, person, reason and day', async () => {
    const device = randomUUID();
    const employee = randomUUID();
    const note = (events: number, ahead: number | null, at: string, reason = 'clock_ahead') =>
      db.refusals.note({
        deviceId: device,
        employeeId: employee,
        reason,
        events,
        aheadSeconds: ahead,
        at: new Date(at),
      });
    await note(3, 150, '2026-10-12T10:00:00Z');
    await note(2, 170, '2026-10-12T11:00:00Z');
    await note(1, 120, '2026-10-13T09:00:00Z');
    await note(4, null, '2026-10-12T12:00:00Z', 'signature_invalid');
    const rows = await db.refusals.between('2026-10-12', '2026-10-12');
    expect(rows.map((r) => [r.reason, r.day, r.events, r.aheadSeconds])).toEqual([
      ['signature_invalid', '2026-10-12', 4, null],
      ['clock_ahead', '2026-10-12', 5, 170],
    ]);
    expect(rows[1]?.firstAt.toISOString()).toBe('2026-10-12T10:00:00.000Z');
    expect(rows[1]?.lastAt.toISOString()).toBe('2026-10-12T11:00:00.000Z');
    expect(await db.refusals.between('2026-10-12', '2026-10-13')).toHaveLength(3);
  });

  it('ADR-0044: only the purge function deletes from append-only tables, never below a floor', async () => {
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
    const DAY = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * DAY);
    const session = async (openedDaysAgo: number, closed: boolean) => {
      const s = await db.timeSessions.open({
        employeeId: empId,
        deviceId: device.id,
        openedAt: ago(openedDaysAgo),
      });
      if (closed) await db.timeSessions.close(s.id, ago(openedDaysAgo - 0.1), 'user_clock_out');
      return s.id;
    };
    let n = 0;
    const event = async (
      sessionId: string,
      type: string,
      at: Date,
      payload: Record<string, string> = {},
    ) => {
      n += 1;
      const ulid = `01J8Q${String(n).padStart(21, '0')}`;
      await sql`
        INSERT INTO time_event (event_ulid, event_type, session_id, employee_id, sequence_number,
                                client_ts, server_ts, monotonic_ns, tz_iana, utc_offset_minutes,
                                device_id, app_version, origin, offline_captured, payload,
                                integrity_signature, correlation_id)
        VALUES (${ulid}, ${type}, ${sessionId}, ${empId}, ${n}, ${at}, ${at}, 0, 'Asia/Kolkata',
                330, ${device.id}, '0.1.0', 'user', false, ${sql.json(payload)},
                ${Buffer.alloc(64)}, ${randomUUID()})`;
    };
    // Six years ago: a closed session with two events; another on legal hold.
    const old = await session(6 * 365, true);
    await event(old, 'USER_CLOCK_IN', ago(6 * 365));
    await event(old, 'USER_CLOCK_OUT', ago(6 * 365 - 0.1));
    const held = await session(6 * 365, true);
    await event(held, 'USER_CLOCK_IN', ago(6 * 365));
    await sql`UPDATE time_session SET legal_hold_until = current_date + 30 WHERE id = ${held}`;
    // Today's session: a clock-in, and two idle answers from 200 days ago.
    const today = await session(0.1, false);
    await event(today, 'USER_CLOCK_IN', ago(0.1));
    await event(today, 'USER_IDLE_EXPLAINED', ago(200), { explanation: 'meeting' });
    await event(today, 'USER_IDLE_EXPLAINED', ago(200), { explanation: 'break' });
    await sql`
      INSERT INTO audit_log (actor_type, entity_type, action, correlation_id, occurred_at)
      VALUES ('system', 'test', 'old_row', ${randomUUID()}, ${ago(8 * 365)})`;
    const count = async (table: string) =>
      (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(table)}`)[0]?.n;

    // Ordinary deletes are still refused, for any role, and a flag alone doesn't open them.
    await expect(sql`DELETE FROM time_event`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_log`).rejects.toThrow(/append-only/);
    await expect(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('cloudpunch.retention_purge', 'guess', true)`;
        await tx`DELETE FROM time_event`;
      }),
    ).rejects.toThrow(/append-only/);
    // The floors hold in the database, whatever the caller asks.
    await expect(db.retention.purge('time_records', 365, false)).rejects.toThrow(/at least 1096/);
    await expect(db.retention.purge('idle_notes', 30, true)).rejects.toThrow(/at least 90/);

    // A dry run counts and changes nothing.
    expect(await db.retention.purge('time_records', 1096, true)).toBe(3);
    expect(await db.retention.purge('idle_notes', 90, true)).toBe(1);
    expect(await count('time_event')).toBe(6);

    // For real: the old session and its events, not the held one; the
    // meeting answer, not the break (ADR-0042); the old audit row.
    expect(await db.retention.purge('time_records', 1096, false)).toBe(3);
    expect(await db.retention.purge('idle_notes', 90, false)).toBe(1);
    expect(await db.retention.purge('audit_log', 1096, false)).toBe(1);
    expect(await count('time_event')).toBe(3);
    const sessions = await sql<{ id: string }[]>`SELECT id FROM time_session`;
    expect(sessions.map((r) => r.id).sort()).toEqual([held, today].sort());
    const left = await sql<{ payload: { explanation?: string } }[]>`
      SELECT payload FROM time_event WHERE event_type = 'USER_IDLE_EXPLAINED'`;
    expect(left.map((r) => r.payload.explanation)).toEqual(['break']);

    // Each real run is audited; the lock is gone; deletes are refused again.
    const runs = await sql<{ kind: string; rows: number }[]>`
      SELECT new_value->>'kind' AS kind, (new_value->>'rows')::int AS rows
      FROM audit_log WHERE action = 'retention_purged' ORDER BY occurred_at`;
    expect(runs.map((r) => [r.kind, r.rows])).toEqual([
      ['time_records', 3],
      ['idle_notes', 1],
      ['audit_log', 1],
    ]);
    expect(await count('retention_purge_lock')).toBe(0);
    await expect(sql`DELETE FROM time_event`).rejects.toThrow(/append-only/);
    await expect(sql`UPDATE audit_log SET reason = 'x'`).rejects.toThrow(/append-only/);
  });

  it('ADR-0047: a finding is a case: one live per person and kind, history append-only', async () => {
    const a = await seedEmployee();
    const { userId } = await seedUser({ employeeId: a });
    const at = new Date('2026-10-14T03:00:00Z');
    const evidence = { count: 3, dates: ['2026-10-05', '2026-10-07', '2026-10-12'] };
    const ins = await db.insights.open(
      { employeeId: a, kind: 'late_starts', severity: 'warning', evidence },
      { action: 'opened', actorUserId: null, note: null, detail: { count: 3 }, at },
    );
    expect(ins).toMatchObject({ status: 'open', evidence, followUpOn: null, noChange: false });
    await expect(
      db.insights.open(
        { employeeId: a, kind: 'late_starts', severity: 'warning', evidence },
        { action: 'opened', actorUserId: null, note: null, detail: null, at },
      ),
    ).rejects.toThrow();
    const nudged = await db.insights.change(
      ins.id,
      { status: 'nudged', followUpOn: '2026-10-28' },
      { action: 'nudged', actorUserId: userId, note: 'Hi', detail: { to: 'x@aptask.com' }, at },
    );
    expect(nudged).toMatchObject({ status: 'nudged', followUpOn: '2026-10-28', evidence });
    expect((await db.insights.list(['open', 'nudged'], [a])).map((i) => i.id)).toEqual([ins.id]);
    const history = await db.insights.history(ins.id);
    expect(history.map((h) => [h.action, h.actorUserId === userId, h.note])).toEqual([
      ['opened', false, null],
      ['nudged', true, 'Hi'],
    ]);
    await expect(sql`DELETE FROM insight_event`).rejects.toThrow(/append-only/);
  });

  it('ADR-0039: office patterns and one-offs, newest first; append-only', async () => {
    const a = await seedEmployee();
    const { userId } = await seedUser({ employeeId: a });
    const base = { employeeId: a, reason: null, setByUserId: userId, correlationId: randomUUID() };
    await db.office.setPattern({
      ...base,
      weekdays: [2, 4],
      effectiveFrom: '2026-10-13',
      at: new Date('2026-10-13T10:00:00Z'),
    });
    await db.office.setDay({
      ...base,
      date: '2026-10-14',
      inOffice: true,
      at: new Date('2026-10-13T11:00:00Z'),
    });
    await db.office.setDay({
      ...base,
      date: '2026-10-14',
      inOffice: false,
      at: new Date('2026-10-13T12:00:00Z'),
    });
    expect((await db.office.patterns([a])).map((p) => [p.weekdays, p.effectiveFrom])).toEqual([
      [[2, 4], '2026-10-13'],
    ]);
    expect(
      (await db.office.days([a], '2026-10-01', '2026-10-31')).map((d) => [d.date, d.inOffice]),
    ).toEqual([
      ['2026-10-14', false],
      ['2026-10-14', true],
    ]);
    await expect(sql`DELETE FROM office_day`).rejects.toThrow(/append-only/);
  });

  it('ADR-0038 §6: named shifts, versions and bulk shift rows; append-only', async () => {
    const a = await seedEmployee();
    const b = await seedEmployee();
    const { userId } = await seedUser({ employeeId: a });
    const at = new Date();
    const base = {
      name: 'India day',
      days: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '18:00',
      tzIana: 'Asia/Kolkata',
      retired: false,
      reason: null,
      createdByUserId: userId,
      correlationId: randomUUID(),
      at,
    };
    const v1 = await db.shifts.saveTemplateVersion({
      ...base,
      templateId: null,
      effectiveFrom: '2026-10-12',
    });
    const v2 = await db.shifts.saveTemplateVersion({
      ...base,
      templateId: v1.templateId,
      start: '08:00',
      end: '17:00',
      effectiveFrom: '2026-10-20',
    });
    expect((await db.shifts.templates()).map((v) => [v.id, v.start, v.effectiveFrom])).toEqual([
      [v2.id, '08:00', '2026-10-20'],
      [v1.id, '09:00', '2026-10-12'],
    ]);
    const key = randomUUID();
    const row = (employeeId: string) => ({
      employeeId,
      days: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '18:00',
      tzIana: 'Asia/Kolkata',
      templateId: v1.templateId,
      effectiveFrom: '2026-10-13',
      reason: 'new team',
      assignedByUserId: userId,
      correlationId: randomUUID(),
      at,
    });
    const record = {
      actorUserId: userId,
      key,
      kind: 'shift' as const,
      requestHash: 'h',
      result: {},
      correlationId: randomUUID(),
      at,
    };
    expect(await db.shifts.assignMany([row(a), row(b)], record)).toBe(true);
    expect(await db.shifts.assignMany([row(a)], record)).toBe(false);
    const rows = await db.shifts.history([a, b]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.templateId === v1.templateId)).toBe(true);
    await expect(sql`DELETE FROM shift_template_version`).rejects.toThrow(/append-only/);
  });

  it('ADR-0038 §5: bulk manager in one transaction, once per key; the table is append-only', async () => {
    const mgr = await seedEmployee();
    const a = await seedEmployee();
    const b = await seedEmployee();
    const { userId } = await seedUser({ employeeId: mgr });
    const key = randomUUID();
    const correlationId = randomUUID();
    const at = new Date();
    const record = {
      actorUserId: userId,
      key,
      kind: 'manager' as const,
      requestHash: 'h1',
      result: { changed: [a, b] },
      correlationId,
      at,
    };
    const input = {
      employeeIds: [a, b],
      managerId: mgr,
      actorUserId: userId,
      reason: 'new team',
      correlationId,
      at,
    };
    expect(await db.employees.setReportingManagers(input, record)).toBe(true);
    expect((await db.employees.findById(b))?.reportingManagerId).toBe(mgr);
    expect(await db.bulkRequests.find(userId, key)).toEqual({
      kind: 'manager',
      requestHash: 'h1',
      result: { changed: [a, b] },
    });
    // The same key again: nothing changes, no more audit rows.
    expect(await db.employees.setReportingManagers({ ...input, managerId: null }, record)).toBe(
      false,
    );
    expect((await db.employees.findById(a))?.reportingManagerId).toBe(mgr);
    const rows = await sql<{ entityId: string }[]>`
      SELECT entity_id FROM audit_log WHERE correlation_id = ${correlationId}`;
    expect(rows.map((r) => r.entityId).sort()).toEqual([a, b].sort());
    expect(await db.bulkRequests.save(record)).toBe(false);
    await expect(sql`DELETE FROM admin_bulk_request`).rejects.toThrow(/append-only/);
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

// ---------------------------------------------------------------------
// shift-start emails and remembered roles (ADR-0037)
// ---------------------------------------------------------------------

describe('PostgresDb — shift alerts and roles', () => {
  it('claims each alert once, rolls back a failed send, and counts missed starts', async () => {
    const employeeId = await seedEmployee();
    const claim = (kind: 'missed' | 'late_clock_in', shiftDate = '2026-10-09') => ({
      employeeId,
      shiftDate,
      kind,
      sentTo: ['alice@aptask.com', 'boss@aptask.com'],
      at: new Date(),
    });
    let sends = 0;
    const send = async () => {
      sends += 1;
    };
    await expect(
      db.shiftAlerts.claimAndSend(claim('missed'), async () => {
        throw new Error('Graph down');
      }),
    ).rejects.toThrow('Graph down');
    expect(await db.shiftAlerts.sent([employeeId], ['2026-10-09'])).toEqual(new Set());

    expect(await db.shiftAlerts.claimAndSend(claim('missed'), send)).toBe(true);
    // Two at once (two servers): one sends.
    const both = await Promise.all([
      db.shiftAlerts.claimAndSend(claim('late_clock_in'), send),
      db.shiftAlerts.claimAndSend(claim('late_clock_in'), send),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(await db.shiftAlerts.claimAndSend(claim('missed'), send)).toBe(false);
    expect(sends).toBe(2);
    expect(await db.shiftAlerts.sent([employeeId], ['2026-10-09', '2026-10-10'])).toEqual(
      new Set([`${employeeId}:2026-10-09:missed`, `${employeeId}:2026-10-09:late_clock_in`]),
    );

    await db.shiftAlerts.claimAndSend(claim('missed', '2026-09-01'), send);
    expect(await db.shiftAlerts.countsSince('2026-09-10')).toEqual(
      new Map([[employeeId, { missed: 1, notWorking: 0 }]]),
    );
    expect(await db.shiftAlerts.countsSince('2026-08-01')).toEqual(
      new Map([[employeeId, { missed: 2, notWorking: 0 }]]),
    );
    await expect(sql`DELETE FROM shift_alert`).rejects.toThrow(/append-only/);
  });

  it('sends the Monday email once per recipient per week', async () => {
    let sends = 0;
    const send = async () => {
      sends += 1;
    };
    const claim = (who: string) =>
      db.weeklyReports.claimAndSend('2026-10-12', who, 2, new Date(), send);
    await expect(
      db.weeklyReports.claimAndSend('2026-10-12', 'boss@aptask.com', 2, new Date(), async () => {
        throw new Error('Graph down');
      }),
    ).rejects.toThrow('Graph down');
    expect(await claim('boss@aptask.com')).toBe(true);
    // citext: the same address in other case is the same recipient.
    expect(await claim('Boss@ApTask.com')).toBe(false);
    expect(await claim('hr@aptask.com')).toBe(true);
    expect(sends).toBe(2);
    await expect(sql`DELETE FROM weekly_report_sent`).rejects.toThrow(/append-only/);
  });

  it('remembers the latest roles per person and finds the holders with an email', async () => {
    const { oid } = await seedUser();
    const stranger = randomUUID();
    await db.roles.note(oid, ['Employee', 'Administrator'], 'token', new Date());
    await db.roles.note(stranger, ['HR'], 'token', new Date());
    expect(await db.roles.holders(['Administrator', 'HR'])).toEqual([
      { oid, email: 'alice@aptask.com' },
    ]);
    await db.roles.note(oid, ['Employee'], 'people', new Date());
    expect(await db.roles.holders(['Administrator', 'HR'])).toEqual([]);
  });
});
