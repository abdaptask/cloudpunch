import { randomUUID } from 'node:crypto';
import type {
  PeopleRepo,
  RoleChangeAudit,
  WelcomeAudit,
  AppUser,
  AppUserRepo,
  ConnectionRepo,
  CorrectionDecision,
  CorrectionRepo,
  CorrectionWithDecisions,
  DbRepositories,
  NotWorkingDeclaration,
  Holiday,
  HolidayRepo,
  RoleDirectoryRepo,
  ShiftAlertClaim,
  ShiftAlertRepo,
  StartCounts,
  WeeklyReportRepo,
  ShiftAssignment,
  ShiftRepo,
  Device,
  DeviceConnection,
  DeviceEnrollInput,
  DeviceRepo,
  DeviceSignOutInput,
  Employee,
  EmployeeRepo,
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
  RecordStatusInput,
  SetManagerInput,
  ViewAudit,
} from './types.js';
import { CorrectionDecisionConflictError } from './types.js';

/**
 * In-memory repository backing. Used by unit and route tests to
 * exercise the full request → service → repo call graph without a
 * database. A Postgres implementation lands in slice 2a.3.
 *
 * Semantics deliberately match what Postgres will do:
 *   - Unique-open-session per employee is enforced.
 *   - Sequence-per-session uniqueness is enforced.
 *   - Duplicate event_ulid inserts are no-ops (idempotent).
 */
export class InMemoryDb implements DbRepositories {
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
  readonly holidays: HolidayRepo;
  readonly shiftAlerts: ShiftAlertRepo;
  readonly roles: RoleDirectoryRepo;
  readonly weeklyReports: WeeklyReportRepo;
  /** weekly_report_sent (ADR-0037 §4) as `${weekStart}:${recipient}`, for tests. */
  readonly weeklyReportRows: string[] = [];
  /** shift_alert rows (ADR-0037 §3), for tests. */
  readonly shiftAlertRows: ShiftAlertClaim[] = [];
  /** role_seen (ADR-0037), oid -> roles, for tests. */
  readonly roleSeen = new Map<string, { roles: string[]; source: 'token' | 'people' }>();
  /** holiday rows (ADR-0037), oldest first, for tests. */
  readonly holidayRows: Holiday[] = [];
  /** audit_log actions for holidays, for tests. */
  readonly holidayAudit: string[] = [];
  /** shift_assignment rows (ADR-0031), for tests. */
  readonly shiftRows: ShiftAssignment[] = [];
  /** not_working_day rows (ADR-0031), for tests. */
  readonly notWorkingRows: NotWorkingDeclaration[] = [];
  /** audit_log actions for shifts, for tests. */
  readonly shiftAudit: string[] = [];
  /** time_correction rows with their decisions (ADR-0030), for tests. */
  readonly correctionRows: CorrectionWithDecisions[] = [];
  /** audit_log rows for corrections (ADR-0030 §2), for tests. */
  readonly correctionAudit: { action: string; correctionId: string; actorUserId: string }[] = [];
  /** device_connection rows (ADR-0029), for tests. */
  readonly connectionRows: DeviceConnection[] = [];
  /** audit_log rows written by role changes, for tests. */
  readonly roleAudit: RoleChangeAudit[] = [];
  /** audit_log rows written by welcome emails, for tests. */
  readonly welcomeAudit: WelcomeAudit[] = [];
  /** Reporting-line changes (ADR-0025 §1), for tests. */
  readonly managerAudit: SetManagerInput[] = [];
  readonly statusAudit: RecordStatusInput[] = [];
  /** Read-audit rows (ADR-0025 §4), for tests. */
  readonly viewAudit: ViewAudit[] = [];
  /** Admin machine sign-outs (ADR-0028 §4) and when each closed, for tests. */
  readonly signOutAudit: (DeviceSignOutInput & { closed: Date | null })[] = [];

