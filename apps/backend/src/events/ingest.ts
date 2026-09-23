import {
  canonicalizeSignedFields,
  importEd25519PublicKey,
  verifyEventSignature,
} from '@cloudpunch/event-schema';
import type { DbRepositories, EmploymentStatus, SessionCloseReason } from '../db/index.js';
import type { EventItem } from './schemas.js';
import { INITIAL_STATE, deriveState, nextState, type PayrollState } from './state-machine.js';

/**
 * Max sequence-number gap tolerated per session per batch. See
 * ADR-0004 §4. Larger gaps freeze the session at the ingest layer;
 * client outbox is expected to be drained in order.
 */
export const MAX_SEQUENCE_GAP = 10;

export interface IngestBatchInput {
  db: DbRepositories;
  authOid: string;
  deviceId: string;
  sessionId: string;
  employeeId: string;
  correlationId: string;
  events: readonly EventItem[];
  /**
   * When true, if the employee already has an open session on a
   * different session_id, that session is closed with
   * closed_reason='remote_takeover' before this batch opens a new
   * session. See ADR-0003 §8.
   */
  takeOver?: boolean;
}

export type EventIngestResult =
  | { event_ulid: string; status: 'accepted'; server_ts: string }
  | { event_ulid: string; status: 'duplicate_noop'; server_ts: string }
  | {
      event_ulid: string;
      status: 'rejected';
      code:
        | 'signature_invalid'
        | 'sequence_gap_too_large'
        | 'state_transition_invalid'
        | 'duplicate_sequence'
        | 'duplicate_ulid_different_payload'
        | 'event_out_of_session';
      message: string;
    };

export type IngestBatchOutcome =
  | {
      status: 'batch_accepted';
      correlationId: string;
      serverTs: Date;
      results: readonly EventIngestResult[];
      sessionClosedWith: SessionCloseReason | null;
    }
  | { status: 'no_user_for_oid' }
  | { status: 'no_employee_for_user' }
  | { status: 'employee_id_mismatch' }
  | { status: 'employee_status_forbidden'; employeeStatus: EmploymentStatus }
  | { status: 'device_unknown' }
  | { status: 'device_revoked' }
  | { status: 'device_owner_mismatch' }
  | { status: 'session_not_open' }
  | { status: 'session_closed' }
  | { status: 'session_owner_mismatch' }
  | { status: 'session_device_mismatch' }
  | {
      status: 'multi_device_conflict';
      existingSessionId: string;
      existingDeviceId: string;
      openedAt: Date;
    };

/**
 * Ingest a batch of signed events for a single session. See ADR-0004 §6.
 *
 * Two-layer rejection model:
 *   - Batch-level failures (device/employee/session identity mismatches,
 *     revoked device, inactive employee) → return a discriminated status
 *     that the route layer maps to 4xx. No events are persisted.
 *   - Per-event failures (signature invalid, sequence gap, duplicate
 *     ULID with different payload) → captured as EventIngestResult
 *     entries; the batch overall status is `batch_accepted` even if
 *     every event was rejected.
 *
 * State-machine transition validation is deliberately deferred to a
 * later slice (2a.4). This service enforces session lifecycle only:
 * USER_CLOCK_IN may create a session; other events require an
 * existing open session; USER_CLOCK_OUT closes the session on the
 * server after successful accept.
 */
