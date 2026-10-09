/**
 * Repository interfaces the backend uses to reach persistence. Every
 * concrete implementation (in-memory for tests, Postgres for prod)
 * satisfies these contracts.
 *
 * Field naming: camelCase in TypeScript; the Postgres implementation
 * translates to/from snake_case columns at its boundary.
 */

export type EmploymentStatus = 'active' | 'inactive' | 'terminated' | 'on_leave';
export type DeviceOs = 'windows' | 'macos';
export type EventOrigin = 'user' | 'system_watcher' | 'server' | 'reconstructed';

export type SessionCloseReason =
  | 'user_clock_out'
  | 'idle_auto_clock_out'
  | 'idle_cap'
  | 'app_exit_reconstructed'
  | 'system_shutdown_reconstructed'
  | 'greythr_termination_forced'
  | 'remote_takeover'
  | 'error_frozen';

// ---------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------

export interface Employee {
  id: string;
  source: 'local_admin' | 'greythr';
  greythrEmployeeId: string | null;
  employeeNumber: string | null;
  givenName: string;
  familyName: string;
  displayName: string | null;
  workEmail: string;
  status: EmploymentStatus;
  /** Team scope for policy (ADR-0015). Absent means no department. */
  departmentId?: string | null;
  /** Direct manager (ADR-0005, ADR-0025 §1). Absent means none. */
  reportingManagerId?: string | null;
  /** The linked user's Entra object id, where a list includes it. */
  entraObjectId?: string | null;
}

/** Setting someone's manager (ADR-0025 §1), audited. */
export interface SetManagerInput {
  employeeId: string;
  managerId: string | null;
  actorUserId: string;
  reason: string | null;
  correlationId: string;
  at: Date;
}

/** Someone opened another person's day or exceptions (ADR-0025 §4). */
export interface ViewAudit {
  actorUserId: string;
  employeeId: string;
  action: 'day_viewed' | 'exceptions_viewed' | 'connections_viewed';
  /** The date(s) viewed, e.g. `{ from, to }`. */
  detail: Record<string, string>;
  correlationId: string;
  at: Date;
}

export interface AppUser {
  id: string;
  entraObjectId: string;
  workEmail: string;
  displayName: string;
  isServiceAccount: boolean;
  breakGlass: boolean;
  employeeId: string | null;
}

export interface Device {
  id: string;
  userId: string;
  os: DeviceOs;
  hostnameHash: string;
  publicKeyEd25519: Uint8Array;
  appVersion: string;
  enrolledAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  revokedByUserId: string | null;
  /**
   * An Administrator signed this machine out (ADR-0028 §4). Until it
   * re-enrols, its event batches get 409 `device_signed_out`. Absent
   * is the same as null.
   */
  signoutRequestedAt?: Date | null;
  /** The Administrator's app_user id, with `signoutRequestedAt`. */
  signoutRequestedBy?: string | null;
}

/** A device plus who enrolled it, for the admin device list. */
export interface DeviceWithOwner extends Device {
  ownerWorkEmail: string;
  ownerDisplayName: string;
}

export interface TimeSession {
  id: string;
  employeeId: string;
  deviceId: string;
  openedAt: Date;
  closedAt: Date | null;
  closedReason: SessionCloseReason | null;
  reconstructed: boolean;
}

export interface TimeEventRecord {
  eventUlid: string;
  eventType: string;
  sessionId: string;
  employeeId: string;
  sequenceNumber: number;
  clientTs: Date;
  serverTs: Date;
  monotonicNs: number;
  tzIana: string;
  utcOffsetMinutes: number;
  deviceId: string;
  appVersion: string;
  origin: EventOrigin;
  offlineCaptured: boolean;
  payload: Record<string, unknown>;
  integritySignature: Uint8Array;
  correlationId: string;
  parentEventUlid: string | null;
}

// ---------------------------------------------------------------------
// Input DTOs
// ---------------------------------------------------------------------

export interface DeviceEnrollInput {
  id: string; // client-generated UUID
  userId: string;
  os: DeviceOs;
  hostnameHash: string;
  publicKeyEd25519: Uint8Array;
  appVersion: string;
}

/**
 * An Administrator signing a machine out (ADR-0028 §4). Closes the
 * open session on it (if any), marks the device signed out and writes
 * the audit_log row, together.
 */