  private readonly policyByScope = new Map<string, PolicyOverride>();
  private readonly departmentById = new Map<string, { code: string; name: string }>();
  /** audit_log rows written by policy changes, for tests. */
  readonly audit: InMemoryAuditRow[] = [];
  private readonly employeeById = new Map<string, Employee>();
  private readonly employeeByOid = new Map<string, string>(); // oid -> employeeId
  private readonly userById = new Map<string, AppUser>();
  private readonly userByOid = new Map<string, string>();
  private readonly deviceById = new Map<string, Device>();
  private readonly sessionById = new Map<string, TimeSession>();
  private readonly eventByUlid = new Map<string, TimeEventRecord>();
  private readonly seqByEventKey = new Map<string, string>(); // `${sessionId}:${seq}` -> eventUlid

  constructor() {
    const copy = (c: CorrectionWithDecisions): CorrectionWithDecisions => ({
      ...c,
      decisions: c.decisions.map((d) => ({ ...d })),
    });
    const FINAL = new Set(['approved', 'rejected', 'withdrawn']);
    this.holidays = {
      record: async (i) => {
        const row: Holiday = {
          id: randomUUID(),
          date: i.date,
          name: i.name,
          cancelled: i.cancelled,
          addedByUserId: i.addedByUserId,
          addedAt: i.at,
        };
        this.holidayRows.push(row);
        this.holidayAudit.push(i.cancelled ? 'holiday_removed' : 'holiday_added');
        return { ...row };
      },
      between: async (from, to) => {
        const latest = new Map<string, Holiday>();
        for (const r of this.holidayRows) {
          const prev = latest.get(r.date);
          if (!prev || r.addedAt >= prev.addedAt) latest.set(r.date, r);
        }
        return [...latest.values()]
          .filter((r) => !r.cancelled && r.date >= from && r.date <= to)
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((r) => ({ ...r }));
      },
    };
    this.shiftAlerts = {
      sent: async (ids, dates) =>
        new Set(
          this.shiftAlertRows
            .filter((r) => ids.includes(r.employeeId) && dates.includes(r.shiftDate))
            .map((r) => `${r.employeeId}:${r.shiftDate}:${r.kind}`),
        ),
      claimAndSend: async (c, send) => {
        const taken = this.shiftAlertRows.some(
          (r) => r.employeeId === c.employeeId && r.shiftDate === c.shiftDate && r.kind === c.kind,
        );
        if (taken) return false;
        const row = { ...c, sentTo: [...c.sentTo] };
        this.shiftAlertRows.push(row);
        try {
          await send();
        } catch (err) {
          this.shiftAlertRows.splice(this.shiftAlertRows.indexOf(row), 1);
          throw err;
        }
        return true;
      },
      countsSince: async (since) => {
        const out = new Map<string, StartCounts>();
        for (const r of this.shiftAlertRows) {
          if (r.shiftDate < since || r.kind === 'late_clock_in') continue;
          const c = out.get(r.employeeId) ?? { missed: 0, notWorking: 0 };
          if (r.kind === 'missed') c.missed += 1;
          else c.notWorking += 1;
          out.set(r.employeeId, c);
        }
        return out;
      },
    };
    this.weeklyReports = {
      claimAndSend: async (week, recipient, _people, _at, send) => {
        const key = `${week}:${recipient.toLowerCase()}`;
        if (this.weeklyReportRows.includes(key)) return false;
        this.weeklyReportRows.push(key);
        try {
          await send();
        } catch (err) {
          this.weeklyReportRows.splice(this.weeklyReportRows.indexOf(key), 1);
          throw err;
        }
        return true;
      },
    };
    this.roles = {
      note: async (oid, roles, source) => {
        this.roleSeen.set(oid, { roles: [...roles], source });
      },
      holders: async (roles) => {
        const out: { oid: string; email: string }[] = [];
        for (const [oid, seen] of this.roleSeen) {
          if (!seen.roles.some((r) => roles.includes(r))) continue;
          const userId = this.userByOid.get(oid);
          const email = userId ? this.userById.get(userId)?.workEmail : undefined;
          if (email) out.push({ oid, email });
        }
        return out;
      },
    };
    this.shifts = {
      assign: async (i) => {
        const row: ShiftAssignment = {
          id: randomUUID(),
          employeeId: i.employeeId,
          days: [...i.days],
          start: i.start,
          end: i.end,
          tzIana: i.tzIana,
          effectiveFrom: i.effectiveFrom,
          reason: i.reason,
          assignedByUserId: i.assignedByUserId,
          assignedAt: i.at,
        };
        this.shiftRows.push(row);
        this.shiftAudit.push('shift_assigned');
        return { ...row };
      },
      history: async (ids) =>
        this.shiftRows
          .filter((r) => ids.includes(r.employeeId))
          .sort(
            (a, b) =>
              b.effectiveFrom.localeCompare(a.effectiveFrom) ||
              b.assignedAt.getTime() - a.assignedAt.getTime(),
          )
          .map((r) => ({ ...r, days: [...r.days] })),
      declareNotWorking: async (i) => {
        if (
          this.notWorkingRows.some(
            (r) => r.employeeId === i.employeeId && r.shiftDate === i.shiftDate,
          )
        ) {
          return false;
        }
        this.notWorkingRows.push({ ...i });
        this.shiftAudit.push('not_working_declared');
        return true;
      },
      notWorking: async (ids, dates) =>
        new Set(
          this.notWorkingRows
            .filter((r) => ids.includes(r.employeeId) && dates.includes(r.shiftDate))
            .map((r) => `${r.employeeId}:${r.shiftDate}`),
        ),
    };
    this.corrections = {
      request: async (i) => {
        const c: CorrectionWithDecisions = {
          id: randomUUID(),
          employeeId: i.employeeId,
          fromAt: i.fromAt,
          toAt: i.toAt,
          tzIana: i.tzIana,
          utcOffsetMinutes: i.utcOffsetMinutes,
          kind: i.kind,
          reason: i.reason,
          requestedByUserId: i.requestedByUserId,
          requestedAt: i.at,
          decisions: i.endorse
            ? [
                {
                  id: randomUUID(),
                  correctionId: '',
                  decision: 'endorsed',
                  decidedByUserId: i.requestedByUserId,
                  decidedAt: i.at,
                  note: null,
                },
              ]
            : [],
        };
        for (const d of c.decisions) d.correctionId = c.id;
        this.correctionRows.push(c);
        this.correctionAudit.push({
          action: 'correction_requested',
          correctionId: c.id,
          actorUserId: i.requestedByUserId,
        });
        return copy(c);
      },
      decide: async (i) => {
        const c = this.correctionRows.find((x) => x.id === i.correctionId);
        if (!c) throw new Error(`correction ${i.correctionId} not found`);
        const clash = c.decisions.some((d) =>
          i.decision === 'endorsed'
            ? d.decision === 'endorsed'
            : FINAL.has(d.decision) && FINAL.has(i.decision),
        );
        if (clash) throw new CorrectionDecisionConflictError(c.id);
        const d: CorrectionDecision = {
          id: randomUUID(),
          correctionId: c.id,
          decision: i.decision,
          decidedByUserId: i.decidedByUserId,
          decidedAt: i.at,
          note: i.note,
        };
        c.decisions.push(d);
        this.correctionAudit.push({
          action: `correction_${i.decision}`,
          correctionId: c.id,
          actorUserId: i.decidedByUserId,
        });
        return { ...d };
      },
      findById: async (id) => {
        const c = this.correctionRows.find((x) => x.id === id);
        return c ? copy(c) : null;
      },
      listForEmployee: async (employeeId, from, to) =>
        this.correctionRows
          .filter((c) => c.employeeId === employeeId && c.fromAt < to && c.toAt > from)
          .sort((a, b) => a.fromAt.getTime() - b.fromAt.getTime())
          .map(copy),
      listOpen: async () =>
        this.correctionRows
          .filter((c) => !c.decisions.some((d) => FINAL.has(d.decision)))
          .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
          .map(copy),
    };
    this.connections = {
      latestForDevice: async (deviceId) => {
        const mine = this.connectionRows.filter((c) => c.deviceId === deviceId);
        mine.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
        return mine[0] ? { ...mine[0] } : null;
      },
      insert: async (input) => {
        const row = { id: randomUUID(), ...input };
        this.connectionRows.push(row);
        return { ...row };
      },
      touch: async (id, at) => {
        const row = this.connectionRows.find((c) => c.id === id);
        if (row && at > row.lastSeenAt) row.lastSeenAt = at;
      },
      listForEmployee: async (employeeId, since) =>
        this.connectionRows
          .filter((c) => c.employeeId === employeeId && c.lastSeenAt >= since)
          .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
          .map((c) => ({ ...c })),
      latestForEmployees: async (employeeIds, since) => {
        const out = new Map<string, DeviceConnection>();
        for (const c of this.connectionRows) {
          if (!employeeIds.includes(c.employeeId) || c.lastSeenAt < since) continue;
          const prior = out.get(c.employeeId);
          if (!prior || c.lastSeenAt > prior.lastSeenAt) out.set(c.employeeId, { ...c });
        }
        return out;
      },
    };
    this.policies = {
      find: async (scope, scopeId) => this.policyByScope.get(policyKey(scope, scopeId)) ?? null,
      put: async (change, document) => {
        const key = policyKey(change.scope, change.scopeId);
        const previous = this.policyByScope.get(key) ?? null;
        this.policyByScope.set(key, {
          scope: change.scope,
          scopeId: change.scopeId,
          document: structuredClone(document),
          reason: change.reason,
          updatedByUserId: change.actorUserId,
          updatedAt: change.at,
        });
        this.audit.push(auditRow(change, 'policy_set', previous?.document ?? null, document));
        return previous;
      },
      remove: async (change) => {
        const key = policyKey(change.scope, change.scopeId);
        const previous = this.policyByScope.get(key) ?? null;
        if (!previous) return null;
        this.policyByScope.delete(key);
        this.audit.push(auditRow(change, 'policy_clear', previous.document, null));
        return previous;
      },
    };
    this.people = {
      provision: async (input) => {
        const existing = this.employeeByOid.get(input.oid);
        if (existing) return { employeeId: existing, created: false };
        const employeeId = randomUUID();
        this.employeeById.set(employeeId, {
          id: employeeId,
          source: 'local_admin',
          greythrEmployeeId: null,
          employeeNumber: null,
          givenName: input.givenName,
          familyName: input.familyName,
          displayName: `${input.givenName} ${input.familyName}`.trim(),
          workEmail: input.email ?? '',
          status: 'active',
          departmentId: null,
        });
        const userId = this.userByOid.get(input.oid) ?? randomUUID();
        this.userById.set(userId, {
          id: userId,
          entraObjectId: input.oid,
          workEmail: input.email ?? '',
          displayName: `${input.givenName} ${input.familyName}`.trim(),
          isServiceAccount: false,
          breakGlass: false,
          employeeId,
        });
        this.userByOid.set(input.oid, userId);
        this.employeeByOid.set(input.oid, employeeId);
        return { employeeId, created: true };
      },
      setRecordActive: async (i) => {
        const e = this.employeeById.get(i.employeeId);
        const from = i.active ? 'inactive' : 'active';
        if (e?.status !== from) return { changed: false, unassigned: [] };
        this.employeeById.set(e.id, { ...e, status: i.active ? 'active' : 'inactive' });
        this.statusAudit.push(i);
        if (i.active) return { changed: true, unassigned: [] };
        const unassigned = this.activeByName()
          .filter((r) => r.reportingManagerId === e.id)
          .map((r) => {
            this.employeeById.set(r.id, { ...r, reportingManagerId: null });
            this.managerAudit.push({ ...i, employeeId: r.id, managerId: null });
            return { id: r.id, name: r.displayName ?? `${r.givenName} ${r.familyName}` };
          });
        return { changed: true, unassigned };
      },
      auditRoleChange: async (entry) => {
        this.roleAudit.push(entry);
      },
      auditWelcome: async (entry) => {
        this.welcomeAudit.push(entry);
      },
      lastWelcomeAt: async (oid) =>
        this.welcomeAudit
          .filter((w) => w.targetOid === oid)
          .reduce<Date | null>((a, w) => (a && a > w.at ? a : w.at), null),
    };
    this.departments = {
      exists: async (id) => this.departmentById.has(id),
      list: async () =>
        [...this.departmentById.entries()]
          .map(([id, d]) => ({ id, ...d }))
          .sort((a, b) => a.name.localeCompare(b.name)),
    };
    this.employees = {
      findById: async (id) => this.employeeById.get(id) ?? null,
      findByEntraObjectId: async (oid) => {
        const id = this.employeeByOid.get(oid);
        return id ? (this.employeeById.get(id) ?? null) : null;
      },
      listReports: async (managerId) =>
        this.activeByName().filter((e) => e.reportingManagerId === managerId),
      listActive: async () =>
        this.activeByName().map((e) => ({
          ...e,
          entraObjectId:
            [...this.employeeByOid.entries()].find(([, id]) => id === e.id)?.[0] ?? null,
        })),
      setReportingManager: async (input) => {
        const e = this.employeeById.get(input.employeeId);
        if (e) this.employeeById.set(e.id, { ...e, reportingManagerId: input.managerId });
        this.managerAudit.push(input);
      },
      auditView: async (entry) => {
        this.viewAudit.push(entry);
      },
    };

    this.users = {
      findById: async (id) => this.userById.get(id) ?? null,
      findByEntraObjectId: async (oid) => {
        const id = this.userByOid.get(oid);
        return id ? (this.userById.get(id) ?? null) : null;
      },
    };

    this.devices = {
      enroll: async (input) => this.enrollDevice(input),
      findById: async (id) => this.deviceById.get(id) ?? null,
      findByUserId: async (userId) =>
        Array.from(this.deviceById.values()).filter((d) => d.userId === userId),
      revoke: async (id, reason, byUserId, at) => this.revokeDevice(id, reason, byUserId, at),
      touchLastSeen: async (id, at, appVersion) => {
        const d = this.deviceById.get(id);
        if (d) {
          this.deviceById.set(id, { ...d, lastSeenAt: at, appVersion: appVersion ?? d.appVersion });
        }
      },
      listWithOwners: async () =>
        Array.from(this.deviceById.values())
          .map((d) => {
            const owner = this.userById.get(d.userId);
            return {
              ...d,
              ownerWorkEmail: owner?.workEmail ?? '',
              ownerDisplayName: owner?.displayName ?? '',
            };
          })
          .sort(byLastSeenDesc),
      signOut: async (input) => {
        const d = this.deviceById.get(input.deviceId);
        if (!d) throw new Error(`device ${input.deviceId} not found`);
        let closedAt: Date | null = null;
        const s = input.sessionId ? this.sessionById.get(input.sessionId) : undefined;
        if (s && s.closedAt === null && input.closedAt) {
          closedAt = (await this.closeSession(s.id, input.closedAt, 'remote_takeover', true))
            .closedAt;
        }
        this.deviceById.set(d.id, {
          ...d,
          signoutRequestedAt: input.at,
          signoutRequestedBy: input.actorUserId,
        });
        this.signOutAudit.push({ ...input, closed: closedAt });
        return { closedAt };
      },
      clearSignOut: async (id) => {
        const d = this.deviceById.get(id);
        if (d)
          this.deviceById.set(id, { ...d, signoutRequestedAt: null, signoutRequestedBy: null });
      },
    };

    this.timeSessions = {
      open: async (input) => this.openSession(input),
      close: async (id, closedAt, closedReason, reconstructed) =>
        this.closeSession(id, closedAt, closedReason, reconstructed ?? false),
      findOpenByEmployeeId: async (employeeId) =>
        Array.from(this.sessionById.values()).find(
          (s) => s.employeeId === employeeId && s.closedAt === null,
        ) ?? null,
      findById: async (id) => this.sessionById.get(id) ?? null,
      findByEmployeeOpenedBetween: async (employeeId, from, to) =>
        Array.from(this.sessionById.values())
          .filter((s) => s.employeeId === employeeId && s.openedAt >= from && s.openedAt < to)
          .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime()),
    };