export async function ingestBatch(input: IngestBatchInput): Promise<IngestBatchOutcome> {
  const user = await input.db.users.findByEntraObjectId(input.authOid);
  if (!user) return { status: 'no_user_for_oid' };
  if (!user.employeeId) return { status: 'no_employee_for_user' };
  if (user.employeeId !== input.employeeId) return { status: 'employee_id_mismatch' };

  const employee = await input.db.employees.findById(user.employeeId);
  if (!employee) return { status: 'no_employee_for_user' };
  if (employee.status !== 'active') {
    return { status: 'employee_status_forbidden', employeeStatus: employee.status };
  }

  const device = await input.db.devices.findById(input.deviceId);
  if (!device) return { status: 'device_unknown' };
  if (device.revokedAt !== null) return { status: 'device_revoked' };
  if (device.userId !== user.id) return { status: 'device_owner_mismatch' };

  // Session lookup / lazy creation on USER_CLOCK_IN.
  let session = await input.db.timeSessions.findById(input.sessionId);
  const firstEvt = input.events[0];
  if (!firstEvt) {
    // Should be unreachable — schema enforces min:1.
    return {
      status: 'batch_accepted',
      correlationId: input.correlationId,
      serverTs: new Date(),
      results: [],
      sessionClosedWith: null,
    };
  }

  if (!session) {
    if (firstEvt.event_type !== 'USER_CLOCK_IN' || firstEvt.sequence_number !== 1) {
      return { status: 'session_not_open' };
    }

    // Multi-device conflict: an open session already exists for this
    // employee on a different session_id (typically a different
    // device). Reject unless the client explicitly opted in to take
    // over. See ADR-0003 §8.
    const existingOpen = await input.db.timeSessions.findOpenByEmployeeId(employee.id);
    if (existingOpen && existingOpen.id !== input.sessionId) {
      if (!input.takeOver) {
        return {
          status: 'multi_device_conflict',
          existingSessionId: existingOpen.id,
          existingDeviceId: existingOpen.deviceId,
          openedAt: existingOpen.openedAt,
        };
      }
      await input.db.timeSessions.close(existingOpen.id, new Date(), 'remote_takeover');
    }

    session = await input.db.timeSessions.open({
      id: input.sessionId,
      employeeId: employee.id,
      deviceId: device.id,
      openedAt: new Date(firstEvt.client_ts),
    });
  }

  if (session.closedAt !== null) return { status: 'session_closed' };
  if (session.employeeId !== employee.id) return { status: 'session_owner_mismatch' };
  if (session.deviceId !== device.id) return { status: 'session_device_mismatch' };

  const publicKey = await importEd25519PublicKey(device.publicKeyEd25519);
  const maxKnownSeq = await input.db.timeEvents.findMaxSequenceForSession(session.id);
  let watermark = maxKnownSeq ?? 0;
  let sessionClosedWith: SessionCloseReason | null = null;

  // Derive the session's current payroll state from the events already
  // in the DB. If the session was just opened in this batch (session
  // creation above), the stream is empty and derivation returns
  // INITIAL_STATE (=ACTIVE), which is correct for a fresh USER_CLOCK_IN.
  const priorEvents = await input.db.timeEvents.findBySessionOrderedBySequence(session.id);
  let currentState: PayrollState =
    priorEvents.length === 0 ? INITIAL_STATE : deriveState(priorEvents);
  const sessionExistedBeforeBatch = priorEvents.length > 0;

  const results: EventIngestResult[] = [];

  for (const evt of input.events) {
    // 1. Signature verification. Reconstruct the full signed subset
    //    from batch-level + per-event fields.
    const signedBytes = canonicalizeSignedFields({
      app_version: evt.app_version,
      client_ts: evt.client_ts,
      correlation_id: input.correlationId,
      device_id: input.deviceId,
      employee_id: input.employeeId,
      event_type: evt.event_type,
      event_ulid: evt.event_ulid,
      monotonic_ns: evt.monotonic_ns,
      offline_captured: evt.offline_captured,
      origin: evt.origin,
      parent_event_ulid: evt.parent_event_ulid,
      payload: evt.payload,
      sequence_number: evt.sequence_number,
      session_id: input.sessionId,
      tz_iana: evt.tz_iana,
      utc_offset_minutes: evt.utc_offset_minutes,
    });

    let sigOk = false;
    try {
      sigOk = await verifyEventSignature({
        publicKey,
        signatureBase64: evt.integrity_signature,
        signedBytes,
      });
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      results.push({
        event_ulid: evt.event_ulid,
        status: 'rejected',
        code: 'signature_invalid',
        message: 'Ed25519 verification failed',
      });
      continue;
    }

    // 2. Sequence gap check (client outbox is expected to drain in
    //    order; gaps beyond MAX_SEQUENCE_GAP mean events were lost).
    if (evt.sequence_number > watermark + MAX_SEQUENCE_GAP) {
      results.push({
        event_ulid: evt.event_ulid,
        status: 'rejected',
        code: 'sequence_gap_too_large',
        message: `sequence ${evt.sequence_number} exceeds watermark ${watermark} + max gap ${MAX_SEQUENCE_GAP}`,
      });
      continue;
    }

    // 3. Idempotency short-circuit. A retried event (same ULID) must
    //    return duplicate_noop even if a naïve state check would
    //    reject it — the state was already validated when the event
    //    was first accepted. Skip state validation for duplicates
    //    and let the insert path produce the correct duplicate_* result.
    const isDuplicateUlid = (await input.db.timeEvents.findByUlid(evt.event_ulid)) !== null;

    // 4. State-machine validation (skipped for duplicates).
    //    USER_CLOCK_IN with sequence 1 that opened the session in
    //    this batch (no prior events) is also skipped — the session
    //    was just created and INITIAL_STATE is the correct starting
    //    point for that event.
    if (!isDuplicateUlid) {
      const isOpeningClockIn =
        evt.event_type === 'USER_CLOCK_IN' &&
        evt.sequence_number === 1 &&
        !sessionExistedBeforeBatch;
      if (!isOpeningClockIn) {
        const proposed = nextState(currentState, evt.event_type, evt.payload);
        if (proposed === null) {
          results.push({
            event_ulid: evt.event_ulid,
            status: 'rejected',
            code: 'state_transition_invalid',
            message: `event ${evt.event_type} is not valid from state ${currentState}`,
          });
          continue;
        }
        currentState = proposed;
      }
    }

    // 5. Idempotent insert.
    const insertResult = await input.db.timeEvents.insertOne({
      eventUlid: evt.event_ulid,
      eventType: evt.event_type,
      sessionId: session.id,
      employeeId: employee.id,
      sequenceNumber: evt.sequence_number,
      clientTs: new Date(evt.client_ts),
      monotonicNs: evt.monotonic_ns,
      tzIana: evt.tz_iana,
      utcOffsetMinutes: evt.utc_offset_minutes,
      deviceId: device.id,
      appVersion: evt.app_version,
      origin: evt.origin,
      offlineCaptured: evt.offline_captured,
      payload: evt.payload,
      integritySignature: base64Decode(evt.integrity_signature),
      correlationId: input.correlationId,
      parentEventUlid: evt.parent_event_ulid,
    });

    if (insertResult.status === 'accepted') {
      results.push({
        event_ulid: evt.event_ulid,
        status: 'accepted',
        server_ts: insertResult.serverTs.toISOString(),
      });
      watermark = Math.max(watermark, evt.sequence_number);
      // Close the session if this was USER_CLOCK_OUT.
      if (evt.event_type === 'USER_CLOCK_OUT') {
        sessionClosedWith = 'user_clock_out';
      } else if (evt.event_type === 'PROMPT_TIMEOUT_30S') {
        sessionClosedWith = 'idle_auto_clock_out';
      }
    } else if (insertResult.status === 'duplicate_noop') {
      results.push({
        event_ulid: evt.event_ulid,
        status: 'duplicate_noop',
        server_ts: insertResult.serverTs.toISOString(),
      });
    } else {
      results.push({
        event_ulid: evt.event_ulid,
        status: 'rejected',
        code: mapInsertRejectCode(insertResult.code),
        message: insertResult.message,
      });
    }
  }

  if (sessionClosedWith !== null) {
    await input.db.timeSessions.close(session.id, new Date(), sessionClosedWith);
  }

  await input.db.devices.touchLastSeen(device.id, new Date());

  return {
    status: 'batch_accepted',
    correlationId: input.correlationId,
    serverTs: new Date(),
    results,
    sessionClosedWith,
  };
}