export interface DeviceSignOutInput {
  deviceId: string;
  /** Whose machine it is (for the audit row). */
  employeeId: string;
  /** The open session on that device, or null if it has none. */
  sessionId: string | null;
  /** When to close it: its last event time, kept within [opened_at, now]. */
  closedAt: Date | null;
  actorUserId: string;
  correlationId: string;
  at: Date;
}

export interface OpenSessionInput {
  /**
   * Client-generated session id. Passing the same id twice is
   * idempotent — the existing session is returned. Omitting it lets
   * the repo generate one (used by tests and admin-side helpers).
   */
  id?: string | undefined;
  employeeId: string;
  deviceId: string;
  openedAt: Date;
  /**
   * Insert it already closed: a delayed clock-in from before the
   * device's open session is history, never the live session (ingest,
   * 2026-10-07). A closed row doesn't count against one-open-session.
   */
  closed?: { at: Date; reason: SessionCloseReason; reconstructed: boolean } | undefined;
}

export interface TimeEventInput {
  eventUlid: string;
  eventType: string;
  sessionId: string;
  employeeId: string;
  sequenceNumber: number;
  clientTs: Date;
  monotonicNs: number;
  tzIana: string;
  utcOffsetMinutes: number;
  deviceId: string;
  appVersion: string;
  origin: EventOrigin;
  offlineCaptured: boolean;
  payload: Record<string, unknown>;
  integritySignature: Uint8Array;
  correlationId: string;
  parentEventUlid: string | null;
}

export type InsertEventResult =
  | { status: 'accepted'; eventUlid: string; serverTs: Date }
  | { status: 'duplicate_noop'; eventUlid: string; serverTs: Date }
  | {
      status: 'rejected';
      eventUlid: string;
      code:
        | 'signature_invalid'
        | 'session_not_open'
        | 'sequence_gap_too_large'
        | 'duplicate_sequence'
        | 'duplicate_ulid_different_payload'
        | 'device_revoked'
        | 'state_transition_invalid'
        | 'employee_status_forbidden'
        | 'validation';
      message: string;
    };

// ---------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------

export interface EmployeeRepo {
  findById(id: string): Promise<Employee | null>;
  findByEntraObjectId(oid: string): Promise<Employee | null>;
  /** Active direct reports of `managerId`, by name (ADR-0025 §2). */
  listReports(managerId: string): Promise<Employee[]>;
  /** Every active employee, by name (HR's scope). */
  listActive(): Promise<Employee[]>;
  /** Set or clear `employeeId`'s manager and write the audit row. */
  setReportingManager(input: SetManagerInput): Promise<void>;
  /** Write a read-audit row (ADR-0025 §4). */
  auditView(entry: ViewAudit): Promise<void>;
}

export interface AppUserRepo {
  findById(id: string): Promise<AppUser | null>;
  findByEntraObjectId(oid: string): Promise<AppUser | null>;
}

export interface DeviceRepo {
  enroll(input: DeviceEnrollInput): Promise<Device>;
  findById(id: string): Promise<Device | null>;
  findByUserId(userId: string): Promise<readonly Device[]>;
  revoke(id: string, reason: string, byUserId: string, at: Date): Promise<void>;
  /** Also records the version the device last sent events with. */
  touchLastSeen(id: string, at: Date, appVersion?: string): Promise<void>;
  /** Every device with its owner, most recently seen first. */
  listWithOwners(): Promise<readonly DeviceWithOwner[]>;
  /**
   * ADR-0028 §4: close the device's open session as `remote_takeover`
   * (reconstructed), set `signout_requested_*` and write the audit row,
   * in one transaction. Returns when the session was closed, or null if
   * there was none (or it had already closed). Repeating is harmless.
   */
  signOut(input: DeviceSignOutInput): Promise<{ closedAt: Date | null }>;
  /** Clear `signout_requested_*` (the device enrolled again after signing in). */
  clearSignOut(id: string): Promise<void>;
}

export interface TimeSessionRepo {
  open(input: OpenSessionInput): Promise<TimeSession>;
  /**
   * Close a session. Idempotent: an already-closed session is returned
   * unchanged. `reconstructed` marks a close the agent did not observe
   * (crash recovery, ADR-0003 §10) for manager review.
   */
  close(
    id: string,
    closedAt: Date,
    closedReason: SessionCloseReason,
    reconstructed?: boolean,
  ): Promise<TimeSession>;
  findOpenByEmployeeId(employeeId: string): Promise<TimeSession | null>;
  /** Sessions clocked in within [from, to), oldest first (day history, ADR-0016). */
  findByEmployeeOpenedBetween(
    employeeId: string,
    from: Date,
    to: Date,
  ): Promise<readonly TimeSession[]>;
  findById(id: string): Promise<TimeSession | null>;
}