    this.timeEvents = {
      insertOne: async (input) => this.insertEvent(input),
      findByUlid: async (ulid) => this.eventByUlid.get(ulid) ?? null,
      findMaxSequenceForSession: async (sessionId) => {
        let max: number | null = null;
        for (const e of this.eventByUlid.values()) {
          if (e.sessionId === sessionId && (max === null || e.sequenceNumber > max)) {
            max = e.sequenceNumber;
          }
        }
        return max;
      },
      findBySessionOrderedBySequence: async (sessionId) => {
        const items: TimeEventRecord[] = [];
        for (const e of this.eventByUlid.values()) {
          if (e.sessionId === sessionId) items.push(e);
        }
        items.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        return items;
      },
    };
  }

  // ---------------------------------------------------------------
  // Seed helpers — used by tests to set up a starting state
  // ---------------------------------------------------------------

  seedDepartment(id: string, name = `Department ${id.slice(0, 4)}`): this {
    this.departmentById.set(id, { code: name.toUpperCase().replace(/\W+/g, '_'), name });
    return this;
  }

  seedPolicy(o: PolicyOverride): this {
    this.policyByScope.set(policyKey(o.scope, o.scopeId), o);
    return this;
  }

  private activeByName(): Employee[] {
    const name = (e: Employee): string => e.displayName ?? `${e.givenName} ${e.familyName}`;
    return [...this.employeeById.values()]
      .filter((e) => e.status === 'active')
      .sort((a, b) => name(a).localeCompare(name(b)));
  }

  seedEmployee(e: Employee): this {
    this.employeeById.set(e.id, e);
    return this;
  }

  seedUser(u: AppUser, oid?: string): this {
    this.userById.set(u.id, u);
    this.userByOid.set(oid ?? u.entraObjectId, u.id);
    if (u.employeeId) {
      this.employeeByOid.set(oid ?? u.entraObjectId, u.employeeId);
    }
    return this;
  }

  seedDevice(d: Device): this {
    this.deviceById.set(d.id, d);
    return this;
  }

  // ---------------------------------------------------------------
  // Device operations
  // ---------------------------------------------------------------

  private async enrollDevice(input: DeviceEnrollInput): Promise<Device> {
    const existing = this.deviceById.get(input.id);
    if (existing) {
      if (existing.userId !== input.userId) {
        throw new Error(`device ${input.id} already enrolled by a different user`);
      }
      // Re-enrollment refreshes the public key and app_version but preserves
      // enrolled_at + revocation status.
      const updated: Device = {
        ...existing,
        publicKeyEd25519: input.publicKeyEd25519,
        appVersion: input.appVersion,
        hostnameHash: input.hostnameHash,
        os: input.os,
      };
      this.deviceById.set(input.id, updated);
      return updated;
    }
    const device: Device = {
      id: input.id,
      userId: input.userId,
      os: input.os,
      hostnameHash: input.hostnameHash,
      publicKeyEd25519: input.publicKeyEd25519,
      appVersion: input.appVersion,
      enrolledAt: new Date(),
      lastSeenAt: null,
      revokedAt: null,
      revokedReason: null,
      revokedByUserId: null,
      signoutRequestedAt: null,
      signoutRequestedBy: null,
    };
    this.deviceById.set(device.id, device);
    return device;
  }

  private async revokeDevice(
    id: string,
    reason: string,
    byUserId: string,
    at: Date,
  ): Promise<void> {
    const d = this.deviceById.get(id);
    if (!d) throw new Error(`device ${id} not found`);
    if (d.revokedAt) return; // idempotent
    this.deviceById.set(id, {
      ...d,
      revokedAt: at,
      revokedReason: reason,
      revokedByUserId: byUserId,
    });
  }

  // ---------------------------------------------------------------
  // Session operations
  // ---------------------------------------------------------------

  private async openSession(input: OpenSessionInput): Promise<TimeSession> {
    // Idempotent: if the client-supplied id already exists, return it
    // unchanged. This lets a retried USER_CLOCK_IN behave as a no-op.
    if (input.id) {
      const existing = this.sessionById.get(input.id);
      if (existing) return existing;
    }
    // Enforce the unique-open-per-employee invariant (a session inserted
    // already closed doesn't count, as with the partial index).
    for (const s of this.sessionById.values()) {
      if (!input.closed && s.employeeId === input.employeeId && s.closedAt === null) {
        throw new SessionOpenConflictError(input.employeeId, s.id);
      }
    }
    const session: TimeSession = {
      id: input.id ?? randomUUID(),
      employeeId: input.employeeId,
      deviceId: input.deviceId,
      openedAt: input.openedAt,
      closedAt: input.closed?.at ?? null,
      closedReason: input.closed?.reason ?? null,
      reconstructed: input.closed?.reconstructed ?? false,
    };
    this.sessionById.set(session.id, session);
    return session;
  }

  private async closeSession(
    id: string,
    closedAt: Date,
    closedReason: SessionCloseReason,
    reconstructed: boolean,
  ): Promise<TimeSession> {
    const s = this.sessionById.get(id);
    if (!s) throw new Error(`session ${id} not found`);
    if (s.closedAt !== null) return s; // idempotent
    const closed: TimeSession = {
      ...s,
      closedAt,
      closedReason,
      reconstructed: s.reconstructed || reconstructed,
    };
    this.sessionById.set(id, closed);
    return closed;
  }

  // ---------------------------------------------------------------
  // Event operations
  // ---------------------------------------------------------------

  private async insertEvent(input: TimeEventInput): Promise<InsertEventResult> {
    // Idempotent by event_ulid
    const existing = this.eventByUlid.get(input.eventUlid);
    if (existing) {
      // Compare on the signed subset — a duplicate ULID with a different
      // payload is a replay-attack red flag surfaced by the caller.
      if (existing.integritySignature.length !== input.integritySignature.length) {
        return {
          status: 'rejected',
          eventUlid: input.eventUlid,
          code: 'duplicate_ulid_different_payload',
          message: 'ULID already exists with a different signature',
        };
      }
      let same = true;
      for (let i = 0; i < existing.integritySignature.length; i++) {
        if (existing.integritySignature[i] !== input.integritySignature[i]) {
          same = false;
          break;
        }
      }
      if (!same) {
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

    // Sequence uniqueness within a session
    const key = `${input.sessionId}:${input.sequenceNumber}`;
    if (this.seqByEventKey.has(key)) {
      return {
        status: 'rejected',
        eventUlid: input.eventUlid,
        code: 'duplicate_sequence',
        message: `sequence ${input.sequenceNumber} already exists in session ${input.sessionId}`,
      };
    }

    const record: TimeEventRecord = {
      ...input,
      serverTs: new Date(),
    };
    this.eventByUlid.set(input.eventUlid, record);
    this.seqByEventKey.set(key, input.eventUlid);
    return { status: 'accepted', eventUlid: input.eventUlid, serverTs: record.serverTs };
  }
}

export class SessionOpenConflictError extends Error {
  constructor(
    public readonly employeeId: string,
    public readonly openSessionId: string,
  ) {
    super(`employee ${employeeId} already has an open session ${openSessionId}`);
    this.name = 'SessionOpenConflictError';
  }
}

/** Most recently seen first; never-seen devices last, newest enrolment first. */
function byLastSeenDesc(a: Device, b: Device): number {
  const seen = (b.lastSeenAt?.getTime() ?? -1) - (a.lastSeenAt?.getTime() ?? -1);
  return seen !== 0 ? seen : b.enrolledAt.getTime() - a.enrolledAt.getTime();
}

function policyKey(scope: PolicyScope, scopeId: string | null): string {
  return `${scope}:${scopeId ?? ''}`;
}

export interface InMemoryAuditRow {
  actorUserId: string;
  entityType: 'policy_override';
  entityId: string | null;
  action: 'policy_set' | 'policy_clear';
  previousValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  reason: string | null;
  correlationId: string;
}

/** The audit_log row for a policy change (policy doc §14). */
function auditRow(
  change: PolicyChange,
  action: InMemoryAuditRow['action'],
  previous: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): InMemoryAuditRow {
  return {
    actorUserId: change.actorUserId,
    entityType: 'policy_override',
    entityId: change.scopeId,
    action,
    previousValue: previous ? { scope: change.scope, document: previous } : null,
    newValue: next ? { scope: change.scope, document: structuredClone(next) } : null,
    reason: change.reason,
    correlationId: change.correlationId,
  };
}
