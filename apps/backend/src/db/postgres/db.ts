import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type {
  PeopleRepo,
  AppUser,
  AppUserRepo,
  ConnectionRepo,
  CorrectionDecision,
  CorrectionRepo,
  CorrectionWithDecisions,
  DbRepositories,
  ShiftAssignment,
  ShiftRepo,
  DeviceConnection,
  Device,
  DeviceEnrollInput,
  DeviceOs,
  DeviceRepo,
  Employee,
  EmployeeRepo,
  EmploymentStatus,
  EventOrigin,
  InsertEventResult,
  OpenSessionInput,
  DepartmentRepo,
  PolicyChange,
  PolicyOverride,
  PolicyRepo,
  PolicyScope,
  SessionCloseReason,
  TimeEventInput,
  TimeEventRecord,
  TimeEventRepo,
  TimeSession,
  TimeSessionRepo,
} from '../types.js';
import { CorrectionDecisionConflictError } from '../types.js';

/**
 * Postgres-backed implementation of DbRepositories. Mirrors the exact
 * semantics of InMemoryDb — unique-open-session per employee,
 * idempotent device enrollment, idempotent event insert, sequence
 * uniqueness — but delegates enforcement to the database's
 * constraints (unique partial index, PK, unique index).
 *
 * The `postgres` client is configured with `postgres.camel` so
 * snake_case columns marshal to camelCase JS fields automatically.
 */
export class PostgresDb implements DbRepositories {
  readonly employees: EmployeeRepo;
  readonly users: AppUserRepo;
  readonly devices: DeviceRepo;
  readonly timeSessions: TimeSessionRepo;
  readonly timeEvents: TimeEventRepo;
  readonly policies: PolicyRepo;
  readonly departments: DepartmentRepo;
  readonly people: PeopleRepo;
  readonly connections: ConnectionRepo;
  readonly corrections: CorrectionRepo;
  readonly shifts: ShiftRepo;

