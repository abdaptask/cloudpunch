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
  touchLastSeen(id: string, at: Date): Promise<void>;
  /** Every device with its owner, most recently seen first. */
  listWithOwners(): Promise<readonly DeviceWithOwner[]>;
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

export interface DbRepositories {
  employees: EmployeeRepo;
  users: AppUserRepo;
  devices: DeviceRepo;
  timeSessions: TimeSessionRepo;
  timeEvents: TimeEventRepo;
}
