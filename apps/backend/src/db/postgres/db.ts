import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type {
  AppUser,
  AppUserRepo,
  DbRepositories,
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
  SessionCloseReason,
  TimeEventInput,
  TimeEventRecord,
  TimeEventRepo,
  TimeSession,
  TimeSessionRepo,
} from '../types.js';

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

  constructor(private readonly sql: postgres.Sql) {
    this.employees = this.buildEmployeeRepo();
    this.users = this.buildAppUserRepo();
    this.devices = this.buildDeviceRepo();
    this.timeSessions = this.buildTimeSessionRepo();
    this.timeEvents = this.buildTimeEventRepo();
  }

  // -------------------------------------------------------------------
  // employees
  // -------------------------------------------------------------------

  private buildEmployeeRepo(): EmployeeRepo {
    const map = (row: EmployeeRow): Employee => ({
      id: row.id,
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
            u.work_email
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
            u.work_email
          FROM employee e
          JOIN app_user u ON u.employee_id = e.id
          WHERE u.entra_object_id = ${oid}
          LIMIT 1
        `;
        const row = rows[0];
        return row ? map(row) : null;
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
    });

    return {
      enroll: async (input: DeviceEnrollInput) => {
        // Idempotent: refresh key/version when same (id, user_id).
        // Conflict when same id but different user.
        const existingRows = await this.sql<DeviceRow[]>`
          SELECT id, user_id, os, hostname_hash, public_key_ed25519,
                 app_version, enrolled_at, last_seen_at,
                 revoked_at, revoked_reason, revoked_by_user_id
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
                      revoked_at, revoked_reason, revoked_by_user_id
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
                    revoked_at, revoked_reason, revoked_by_user_id
        `;
        const row = inserted[0];
        if (!row) throw new Error('device insert returned no rows');
        return map(row);
      },
      findById: async (id) => {
        const rows = await this.sql<DeviceRow[]>`
          SELECT id, user_id, os, hostname_hash, public_key_ed25519,
                 app_version, enrolled_at, last_seen_at,
                 revoked_at, revoked_reason, revoked_by_user_id
          FROM device WHERE id = ${id} LIMIT 1
        `;
        const row = rows[0];
        return row ? map(row) : null;
      },
      findByUserId: async (userId) => {
        const rows = await this.sql<DeviceRow[]>`
          SELECT id, user_id, os, hostname_hash, public_key_ed25519,
                 app_version, enrolled_at, last_seen_at,
                 revoked_at, revoked_reason, revoked_by_user_id
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
      touchLastSeen: async (id, at) => {
        await this.sql`
          UPDATE device SET last_seen_at = ${at} WHERE id = ${id}
        `;
      },
      listWithOwners: async () => {
        const rows = await this.sql<
          (DeviceRow & { ownerWorkEmail: string; ownerDisplayName: string })[]
        >`
          SELECT d.id, d.user_id, d.os, d.hostname_hash, d.public_key_ed25519,
                 d.app_version, d.enrolled_at, d.last_seen_at,
                 d.revoked_at, d.revoked_reason, d.revoked_by_user_id,
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
        const rows = await this.sql<TimeSessionRow[]>`
          INSERT INTO time_session (id, employee_id, device_id, opened_at)
          VALUES (${id}, ${input.employeeId}, ${input.deviceId}, ${input.openedAt})
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