  constructor(private readonly sql: postgres.Sql) {
    this.shifts = this.buildShiftRepo();
    this.connections = this.buildConnectionRepo();
    this.corrections = this.buildCorrectionRepo();
    this.employees = this.buildEmployeeRepo();
    this.users = this.buildAppUserRepo();
    this.devices = this.buildDeviceRepo();
    this.timeSessions = this.buildTimeSessionRepo();
    this.timeEvents = this.buildTimeEventRepo();
    this.policies = this.buildPolicyRepo();
    this.people = {
      provision: (input) =>
        this.sql.begin(async (tx) => {
          const [existing] = await tx<{ id: string; employeeId: string | null }[]>`
            SELECT id, employee_id AS "employeeId" FROM app_user
            WHERE entra_object_id = ${input.oid} FOR UPDATE`;
          if (existing?.employeeId) return { employeeId: existing.employeeId, created: false };
          const display = `${input.givenName} ${input.familyName}`.trim();
          const [employee] = await tx<{ id: string }[]>`
            INSERT INTO employee (source, given_name, family_name, display_name, status)
            VALUES ('local_admin', ${input.givenName}, ${input.familyName}, ${display}, 'active')
            RETURNING id`;
          if (!employee) throw new Error('employee insert returned no row');
          await tx`
            INSERT INTO app_user (entra_object_id, work_email, display_name, employee_id)
            VALUES (${input.oid}, ${input.email ?? ''}, ${display}, ${employee.id})
            ON CONFLICT (entra_object_id)
              DO UPDATE SET employee_id = EXCLUDED.employee_id, updated_at = now()`;
          return { employeeId: employee.id, created: true };
        }),
      setRecordActive: (i) =>
        this.sql.begin(async (tx) => {
          const [row] = await tx<{ status: string }[]>`
            SELECT status FROM employee WHERE id = ${i.employeeId} FOR UPDATE`;
          const from = i.active ? 'inactive' : 'active';
          const to = i.active ? 'active' : 'inactive';
          if (row?.status !== from) return { changed: false, unassigned: [] };
          await tx`UPDATE employee SET status = ${to}, updated_at = now() WHERE id = ${i.employeeId}`;
          await tx`
            INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                                   previous_value, new_value, reason, correlation_id, occurred_at)
            VALUES ('user', ${i.actorUserId}, 'employee', ${i.employeeId}, 'status_set',
                    ${tx.json({ status: from })}, ${tx.json({ status: to })},
                    ${i.reason}, ${i.correlationId}, ${i.at})`;
          if (i.active) return { changed: true, unassigned: [] };
          const reports = await tx<{ id: string; name: string }[]>`
            UPDATE employee SET reporting_manager_id = NULL, updated_at = now()
            WHERE reporting_manager_id = ${i.employeeId} AND status = 'active'
            RETURNING id, coalesce(display_name, given_name || ' ' || family_name) AS name`;
          for (const r of reports) {
            await tx`
              INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                                     previous_value, new_value, reason, correlation_id, occurred_at)
              VALUES ('user', ${i.actorUserId}, 'employee', ${r.id}, 'reporting_manager_set',
                      ${tx.json({ manager_employee_id: i.employeeId })},
                      ${tx.json({ manager_employee_id: null })},
                      ${i.reason}, ${i.correlationId}, ${i.at})`;
          }
          return {
            changed: true,
            unassigned: [...reports]
              .map((r) => ({ id: r.id, name: r.name }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          };
        }),
      auditRoleChange: async (e) => {
        await this.sql`
          INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                                 previous_value, new_value, reason, correlation_id, occurred_at)
          VALUES ('user', ${e.actorUserId}, 'app_role_assignment', ${e.targetOid}, 'roles_set',
                  ${this.sql.json({ roles: [...e.previousRoles] })},
                  ${this.sql.json({ roles: [...e.newRoles] })},
                  ${e.reason}, ${e.correlationId}, ${e.at})`;
      },
      auditWelcome: async (e) => {
        await this.sql`
          INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                                 previous_value, new_value, reason, correlation_id, occurred_at)
          VALUES ('user', ${e.actorUserId}, 'welcome_email', ${e.targetOid}, 'welcome_sent',
                  NULL, ${this.sql.json({ to: e.to, cc: [...e.cc] })}, NULL,
                  ${e.correlationId}, ${e.at})`;
      },
      lastWelcomeAt: async (oid) => {
        const [row] = await this.sql<{ at: Date | null }[]>`
          SELECT max(occurred_at) AS at FROM audit_log
          WHERE entity_type = 'welcome_email' AND entity_id = ${oid}`;
        return row?.at ?? null;
      },
    };
    this.departments = {
      exists: async (id) => {
        const rows = await this.sql`SELECT 1 FROM department WHERE id = ${id} LIMIT 1`;
        return rows.length > 0;
      },
      list: async () =>
        this.sql<{ id: string; code: string; name: string }[]>`
          SELECT id, code, name FROM department ORDER BY name
        `,
    };
  }

  // -------------------------------------------------------------------
  // device connections (ADR-0029)
  // -------------------------------------------------------------------

  private buildConnectionRepo(): ConnectionRepo {
    // `host(ip)` gives the bare address; inet would print a /32 or /128.
    const cols = this.sql`id, employee_id, device_id, host(ip) AS ip, city, region, country,
                          asn, provider, first_seen_at, last_seen_at`;
    return {
      latestForDevice: async (deviceId) => {
        const [row] = await this.sql<DeviceConnection[]>`
          SELECT ${cols} FROM device_connection
          WHERE device_id = ${deviceId}
          ORDER BY last_seen_at DESC LIMIT 1`;
        return row ?? null;
      },
      insert: async (c) => {
        const [row] = await this.sql<DeviceConnection[]>`
          INSERT INTO device_connection (employee_id, device_id, ip, city, region, country,
                                         asn, provider, first_seen_at, last_seen_at)
          VALUES (${c.employeeId}, ${c.deviceId}, ${c.ip}, ${c.city}, ${c.region}, ${c.country},
                  ${c.asn}, ${c.provider}, ${c.firstSeenAt}, ${c.lastSeenAt})
          RETURNING ${cols}`;
        if (!row) throw new Error('device_connection insert returned no row');
        return row;
      },
      touch: async (id, at) => {
        await this.sql`
          UPDATE device_connection SET last_seen_at = greatest(last_seen_at, ${at})
          WHERE id = ${id}`;
      },
      listForEmployee: async (employeeId, since) =>
        this.sql<DeviceConnection[]>`
          SELECT ${cols} FROM device_connection
          WHERE employee_id = ${employeeId} AND last_seen_at >= ${since}
          ORDER BY last_seen_at DESC LIMIT 1000`,
      latestForEmployees: async (employeeIds, since) => {
        if (employeeIds.length === 0) return new Map();
        const rows = await this.sql<DeviceConnection[]>`
          SELECT DISTINCT ON (employee_id) ${cols} FROM device_connection
          WHERE employee_id IN ${this.sql(employeeIds)} AND last_seen_at >= ${since}
          ORDER BY employee_id, last_seen_at DESC`;
        return new Map(rows.map((r) => [r.employeeId, r]));
      },
    };
  }

  // -------------------------------------------------------------------
  // shifts (ADR-0031)
  // -------------------------------------------------------------------

  private buildShiftRepo(): ShiftRepo {
    // Times as HH:MM and dates as YYYY-MM-DD text, so no zone creeps in.
    const cols = this.sql`id, employee_id, days::int[] AS days,
                          to_char(start_time, 'HH24:MI') AS start,
                          to_char(end_time, 'HH24:MI') AS "end",
                          tz_iana, to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                          reason, assigned_by_user_id, assigned_at`;
    return {
      assign: async (i) =>
        this.sql.begin(async (tx) => {
          const [row] = await tx<ShiftAssignment[]>`
            INSERT INTO shift_assignment (employee_id, days, start_time, end_time, tz_iana,
                                          effective_from, reason, assigned_by_user_id, assigned_at)
            VALUES (${i.employeeId}, ${i.days}::smallint[], ${i.start}::time, ${i.end}::time,
                    ${i.tzIana}, ${i.effectiveFrom}::date, ${i.reason}, ${i.assignedByUserId},
                    ${i.at})
            RETURNING ${cols}`;
          if (!row) throw new Error('shift_assignment insert returned no row');
          await tx`
            INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                                   previous_value, new_value, reason, correlation_id, occurred_at)
            VALUES ('user', ${i.assignedByUserId}, 'employee', ${i.employeeId}, 'shift_assigned',
                    NULL,
                    ${tx.json({
                      days: i.days,
                      start: i.start,
                      end: i.end,
                      tz_iana: i.tzIana,
                      effective_from: i.effectiveFrom,
                    })},
                    ${i.reason}, ${i.correlationId}, ${i.at})`;
          return row;
        }),
      history: async (ids) => {
        if (ids.length === 0) return [];
        return this.sql<ShiftAssignment[]>`
          SELECT ${cols} FROM shift_assignment
          WHERE employee_id IN ${this.sql(ids)}
          ORDER BY effective_from DESC, assigned_at DESC`;
      },
      declareNotWorking: async (i) =>
        this.sql.begin(async (tx) => {
          const rows = await tx`
            INSERT INTO not_working_day (employee_id, shift_date, declared_by_user_id, declared_at)
            VALUES (${i.employeeId}, ${i.shiftDate}::date, ${i.declaredByUserId}, ${i.at})
            ON CONFLICT (employee_id, shift_date) DO NOTHING
            RETURNING id`;
          if (rows.length === 0) return false;
          await tx`
            INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                                   previous_value, new_value, reason, correlation_id, occurred_at)
            VALUES ('user', ${i.declaredByUserId}, 'employee', ${i.employeeId},
                    'not_working_declared', NULL, ${tx.json({ shift_date: i.shiftDate })},
                    NULL, ${i.correlationId}, ${i.at})`;
          return true;
        }),
      notWorking: async (ids, dates) => {
        if (ids.length === 0 || dates.length === 0) return new Set();
        const rows = await this.sql<{ employeeId: string; shiftDate: string }[]>`
          SELECT employee_id, to_char(shift_date, 'YYYY-MM-DD') AS shift_date
          FROM not_working_day
          WHERE employee_id IN ${this.sql(ids)} AND shift_date::text IN ${this.sql(dates)}`;
        return new Set(rows.map((r) => `${r.employeeId}:${r.shiftDate}`));
      },
    };
  }

  // -------------------------------------------------------------------
  // time corrections (ADR-0030)
  // -------------------------------------------------------------------

  private buildCorrectionRepo(): CorrectionRepo {
    type Row = Omit<CorrectionWithDecisions, 'decisions'>;
    const cols = this.sql`id, employee_id, from_at, to_at, tz_iana, utc_offset_minutes, kind,
                          reason, requested_by_user_id, requested_at`;
    const dcols = this.sql`id, correction_id, decision, decided_by_user_id, decided_at, note`;
    /** Attach each correction's decisions, oldest first. */
    const withDecisions = async (rows: Row[]): Promise<CorrectionWithDecisions[]> => {
      if (rows.length === 0) return [];
      const ds = await this.sql<CorrectionDecision[]>`
        SELECT ${dcols} FROM time_correction_decision
        WHERE correction_id IN ${this.sql(rows.map((r) => r.id))}
        ORDER BY decided_at, (decision <> 'endorsed'), id`;
      return rows.map((r) => ({ ...r, decisions: ds.filter((d) => d.correctionId === r.id) }));
    };
    const isUniqueViolation = (e: unknown): boolean =>
      typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';

    return {
      request: async (i) =>
        this.sql.begin(async (tx) => {
          const [row] = await tx<Row[]>`
            INSERT INTO time_correction (employee_id, from_at, to_at, tz_iana, utc_offset_minutes,
                                         kind, reason, requested_by_user_id, requested_at)
            VALUES (${i.employeeId}, ${i.fromAt}, ${i.toAt}, ${i.tzIana}, ${i.utcOffsetMinutes},
                    ${i.kind}, ${i.reason}, ${i.requestedByUserId}, ${i.at})
            RETURNING ${cols}`;
          if (!row) throw new Error('time_correction insert returned no row');
          const decisions: CorrectionDecision[] = [];
          if (i.endorse) {
            const [d] = await tx<CorrectionDecision[]>`
              INSERT INTO time_correction_decision (correction_id, decision,
                                                    decided_by_user_id, decided_at)
              VALUES (${row.id}, 'endorsed', ${i.requestedByUserId}, ${i.at})
              RETURNING ${dcols}`;
            if (d) decisions.push(d);
          }
          await tx`
            INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                                   previous_value, new_value, reason, correlation_id, occurred_at)
            VALUES ('user', ${i.requestedByUserId}, 'time_correction', ${row.id},
                    'correction_requested', NULL,
                    ${tx.json({
                      employee_id: i.employeeId,
                      from: i.fromAt.toISOString(),
                      to: i.toAt.toISOString(),
                      kind: i.kind,
                      endorsed: i.endorse,
                    })},
                    ${i.reason}, ${i.correlationId}, ${i.at})`;
          return { ...row, decisions };
        }),
      decide: async (i) => {
        try {
          return await this.sql.begin(async (tx) => {
            const [d] = await tx<CorrectionDecision[]>`
              INSERT INTO time_correction_decision (correction_id, decision,
                                                    decided_by_user_id, decided_at, note)
              VALUES (${i.correctionId}, ${i.decision}, ${i.decidedByUserId}, ${i.at}, ${i.note})
              RETURNING ${dcols}`;
            if (!d) throw new Error('time_correction_decision insert returned no row');
            await tx`
              INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                                     previous_value, new_value, reason, correlation_id, occurred_at)
              VALUES ('user', ${i.decidedByUserId}, 'time_correction', ${i.correctionId},
                      ${`correction_${i.decision}`}, NULL,
                      ${tx.json({ employee_id: i.employeeId })},
                      ${i.note}, ${i.correlationId}, ${i.at})`;
            return d;
          });
        } catch (e) {
          // One endorsement and one final decision per correction.
          if (isUniqueViolation(e)) throw new CorrectionDecisionConflictError(i.correctionId);
          throw e;
        }
      },
      findById: async (id) => {
        const rows = await this.sql<Row[]>`SELECT ${cols} FROM time_correction WHERE id = ${id}`;
        const [c] = await withDecisions(rows);
        return c ?? null;
      },
      listForEmployee: async (employeeId, from, to) =>
        withDecisions(
          await this.sql<Row[]>`
            SELECT ${cols} FROM time_correction
            WHERE employee_id = ${employeeId} AND from_at < ${to} AND to_at > ${from}
            ORDER BY from_at, requested_at LIMIT 1000`,
        ),
      listOpen: async () =>
        withDecisions(
          await this.sql<Row[]>`
            SELECT ${cols} FROM time_correction c
            WHERE NOT EXISTS (
              SELECT 1 FROM time_correction_decision d
              WHERE d.correction_id = c.id AND d.decision IN ('approved','rejected','withdrawn'))
            ORDER BY requested_at LIMIT 1000`,
        ),
    };
  }

  // -------------------------------------------------------------------
  // policy overrides (ADR-0015)
  // -------------------------------------------------------------------

  private buildPolicyRepo(): PolicyRepo {
    const map = (row: PolicyOverrideRow): PolicyOverride => ({
      scope: row.scope,
      scopeId: row.scopeId,
      document: row.document,
      reason: row.reason,
      updatedByUserId: row.updatedByUserId,
      updatedAt: row.updatedAt,
    });
    const select = async (
      q: postgres.Sql | postgres.TransactionSql,
      scope: PolicyScope,
      scopeId: string | null,
      lock: boolean,
    ): Promise<PolicyOverride | null> => {
      const rows = lock
        ? await q<PolicyOverrideRow[]>`
            SELECT scope, scope_id, document, reason, updated_by_user_id, updated_at
            FROM policy_override
            WHERE scope = ${scope} AND scope_id IS NOT DISTINCT FROM ${scopeId}
            FOR UPDATE`
        : await q<PolicyOverrideRow[]>`
            SELECT scope, scope_id, document, reason, updated_by_user_id, updated_at
            FROM policy_override
            WHERE scope = ${scope} AND scope_id IS NOT DISTINCT FROM ${scopeId}`;
      const row = rows[0];
      return row ? map(row) : null;
    };
    const audit = async (
      tx: postgres.TransactionSql,
      change: PolicyChange,
      action: 'policy_set' | 'policy_clear',
      previous: Record<string, unknown> | null,
      next: Record<string, unknown> | null,
    ): Promise<void> => {
      const value = (doc: Record<string, unknown> | null) =>
        doc ? tx.json({ scope: change.scope, document: doc } as postgres.JSONValue) : null;
      await tx`
        INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                               previous_value, new_value, reason, correlation_id, occurred_at)
        VALUES ('user', ${change.actorUserId}, 'policy_override', ${change.scopeId}, ${action},
                ${value(previous)}, ${value(next)}, ${change.reason}, ${change.correlationId},
                ${change.at})`;
    };
    return {
      find: (scope, scopeId) => select(this.sql, scope, scopeId, false),
      put: async (change, document) =>
        this.sql.begin(async (tx) => {
          const previous = await select(tx, change.scope, change.scopeId, true);
          const doc = tx.json(document as postgres.JSONValue);
          if (previous) {
            await tx`
              UPDATE policy_override
              SET document = ${doc}, reason = ${change.reason},
                  updated_by_user_id = ${change.actorUserId}, updated_at = ${change.at}
              WHERE scope = ${change.scope} AND scope_id IS NOT DISTINCT FROM ${change.scopeId}`;
          } else {
            await tx`
              INSERT INTO policy_override (scope, scope_id, document, reason,
                                           updated_by_user_id, updated_at)
              VALUES (${change.scope}, ${change.scopeId}, ${doc}, ${change.reason},
                      ${change.actorUserId}, ${change.at})`;
          }
          await audit(tx, change, 'policy_set', previous?.document ?? null, document);
          return previous;
        }),
      remove: async (change) =>
        this.sql.begin(async (tx) => {
          const previous = await select(tx, change.scope, change.scopeId, true);
          if (!previous) return null;
          await tx`
            DELETE FROM policy_override
            WHERE scope = ${change.scope} AND scope_id IS NOT DISTINCT FROM ${change.scopeId}`;
          await audit(tx, change, 'policy_clear', previous.document, null);
          return previous;
        }),
    };
  }

  // -------------------------------------------------------------------
  // employees
  // -------------------------------------------------------------------

  private buildEmployeeRepo(): EmployeeRepo {
    const map = (row: EmployeeRow): Employee => ({
      id: row.id,
      departmentId: row.departmentId,
      reportingManagerId: row.reportingManagerId,
      ...(row.entraObjectId !== undefined ? { entraObjectId: row.entraObjectId } : {}),
      source: row.source,
      greythrEmployeeId: row.greythrEmployeeId,
      employeeNumber: row.employeeNumber,
      givenName: row.givenName,
      familyName: row.familyName,
      displayName: row.displayName,
      workEmail: row.workEmail ?? '',
      status: row.status,
    });

    return {
      findById: async (id) => {
        const rows = await this.sql<EmployeeRow[]>`
          SELECT
            e.id, e.source, e.greythr_employee_id, e.employee_number,
            e.given_name, e.family_name, e.display_name, e.status,
            e.department_id, e.reporting_manager_id, u.work_email
          FROM employee e
          LEFT JOIN app_user u ON u.employee_id = e.id
          WHERE e.id = ${id}
          LIMIT 1
        `;
        const row = rows[0];
        return row ? map(row) : null;
      },
      findByEntraObjectId: async (oid) => {
        const rows = await this.sql<EmployeeRow[]>`
          SELECT
            e.id, e.source, e.greythr_employee_id, e.employee_number,
            e.given_name, e.family_name, e.display_name, e.status,
            e.department_id, e.reporting_manager_id, u.work_email
          FROM employee e
          JOIN app_user u ON u.employee_id = e.id
          WHERE u.entra_object_id = ${oid}
          LIMIT 1
        `;
        const row = rows[0];
        return row ? map(row) : null;
      },
      listReports: async (managerId) => {
        const rows = await this.sql<EmployeeRow[]>`
          SELECT
            e.id, e.source, e.greythr_employee_id, e.employee_number,
            e.given_name, e.family_name, e.display_name, e.status,
            e.department_id, e.reporting_manager_id, u.work_email
          FROM employee e
          LEFT JOIN app_user u ON u.employee_id = e.id
          WHERE e.reporting_manager_id = ${managerId} AND e.status = 'active'
          ORDER BY coalesce(e.display_name, e.given_name || ' ' || e.family_name)
        `;
        return rows.map(map);
      },
      listActive: async () => {
        const rows = await this.sql<EmployeeRow[]>`
          SELECT
            e.id, e.source, e.greythr_employee_id, e.employee_number,
            e.given_name, e.family_name, e.display_name, e.status,
            e.department_id, e.reporting_manager_id, u.work_email, u.entra_object_id
          FROM employee e
          LEFT JOIN app_user u ON u.employee_id = e.id
          WHERE e.status = 'active'
          ORDER BY coalesce(e.display_name, e.given_name || ' ' || e.family_name)
        `;
        return rows.map(map);
      },
      setReportingManager: async (i) => {
        await this.sql.begin(async (tx) => {
          const [before] = await tx<{ managerId: string | null }[]>`
            SELECT reporting_manager_id AS "managerId" FROM employee
            WHERE id = ${i.employeeId} FOR UPDATE`;
          await tx`
            UPDATE employee SET reporting_manager_id = ${i.managerId}, updated_at = now()
            WHERE id = ${i.employeeId}`;
          await tx`
            INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                                   previous_value, new_value, reason, correlation_id, occurred_at)
            VALUES ('user', ${i.actorUserId}, 'employee', ${i.employeeId}, 'reporting_manager_set',
                    ${tx.json({ manager_employee_id: before?.managerId ?? null })},
                    ${tx.json({ manager_employee_id: i.managerId })},
                    ${i.reason}, ${i.correlationId}, ${i.at})`;
        });
      },
      auditView: async (v) => {
        await this.sql`
          INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                                 previous_value, new_value, reason, correlation_id, occurred_at)
          VALUES ('user', ${v.actorUserId}, 'employee', ${v.employeeId}, ${v.action},
                  NULL, ${this.sql.json(v.detail)}, NULL, ${v.correlationId}, ${v.at})`;
      },
    };
  }

  // -------------------------------------------------------------------
  // users
  // -------------------------------------------------------------------

  private buildAppUserRepo(): AppUserRepo {
    const map = (row: AppUserRow): AppUser => ({
      id: row.id,
      entraObjectId: row.entraObjectId,
      workEmail: row.workEmail,
      displayName: row.displayName,
      isServiceAccount: row.isServiceAccount,
      breakGlass: row.breakGlass,
      employeeId: row.employeeId,
    });

    return {
      findById: async (id) => {
        const rows = await this.sql<AppUserRow[]>`
          SELECT id, entra_object_id, work_email, display_name,
                 is_service_account, break_glass, employee_id
          FROM app_user WHERE id = ${id} LIMIT 1
        `;
        const row = rows[0];
        return row ? map(row) : null;
      },
      findByEntraObjectId: async (oid) => {
        const rows = await this.sql<AppUserRow[]>`
          SELECT id, entra_object_id, work_email, display_name,
                 is_service_account, break_glass, employee_id
          FROM app_user WHERE entra_object_id = ${oid} LIMIT 1
        `;
        const row = rows[0];
        return row ? map(row) : null;
      },
    };
  }

  // -------------------------------------------------------------------
  // devices
  // -------------------------------------------------------------------

  private buildDeviceRepo(): DeviceRepo {
    const map = (row: DeviceRow): Device => ({
      id: row.id,
      userId: row.userId,
      os: row.os,
      hostnameHash: row.hostnameHash,
      publicKeyEd25519: bufferToUint8(row.publicKeyEd25519),
      appVersion: row.appVersion,
      enrolledAt: row.enrolledAt,
      lastSeenAt: row.lastSeenAt,
      revokedAt: row.revokedAt,
      revokedReason: row.revokedReason,
      revokedByUserId: row.revokedByUserId,
      signoutRequestedAt: row.signoutRequestedAt,
      signoutRequestedBy: row.signoutRequestedBy,
    });

    return {
      enroll: async (input: DeviceEnrollInput) => {
        // Idempotent: refresh key/version when same (id, user_id).
        // Conflict when same id but different user.
        const existingRows = await this.sql<DeviceRow[]>`
          SELECT id, user_id, os, hostname_hash, public_key_ed25519,
                 app_version, enrolled_at, last_seen_at,
                 revoked_at, revoked_reason, revoked_by_user_id,
                 signout_requested_at, signout_requested_by
          FROM device WHERE id = ${input.id} LIMIT 1
        `;
        const existing = existingRows[0];
        if (existing) {
          if (existing.userId !== input.userId) {
            throw new Error(`device ${input.id} already enrolled by a different user`);
          }
          const updated = await this.sql<DeviceRow[]>`
            UPDATE device SET
              public_key_ed25519 = ${Buffer.from(input.publicKeyEd25519)},
              app_version = ${input.appVersion},
              hostname_hash = ${input.hostnameHash},
              os = ${input.os}
            WHERE id = ${input.id}
            RETURNING id, user_id, os, hostname_hash, public_key_ed25519,
                      app_version, enrolled_at, last_seen_at,
                      revoked_at, revoked_reason, revoked_by_user_id,
                 signout_requested_at, signout_requested_by
          `;
          const row = updated[0];
          if (!row) throw new Error('device update returned no rows');
          return map(row);
        }
        const inserted = await this.sql<DeviceRow[]>`
          INSERT INTO device (id, user_id, os, hostname_hash, public_key_ed25519, app_version)
          VALUES (
            ${input.id}, ${input.userId}, ${input.os},
            ${input.hostnameHash},
            ${Buffer.from(input.publicKeyEd25519)},
            ${input.appVersion}
          )
          RETURNING id, user_id, os, hostname_hash, public_key_ed25519,
                    app_version, enrolled_at, last_seen_at,
                    revoked_at, revoked_reason, revoked_by_user_id,
                 signout_requested_at, signout_requested_by
        `;
        const row = inserted[0];
        if (!row) throw new Error('device insert returned no rows');
        return map(row);
      },
      findById: async (id) => {
        const rows = await this.sql<DeviceRow[]>`
          SELECT id, user_id, os, hostname_hash, public_key_ed25519,
                 app_version, enrolled_at, last_seen_at,
                 revoked_at, revoked_reason, revoked_by_user_id,
                 signout_requested_at, signout_requested_by
          FROM device WHERE id = ${id} LIMIT 1
        `;
        const row = rows[0];
        return row ? map(row) : null;
      },
      findByUserId: async (userId) => {
        const rows = await this.sql<DeviceRow[]>`
          SELECT id, user_id, os, hostname_hash, public_key_ed25519,
                 app_version, enrolled_at, last_seen_at,
                 revoked_at, revoked_reason, revoked_by_user_id,
                 signout_requested_at, signout_requested_by
          FROM device WHERE user_id = ${userId}
        `;
        return rows.map(map);
      },
      revoke: async (id, reason, byUserId, at) => {
        // Idempotent: no-op if already revoked.
        await this.sql`
          UPDATE device
          SET revoked_at = ${at}, revoked_reason = ${reason}, revoked_by_user_id = ${byUserId}
          WHERE id = ${id} AND revoked_at IS NULL
        `;
      },
      touchLastSeen: async (id, at, appVersion) => {
        await this.sql`
          UPDATE device
          SET last_seen_at = ${at}, app_version = coalesce(${appVersion ?? null}, app_version)
          WHERE id = ${id}
        `;
      },
      listWithOwners: async () => {
        const rows = await this.sql<
          (DeviceRow & { ownerWorkEmail: string; ownerDisplayName: string })[]
        >`
          SELECT d.id, d.user_id, d.os, d.hostname_hash, d.public_key_ed25519,
                 d.app_version, d.enrolled_at, d.last_seen_at,
                 d.revoked_at, d.revoked_reason, d.revoked_by_user_id,
                 d.signout_requested_at, d.signout_requested_by,
                 u.work_email AS owner_work_email, u.display_name AS owner_display_name
          FROM device d JOIN app_user u ON u.id = d.user_id
          ORDER BY d.last_seen_at DESC NULLS LAST, d.enrolled_at DESC
        `;
        return rows.map((r) => ({
          ...map(r),
          ownerWorkEmail: r.ownerWorkEmail,
          ownerDisplayName: r.ownerDisplayName,
        }));
      },
      signOut: async (i) =>
        this.sql.begin(async (tx) => {
          let closedAt: Date | null = null;
          if (i.sessionId && i.closedAt) {
            // Only an open session changes (invariant 2: time_event is
            // untouched; the session row is the one that closes).
            const [closed] = await tx<{ closedAt: Date }[]>`
              UPDATE time_session
              SET closed_at = ${i.closedAt}, closed_reason = 'remote_takeover',
                  reconstructed = true
              WHERE id = ${i.sessionId} AND device_id = ${i.deviceId} AND closed_at IS NULL
              RETURNING closed_at`;
            closedAt = closed?.closedAt ?? null;
          }
          await tx`
            UPDATE device
            SET signout_requested_at = ${i.at}, signout_requested_by = ${i.actorUserId}
            WHERE id = ${i.deviceId}`;
          await tx`
            INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                                   previous_value, new_value, reason, correlation_id, occurred_at)
            VALUES ('user', ${i.actorUserId}, 'device', ${i.deviceId}, 'device_signed_out',
                    NULL,
                    ${tx.json({
                      employee_id: i.employeeId,
                      session_id: closedAt ? i.sessionId : null,
                      closed_at: closedAt ? closedAt.toISOString() : null,
                    })},
                    NULL, ${i.correlationId}, ${i.at})`;
          return { closedAt };
        }),
      clearSignOut: async (id) => {
        await this.sql`
          UPDATE device SET signout_requested_at = NULL, signout_requested_by = NULL
          WHERE id = ${id} AND signout_requested_at IS NOT NULL`;
      },
    };
  }

  // -------------------------------------------------------------------
  // time_session
  // -------------------------------------------------------------------

  private buildTimeSessionRepo(): TimeSessionRepo {
    const map = (row: TimeSessionRow): TimeSession => ({
      id: row.id,
      employeeId: row.employeeId,
      deviceId: row.deviceId,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      closedReason: row.closedReason,
      reconstructed: row.reconstructed,
    });

    return {
      open: async (input: OpenSessionInput) => {
        const id = input.id ?? randomUUID();

        // Idempotent: if this exact id exists, return it.
        if (input.id) {
          const existing = await this.sql<TimeSessionRow[]>`
            SELECT id, employee_id, device_id, opened_at, closed_at, closed_reason, reconstructed
            FROM time_session WHERE id = ${input.id} LIMIT 1
          `;
          if (existing[0]) return map(existing[0]);
        }

        // Insert. The unique partial index on (employee_id) WHERE
        // closed_at IS NULL will raise 23505 if another session is
        // already open for this employee.
        const c = input.closed;
        const rows = await this.sql<TimeSessionRow[]>`
          INSERT INTO time_session
            (id, employee_id, device_id, opened_at, closed_at, closed_reason, reconstructed)
          VALUES (${id}, ${input.employeeId}, ${input.deviceId}, ${input.openedAt},
                  ${c?.at ?? null}, ${c?.reason ?? null}, ${c?.reconstructed ?? false})
          RETURNING id, employee_id, device_id, opened_at, closed_at, closed_reason, reconstructed
        `;
        const row = rows[0];
        if (!row) throw new Error('session insert returned no rows');
        return map(row);
      },
      close: async (id, closedAt, closedReason, reconstructed = false) => {
        // Only an open session changes; closing again is a no-op.
        const rows = await this.sql<TimeSessionRow[]>`
          UPDATE time_session
          SET closed_at = COALESCE(closed_at, ${closedAt}),
              closed_reason = COALESCE(closed_reason, ${closedReason}),
              reconstructed = CASE WHEN closed_at IS NULL
                                   THEN reconstructed OR ${reconstructed}
                                   ELSE reconstructed END
          WHERE id = ${id}
          RETURNING id, employee_id, device_id, opened_at, closed_at, closed_reason, reconstructed
        `;
        const row = rows[0];
        if (!row) throw new Error(`session ${id} not found`);
        return map(row);
      },
      findByEmployeeOpenedBetween: async (employeeId, from, to) => {
        const rows = await this.sql<TimeSessionRow[]>`
          SELECT id, employee_id, device_id, opened_at, closed_at, closed_reason, reconstructed
          FROM time_session
          WHERE employee_id = ${employeeId} AND opened_at >= ${from} AND opened_at < ${to}
          ORDER BY opened_at
        `;
        return rows.map(map);
      },
      findOpenByEmployeeId: async (employeeId) => {
        const rows = await this.sql<TimeSessionRow[]>`
          SELECT id, employee_id, device_id, opened_at, closed_at, closed_reason, reconstructed
          FROM time_session
          WHERE employee_id = ${employeeId} AND closed_at IS NULL
          LIMIT 1
        `;
        const row = rows[0];
        return row ? map(row) : null;
      },
      findById: async (id) => {
        const rows = await this.sql<TimeSessionRow[]>`
          SELECT id, employee_id, device_id, opened_at, closed_at, closed_reason, reconstructed
          FROM time_session WHERE id = ${id} LIMIT 1
        `;
        const row = rows[0];
        return row ? map(row) : null;
      },
    };
  }

  // -------------------------------------------------------------------
  // time_event
  // -------------------------------------------------------------------

  private buildTimeEventRepo(): TimeEventRepo {
    const map = (row: TimeEventRow): TimeEventRecord => ({
      eventUlid: row.eventUlid,
      eventType: row.eventType,
      sessionId: row.sessionId,
      employeeId: row.employeeId,
      sequenceNumber: row.sequenceNumber,
      clientTs: row.clientTs,
      serverTs: row.serverTs,
      monotonicNs: Number(row.monotonicNs),
      tzIana: row.tzIana,
      utcOffsetMinutes: row.utcOffsetMinutes,
      deviceId: row.deviceId,
      appVersion: row.appVersion,
      origin: row.origin,
      offlineCaptured: row.offlineCaptured,
      payload: row.payload,
      integritySignature: bufferToUint8(row.integritySignature),
      correlationId: row.correlationId,
      parentEventUlid: row.parentEventUlid,
    });

    return {
      insertOne: async (input: TimeEventInput): Promise<InsertEventResult> => {
        // First check for duplicate ULID — cheaper than triggering the
        // UNIQUE constraint and inspecting the error.
        const existingRows = await this.sql<TimeEventRow[]>`
          SELECT event_ulid, event_type, session_id, employee_id,
                 sequence_number, client_ts, server_ts, monotonic_ns,
                 tz_iana, utc_offset_minutes, device_id, app_version,
                 origin, offline_captured, payload, integrity_signature,
                 correlation_id, parent_event_ulid
          FROM time_event WHERE event_ulid = ${input.eventUlid} LIMIT 1
        `;
        const existing = existingRows[0];
        if (existing) {
          const existingSig = bufferToUint8(existing.integritySignature);
          if (!bytesEqual(existingSig, input.integritySignature)) {
            return {
              status: 'rejected',
              eventUlid: input.eventUlid,
              code: 'duplicate_ulid_different_payload',
              message: 'ULID already exists with a different signature',
            };
          }
          return {
            status: 'duplicate_noop',
            eventUlid: input.eventUlid,
            serverTs: existing.serverTs,
          };
        }

        try {
          const rows = await this.sql<TimeEventRow[]>`
            INSERT INTO time_event (
              event_ulid, event_type, session_id, employee_id,
              sequence_number, client_ts, monotonic_ns, tz_iana,
              utc_offset_minutes, device_id, app_version, origin,
              offline_captured, payload, integrity_signature,
              correlation_id, parent_event_ulid
            ) VALUES (
              ${input.eventUlid}, ${input.eventType}, ${input.sessionId}, ${input.employeeId},
              ${input.sequenceNumber}, ${input.clientTs}, ${input.monotonicNs}, ${input.tzIana},
              ${input.utcOffsetMinutes}, ${input.deviceId}, ${input.appVersion}, ${input.origin},
              ${input.offlineCaptured}, ${this.sql.json(input.payload as postgres.JSONValue)},
              ${Buffer.from(input.integritySignature)},
              ${input.correlationId}, ${input.parentEventUlid}
            )
            RETURNING event_ulid, event_type, session_id, employee_id,
                      sequence_number, client_ts, server_ts, monotonic_ns,
                      tz_iana, utc_offset_minutes, device_id, app_version,
                      origin, offline_captured, payload, integrity_signature,
                      correlation_id, parent_event_ulid
          `;
          const row = rows[0];
          if (!row) throw new Error('event insert returned no rows');
          const record = map(row);
          return { status: 'accepted', eventUlid: record.eventUlid, serverTs: record.serverTs };
        } catch (err) {
          // Unique (session_id, sequence_number) violation.
          if (err instanceof Error && /time_event_session_seq_uniq/.test(err.message)) {
            return {
              status: 'rejected',
              eventUlid: input.eventUlid,
              code: 'duplicate_sequence',
              message: `sequence ${input.sequenceNumber} already exists in session ${input.sessionId}`,
            };
          }
          throw err;
        }
      },
      findByUlid: async (ulid) => {
        const rows = await this.sql<TimeEventRow[]>`
          SELECT event_ulid, event_type, session_id, employee_id,
                 sequence_number, client_ts, server_ts, monotonic_ns,
                 tz_iana, utc_offset_minutes, device_id, app_version,
                 origin, offline_captured, payload, integrity_signature,
                 correlation_id, parent_event_ulid
          FROM time_event WHERE event_ulid = ${ulid} LIMIT 1
        `;
        const row = rows[0];
        return row ? map(row) : null;
      },
      findMaxSequenceForSession: async (sessionId) => {
        const rows = await this.sql<{ max: number | null }[]>`
          SELECT MAX(sequence_number) AS max FROM time_event WHERE session_id = ${sessionId}
        `;
        const row = rows[0];
        if (!row || row.max === null) return null;
        return Number(row.max);
      },
      findBySessionOrderedBySequence: async (sessionId) => {
        const rows = await this.sql<TimeEventRow[]>`
          SELECT event_ulid, event_type, session_id, employee_id,
                 sequence_number, client_ts, server_ts, monotonic_ns,
                 tz_iana, utc_offset_minutes, device_id, app_version,
                 origin, offline_captured, payload, integrity_signature,
                 correlation_id, parent_event_ulid
          FROM time_event
          WHERE session_id = ${sessionId}
          ORDER BY sequence_number ASC
        `;
        return rows.map(map);
      },
    };
  }
}

// ---------------------------------------------------------------------
// Row shapes — camelCase (via postgres.camel transform)
// ---------------------------------------------------------------------

interface PolicyOverrideRow {
  scope: PolicyScope;
  scopeId: string | null;
  document: Record<string, unknown>;
  reason: string | null;
  updatedByUserId: string;
  updatedAt: Date;
}

interface EmployeeRow {
  id: string;
  source: 'local_admin' | 'greythr';
  greythrEmployeeId: string | null;
  employeeNumber: string | null;
  givenName: string;
  familyName: string;
  displayName: string | null;
  status: EmploymentStatus;
  workEmail: string | null;
  departmentId: string | null;
  reportingManagerId: string | null;
  entraObjectId?: string | null;
}

interface AppUserRow {
  id: string;
  entraObjectId: string;
  workEmail: string;
  displayName: string;
  isServiceAccount: boolean;
  breakGlass: boolean;
  employeeId: string | null;
}

interface DeviceRow {
  id: string;
  userId: string;
  os: DeviceOs;
  hostnameHash: string;
  publicKeyEd25519: Buffer;
  appVersion: string;
  enrolledAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  revokedByUserId: string | null;
  signoutRequestedAt: Date | null;
  signoutRequestedBy: string | null;
}

interface TimeSessionRow {
  id: string;
  employeeId: string;
  deviceId: string;
  openedAt: Date;
  closedAt: Date | null;
  closedReason: SessionCloseReason | null;
  reconstructed: boolean;
}

interface TimeEventRow {
  eventUlid: string;
  eventType: string;
  sessionId: string;
  employeeId: string;
  sequenceNumber: number;
  clientTs: Date;
  serverTs: Date;
  monotonicNs: string | number;
  tzIana: string;
  utcOffsetMinutes: number;
  deviceId: string;
  appVersion: string;
  origin: EventOrigin;
  offlineCaptured: boolean;
  payload: Record<string, unknown>;
  integritySignature: Buffer;
  correlationId: string;
  parentEventUlid: string | null;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function bufferToUint8(b: Buffer): Uint8Array {
  // Postgres returns bytea columns as Buffer; convert to Uint8Array so
  // callers (crypto libraries, comparison helpers) see the same type
  // the in-memory impl produces.
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
