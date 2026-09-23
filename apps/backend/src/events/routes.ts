import { Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { requireCapability } from '../auth/require.js';
import type { DbRepositories } from '../db/index.js';
import { ingestBatch, type IngestBatchOutcome } from './ingest.js';
import { ingestBatchBodySchema } from './schemas.js';

export interface EventsRoutesOptions {
  db: DbRepositories;
}

const HTTP_STATUS_FOR: Record<Exclude<IngestBatchOutcome['status'], 'batch_accepted'>, number> = {
  no_user_for_oid: 403,
  no_employee_for_user: 403,
  employee_id_mismatch: 403,
  employee_status_forbidden: 403,
  device_unknown: 409,
  device_revoked: 409,
  device_owner_mismatch: 409,
  session_not_open: 409,
  session_closed: 409,
  session_owner_mismatch: 409,
  session_device_mismatch: 409,
  multi_device_conflict: 409,
};

const eventsRoutesImpl: FastifyPluginAsync<EventsRoutesOptions> = async (app, opts) => {
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

      const outcome = await ingestBatch({
        db: opts.db,
        authOid: auth.oid,
        deviceId: parsed.data.device_id,
        sessionId: parsed.data.session_id,
        employeeId: parsed.data.employee_id,
        correlationId: parsed.data.correlation_id,
        events: parsed.data.events,
        takeOver: parsed.data.take_over,
      });

      if (outcome.status === 'batch_accepted') {
        return reply.code(200).send({
          correlation_id: outcome.correlationId,
          server_ts: outcome.serverTs.toISOString(),
          session_closed_with: outcome.sessionClosedWith,
          results: outcome.results,
        });
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
        body['hint'] = 'resubmit with take_over: true to close the existing session and continue';
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