function mapInsertRejectCode(
  code:
    | 'signature_invalid'
    | 'session_not_open'
    | 'sequence_gap_too_large'
    | 'duplicate_sequence'
    | 'duplicate_ulid_different_payload'
    | 'device_revoked'
    | 'state_transition_invalid'
    | 'employee_status_forbidden'
    | 'validation',
): Extract<EventIngestResult, { status: 'rejected' }>['code'] {
  // The event repository speaks a superset of codes; project onto the
  // narrower per-event set the ingest layer exposes. Codes that only
  // apply at batch level (device_revoked, employee_status_forbidden)
  // fall through to the closest per-event equivalent — but they should
  // never occur here because we've already screened them above.
  switch (code) {
    case 'duplicate_sequence':
      return 'duplicate_sequence';
    case 'duplicate_ulid_different_payload':
      return 'duplicate_ulid_different_payload';
    case 'signature_invalid':
      return 'signature_invalid';
    case 'sequence_gap_too_large':
      return 'sequence_gap_too_large';
    case 'state_transition_invalid':
      return 'state_transition_invalid';
    default:
      return 'event_out_of_session';
  }
}

function base64Decode(input: string): Uint8Array {
  const normal = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normal.length % 4 === 0 ? normal : normal + '='.repeat(4 - (normal.length % 4));
  return new Uint8Array(Buffer.from(padded, 'base64'));
}