export interface TimeEventRepo {
  insertOne(input: TimeEventInput): Promise<InsertEventResult>;
  findByUlid(ulid: string): Promise<TimeEventRecord | null>;
  findMaxSequenceForSession(sessionId: string): Promise<number | null>;
  /**
   * Return every event for a session ordered by sequence_number ASC.
   * Bounded per session (typically < 50 events per shift). Used by the
   * state-machine derivation at ingest time.
   */
  findBySessionOrderedBySequence(sessionId: string): Promise<readonly TimeEventRecord[]>;
}

/** ADR-0015 §1. */
export type PolicyScope = 'global' | 'department' | 'employee';

/** A partial policy document stored for one scope. */
export interface PolicyOverride {
  scope: PolicyScope;
  /** Null for `global`; a department or employee id otherwise. */
  scopeId: string | null;
  document: Record<string, unknown>;
  reason: string | null;
  updatedByUserId: string;
  updatedAt: Date;
}

/** Who changed a policy, and why (written to audit_log with it). */
export interface PolicyChange {
  scope: PolicyScope;
  scopeId: string | null;
  reason: string | null;
  actorUserId: string;
  correlationId: string;
  at: Date;
}

export interface PolicyRepo {
  /** The override stored for one scope, if any. */
  find(scope: PolicyScope, scopeId: string | null): Promise<PolicyOverride | null>;
  /**
   * Insert or replace the override for `change`'s scope and write the
   * `audit_log` row (action `policy_set`) in one transaction. Returns
   * the override that was replaced, if any.
   */
  put(change: PolicyChange, document: Record<string, unknown>): Promise<PolicyOverride | null>;
  /**
   * Remove the override and write the audit row (`policy_clear`) in one
   * transaction. Returns what was removed; null (and no audit row) if
   * there was nothing.
   */
  remove(change: PolicyChange): Promise<PolicyOverride | null>;
}

export interface Department {
  id: string;
  code: string;
  name: string;
}

export interface DepartmentRepo {
  exists(id: string): Promise<boolean>;
  /** Every department, by name (for the HR settings picker). */
  list(): Promise<Department[]>;
}

/** Someone to link to an employee record, from the directory (ADR-0020). */
export interface ProvisionInput {
  oid: string;
  email: string | null;
  givenName: string;
  familyName: string;
}

/** Records follow roles (ADR-0020 §4): turn an employee record on or off. */
export interface RecordStatusInput {
  employeeId: string;
  active: boolean;
  actorUserId: string;
  reason: string | null;
  correlationId: string;
  at: Date;
}

/** A change to someone's CloudPunch roles, for audit_log. */
export interface RoleChangeAudit {
  actorUserId: string;
  targetOid: string;
  previousRoles: readonly string[];
  newRoles: readonly string[];
  reason: string | null;
  correlationId: string;
  at: Date;
}

/** A welcome email sent (ADR-0021), for audit_log. */
export interface WelcomeAudit {
  actorUserId: string;
  targetOid: string;
  to: string;
  cc: readonly string[];
  correlationId: string;
  at: Date;
}

export interface PeopleRepo {
  /**
   * Make sure `input.oid` has an app_user linked to an active employee
   * (source `local_admin`). Idempotent: an existing link is left alone.
   */
  provision(input: ProvisionInput): Promise<{ employeeId: string; created: boolean }>;
  /**
   * `active` → 'active' from 'inactive', or 'active' → 'inactive' (other
   * statuses are left alone). Turning a record off also clears the
   * manager of everyone who reported to it. Each change is audited.
   */
  setRecordActive(
    input: RecordStatusInput,
  ): Promise<{ changed: boolean; unassigned: { id: string; name: string }[] }>;
  /** Write the audit_log row (action `roles_set`). */
  auditRoleChange(entry: RoleChangeAudit): Promise<void>;
  /** Write the audit_log row (action `welcome_sent`). */
  auditWelcome(entry: WelcomeAudit): Promise<void>;
  /** When `oid` was last sent a welcome email, from audit_log. */
  lastWelcomeAt(oid: string): Promise<Date | null>;
}

