import { AppRole, Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { requireCapability } from '../auth/require.js';
import type { ConnectionRecorder } from '../connections/recorder.js';
import type { DbRepositories } from '../db/index.js';
import { ingestBatch, type IngestBatchOutcome } from './ingest.js';
import { ingestBatchBodySchema } from './schemas.js';
import type { OpsMonitor } from '../ops/monitor.js';

export interface EventsRoutesOptions {
  db: DbRepositories;
  /** ADR-0029: where the device connects from. */
  connections?: ConnectionRecorder | undefined;
  /** Hears about refused uploads (ADR-0043 §2). */
  monitor?: OpsMonitor | undefined;
}

const HTTP_STATUS_FOR: Record<Exclude<IngestBatchOutcome['status'], 'batch_accepted'>, number> = {
  no_user_for_oid: 403,
  no_employee_for_user: 403,
  employee_id_mismatch: 403,
  employee_status_forbidden: 403,
  device_unknown: 409,
  device_revoked: 409,
  device_owner_mismatch: 409,
  device_signed_out: 409,
  session_not_open: 409,
  session_closed: 409,
  session_owner_mismatch: 409,
  session_device_mismatch: 409,
  multi_device_conflict: 409,
};

/**
 * Batch refusals worth counting (ADR-0040 §3.4): after the caller's
 * identity was checked, so the ids are theirs. Not a second computer
 * (that's the one-machine rule working) or an unknown one.
 */
const COUNTED: ReadonlySet<string> = new Set([
  'device_revoked',
  'device_signed_out',
  'session_not_open',
  'session_closed',
  'session_owner_mismatch',
  'session_device_mismatch',
]);

/** The database refuses events stamped more than this ahead of it (time_event_check). */
const CLOCK_AHEAD_MS = 10_000;

const eventsRoutesImpl: FastifyPluginAsync<EventsRoutesOptions> = async (app, opts) => {
  /** Count a refusal; never fails the request. */
  const refused = async (
    deviceId: string,
    employeeId: string,
    reason: string,
    events: number,
    aheadSeconds: number | null = null,
  ): Promise<void> => {
    opts.monitor?.refusedUpload(events);
    try {
      await opts.db.refusals.note({
        deviceId,
        employeeId,
        reason,
        events,
        aheadSeconds,
        at: new Date(),
      });
    } catch (err) {
      app.log.warn({ err }, 'events: could not count a refused upload');
    }
  };

  app.post(
    '/v1/events',
    { preHandler: [requireCapability(Capability.SelfClockWrite)] },
    async (req, reply) => {
      const parsed = ingestBatchBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).type('application/problem+json').send({
          code: 'validation',
          message: 'invalid event batch',
          issues: parsed.error.issues,
        });
      }

      const auth = req.auth;
      if (!auth) {
        return reply
          .code(500)
          .type('application/problem+json')
          .send({ code: 'internal', message: 'auth preHandler did not populate req.auth' });
      }

      // How far ahead of the server the computer's clock stamped them.
      const aheadMs = Math.max(
        ...parsed.data.events.map((e) => Date.parse(e.client_ts) - Date.now()),
      );
      let outcome: IngestBatchOutcome;
      try {
        outcome = await ingestBatch({
          db: opts.db,
          authOid: auth.oid,
          deviceId: parsed.data.device_id,
          sessionId: parsed.data.session_id,
          employeeId: parsed.data.employee_id,
          correlationId: parsed.data.correlation_id,
          events: parsed.data.events,
          // Only an Administrator may take over another machine's
          // session (ADR-0028 §3); for anyone else it is ignored, so a
          // second-device clock-in still gets multi_device_conflict.
          takeOver: parsed.data.take_over && auth.roles.includes(AppRole.Administrator),
        });
      } catch (err) {
        // Still a server error for the app (it keeps and retries the
        // events), but counted, with the likeliest reason.
        const ahead = aheadMs > CLOCK_AHEAD_MS;
        await refused(
          parsed.data.device_id,
          parsed.data.employee_id,
          ahead ? 'clock_ahead' : 'server_error',
          parsed.data.events.length,
          ahead ? Math.round(aheadMs / 1000) : null,
        );
        throw err;
      }

      if (outcome.status === 'batch_accepted') {
        // Accepted means the device and employee were checked as the caller's.
        await opts.connections?.record(req, parsed.data.employee_id, parsed.data.device_id);
        const codes = new Map<string, number>();
        for (const r of outcome.results) {
          if (r.status === 'rejected') codes.set(r.code, (codes.get(r.code) ?? 0) + 1);
        }
        for (const [code, n] of codes) {
          await refused(parsed.data.device_id, parsed.data.employee_id, code, n);
        }
        return reply.code(200).send({
          correlation_id: outcome.correlationId,
          server_ts: outcome.serverTs.toISOString(),
          session_closed_with: outcome.sessionClosedWith,
          results: outcome.results,
        });
      }

      if (COUNTED.has(outcome.status)) {
        await refused(
          parsed.data.device_id,
          parsed.data.employee_id,
          outcome.status,
          parsed.data.events.length,
        );
      }
      const status = HTTP_STATUS_FOR[outcome.status];
      const body: Record<string, unknown> = {
        code: outcome.status,
        message: humanFor(outcome.status),
      };
      if (outcome.status === 'employee_status_forbidden') {
        body['employee_status'] = outcome.employeeStatus;
      }
      if (outcome.status === 'multi_device_conflict') {
        body['existing_session_id'] = outcome.existingSessionId;
        body['existing_device_id'] = outcome.existingDeviceId;
        body['opened_at'] = outcome.openedAt.toISOString();
        body['hint'] = auth.roles.includes(AppRole.Administrator)
          ? 'resubmit with take_over: true to close the existing session and continue'
          : 'clock out on the other machine first, or ask an administrator to sign it out';
      }
      return reply.code(status).type('application/problem+json').send(body);
    },
  );
};

function humanFor(status: string): string {
  switch (status) {
    case 'no_user_for_oid':
      return 'authenticated Entra oid has no CloudPunch user record';
    case 'no_employee_for_user':
      return 'signed-in user is not linked to an employee';
    case 'employee_id_mismatch':
      return 'employee_id in the batch does not match the signed-in user';
    case 'employee_status_forbidden':
      return 'employee is not active';
    case 'device_unknown':
      return 'device is not enrolled';
    case 'device_revoked':
      return 'device has been revoked';
    case 'device_owner_mismatch':
      return 'device is enrolled to a different user';
    case 'device_signed_out':
      return 'an administrator signed this device out; sign in again';
    case 'session_not_open':
      return 'no open session for this session_id (and first event is not USER_CLOCK_IN)';
    case 'session_closed':
      return 'session has already been closed';
    case 'session_owner_mismatch':
      return 'session belongs to a different employee';
    case 'session_device_mismatch':
      return 'session was opened on a different device';
    case 'multi_device_conflict':
      return 'employee already has an open session on a different device';
    default:
      return status;
  }
}

export const eventsRoutes = fp(eventsRoutesImpl, {
  name: 'cloudpunch-events',
  fastify: '4.x',
});

export default eventsRoutes;
