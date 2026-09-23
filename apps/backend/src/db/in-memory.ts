import { randomUUID } from 'node:crypto';
import type {
  AppUser,
  AppUserRepo,
  DbRepositories,
  Device,
  DeviceEnrollInput,
  DeviceRepo,
  Employee,
  EmployeeRepo,
  InsertEventResult,
  OpenSessionInput,
  SessionCloseReason,
  TimeEventInput,
  TimeEventRecord,
  TimeEventRepo,
  TimeSession,
  TimeSessionRepo,
} from './types.js';

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

  private readonly employeeById = new Map<string, Employee>();
  private readonly employeeByOid = new Map<string, string>(); // oid -> employeeId
  private readonly userById = new Map<string, AppUser>();
  private readonly userByOid = new Map<string, string>();
  private readonly deviceById = new Map<string, Device>();
  private readonly sessionById = new Map<string, TimeSession>();
  private readonly eventByUlid = new Map<string, TimeEventRecord>();
  private readonly seqByEventKey = new Map<string, string>(); // `${sessionId}:${seq}` -> eventUlid

  constructor() {
    this.employees = {
      findById: async (id) => this.employeeById.get(id) ?? null,
      findByEntraObjectId: async (oid) => {
        const id = this.employeeByOid.get(oid);
        return id ? (this.employeeById.get(id) ?? null) : null;
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
      touchLastSeen: async (id, at) => {
        const d = this.deviceById.get(id);
        if (d) this.deviceById.set(id, { ...d, lastSeenAt: at });
      },
    };

    this.timeSessions = {
      open: async (input) => this.openSession(input),
      close: async (id, closedAt, closedReason) => this.closeSession(id, closedAt, closedReason),
      findOpenByEmployeeId: async (employeeId) =>
        Array.from(this.sessionById.values()).find(
          (s) => s.employeeId === employeeId && s.closedAt === null,
        ) ?? null,
      findById: async (id) => this.sessionById.get(id) ?? null,
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
    };
  }

  // ---------------------------------------------------------------
  // Seed helpers — used by tests to set up a starting state
  // ---------------------------------------------------------------

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
    // Enforce the unique-open-per-employee invariant.
    for (const s of this.sessionById.values()) {
      if (s.employeeId === input.employeeId && s.closedAt === null) {
        throw new SessionOpenConflictError(input.employeeId, s.id);
      }
    }
    const session: TimeSession = {
      id: randomUUID(),
      employeeId: input.employeeId,
      deviceId: input.deviceId,
      openedAt: input.openedAt,
      closedAt: null,
      closedReason: null,
      reconstructed: false,
    };
    this.sessionById.set(session.id, session);
    return session;
  }

  private async closeSession(
    id: string,
    closedAt: Date,
    closedReason: SessionCloseReason,
  ): Promise<TimeSession> {
    const s = this.sessionById.get(id);
    if (!s) throw new Error(`session ${id} not found`);
    if (s.closedAt !== null) return s; // idempotent
    const closed: TimeSession = { ...s, closedAt, closedReason };
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