/** ADR-0029 §1: where a device connected from, one row per network. */
export interface DeviceConnection {
  id: string;
  employeeId: string;
  deviceId: string;
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
  asn: number | null;
  provider: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export type DeviceConnectionInput = Omit<DeviceConnection, 'id'>;

export interface ConnectionRepo {
  /** The device's most recently seen connection, or null. */
  latestForDevice(deviceId: string): Promise<DeviceConnection | null>;
  insert(input: DeviceConnectionInput): Promise<DeviceConnection>;
  /** Move `last_seen_at` forward to `at` (never backward). */
  touch(id: string, at: Date): Promise<void>;
  /** The employee's connections seen since `since`, most recent first. */
  listForEmployee(employeeId: string, since: Date): Promise<DeviceConnection[]>;
  /** Each employee's most recent connection seen since `since`; absent if none. */
  latestForEmployees(
    employeeIds: readonly string[],
    since: Date,
  ): Promise<Map<string, DeviceConnection>>;
}

// ---------------------------------------------------------------------
// Time corrections (ADR-0030)
// ---------------------------------------------------------------------

export type CorrectionDecisionKind = 'endorsed' | 'approved' | 'rejected' | 'withdrawn';

export interface TimeCorrection {
  id: string;
  employeeId: string;
  fromAt: Date;
  toAt: Date;
  /** The person's zone when entered (dates the day, shows the times). */
  tzIana: string;
  /** Minutes east of UTC at `fromAt` in `tzIana`. */
  utcOffsetMinutes: number;
  /** `working`, `away_working`, a break kind, or `not_worked`. */
  kind: string;
  reason: string;
  requestedByUserId: string;
  requestedAt: Date;
}

export interface CorrectionDecision {
  id: string;
  correctionId: string;
  decision: CorrectionDecisionKind;
  decidedByUserId: string;
  decidedAt: Date;
  note: string | null;
}

/** A correction with its decisions, oldest first. */
export interface CorrectionWithDecisions extends TimeCorrection {
  decisions: CorrectionDecision[];
}

export interface NewCorrection {
  employeeId: string;
  fromAt: Date;
  toAt: Date;
  tzIana: string;
  utcOffsetMinutes: number;
  kind: string;
  reason: string;
  requestedByUserId: string;
  /**
   * A manager correcting a report's time: it counts as endorsed by them
   * (ADR-0030 §3), so an `endorsed` row is written with it.
   */
  endorse: boolean;
  correlationId: string;
  at: Date;
}

export interface NewCorrectionDecision {
  correctionId: string;
  /** Whose time it is (for the audit row). */
  employeeId: string;
  decision: CorrectionDecisionKind;
  decidedByUserId: string;
  note: string | null;
  correlationId: string;
  at: Date;
}

/** The correction already has this decision, or a final one. */
export class CorrectionDecisionConflictError extends Error {
  constructor(readonly correctionId: string) {
    super(`correction ${correctionId} already decided`);
    this.name = 'CorrectionDecisionConflictError';
  }
}

export interface CorrectionRepo {
  /**
   * Store a correction (and its `endorsed` row when `endorse`) with an
   * audit_log row (`correction_requested`), in one transaction.
   */
  request(input: NewCorrection): Promise<CorrectionWithDecisions>;
  /**
   * Add a decision with an audit_log row (`correction_<decision>`), in
   * one transaction. Throws {@link CorrectionDecisionConflictError} if
   * it was already endorsed (for `endorsed`) or already has a final
   * decision (approved, rejected, withdrawn).
   */
  decide(input: NewCorrectionDecision): Promise<CorrectionDecision>;
  findById(id: string): Promise<CorrectionWithDecisions | null>;
  /** The employee's corrections overlapping [from, to), by start. */
  listForEmployee(employeeId: string, from: Date, to: Date): Promise<CorrectionWithDecisions[]>;
  /** Corrections with no final decision yet, oldest first. */
  listOpen(): Promise<CorrectionWithDecisions[]>;
}

// ---------------------------------------------------------------------
// Shifts (ADR-0031)
// ---------------------------------------------------------------------

export interface ShiftAssignment {
  id: string;
  employeeId: string;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. Empty: no shift. */
  days: number[];
  /** `HH:MM`, null when there is no shift. */
  start: string | null;
  /** `HH:MM`; at or before `start` means the next day. */
  end: string | null;
  tzIana: string;
  /** `YYYY-MM-DD`: applies from this date on. */
  effectiveFrom: string;
  reason: string | null;
  assignedByUserId: string;
  assignedAt: Date;
}

export interface NewShiftAssignment extends Omit<ShiftAssignment, 'id' | 'assignedAt'> {
  correlationId: string;
  at: Date;
}

export interface NotWorkingDeclaration {
  employeeId: string;
  /** The date the shift starts on, in its zone. */
  shiftDate: string;
  declaredByUserId: string;
  correlationId: string;
  at: Date;
}

export interface ShiftRepo {
  /** Store a shift (a new row) with an audit_log row `shift_assigned`, in one transaction. */
  assign(input: NewShiftAssignment): Promise<ShiftAssignment>;
  /** Every shift row for these people, newest first (effective_from, then assigned_at). */
  history(employeeIds: readonly string[]): Promise<ShiftAssignment[]>;
  /**
   * Record "Not working today" with an audit_log row. Saying it twice
   * for the same shift is a no-op; returns whether it was new.
   */
  declareNotWorking(input: NotWorkingDeclaration): Promise<boolean>;
  /** `${employeeId}:${shiftDate}` for each declaration among these dates. */
  notWorking(employeeIds: readonly string[], dates: readonly string[]): Promise<Set<string>>;
}

// ---------------------------------------------------------------------
// Holidays (ADR-0037 §1)
// ---------------------------------------------------------------------

export interface Holiday {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  name: string;
  /** A later row that removes the date from the list. */
  cancelled: boolean;
  addedByUserId: string;
  addedAt: Date;
}

export interface NewHoliday extends Omit<Holiday, 'id' | 'addedAt'> {
  correlationId: string;
  at: Date;
}

export interface HolidayRepo {
  /**
   * Add (or rename) a holiday, or remove one with `cancelled`: always a
   * new row, with an audit_log row `holiday_added` / `holiday_removed`.
   */
  record(input: NewHoliday): Promise<Holiday>;
  /** The holidays from `from` to `to` (inclusive, `YYYY-MM-DD`), oldest first: the latest row per date, cancelled ones left out. */
  between(from: string, to: string): Promise<Holiday[]>;
}

// ---------------------------------------------------------------------
// Shift-start emails (ADR-0037 §3, §4)
// ---------------------------------------------------------------------

export type ShiftAlertKind = 'missed' | 'late_clock_in' | 'not_working';

export interface ShiftAlertClaim {
  employeeId: string;
  /** The date the shift starts on, in its zone. */
  shiftDate: string;
  kind: ShiftAlertKind;
  sentTo: readonly string[];
  at: Date;
}

export interface ShiftAlertRepo {
  /** `${employeeId}:${shiftDate}:${kind}` for each alert already sent among these. */
  sent(employeeIds: readonly string[], dates: readonly string[]): Promise<Set<string>>;
  /**
   * Claim the alert and run `send` in one transaction: false (and no
   * send) if it was already claimed; if `send` throws, the claim is
   * rolled back so the next check tries again.
   */
  claimAndSend(claim: ShiftAlertClaim, send: () => Promise<void>): Promise<boolean>;
  /** Missed starts and "not working" days per person, shift dates from `since` (ADR-0037 §4). */
  countsSince(since: string): Promise<Map<string, StartCounts>>;
}

export interface StartCounts {
  missed: number;
  notWorking: number;
}

export interface WeeklyReportRepo {
  /**
   * Claim the Monday email for `recipient` this week and run `send` in
   * one transaction: false (and no send) if it already went; a failed
   * send rolls the claim back.
   */
  claimAndSend(
    weekStart: string,
    recipient: string,
    people: number,
    at: Date,
    send: () => Promise<void>,
  ): Promise<boolean>;
}

/** Someone the server has seen with these roles, and where to email them. */
export interface RoleHolder {
  oid: string;
  email: string;
}

export interface RoleDirectoryRepo {
  /** Remember the roles `oid` was seen with (a token, or Settings → People). */
  note(oid: string, roles: readonly string[], source: 'token' | 'people', at: Date): Promise<void>;
  /** Everyone last seen with any of `roles`, with a work email. */
  holders(roles: readonly string[]): Promise<RoleHolder[]>;
}

export interface DbRepositories {
  people: PeopleRepo;
  employees: EmployeeRepo;
  users: AppUserRepo;
  devices: DeviceRepo;
  timeSessions: TimeSessionRepo;
  timeEvents: TimeEventRepo;
  policies: PolicyRepo;
  departments: DepartmentRepo;
  connections: ConnectionRepo;
  corrections: CorrectionRepo;
  shifts: ShiftRepo;
  holidays: HolidayRepo;
  shiftAlerts: ShiftAlertRepo;
  roles: RoleDirectoryRepo;
  weeklyReports: WeeklyReportRepo;
}
