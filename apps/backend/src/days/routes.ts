import { Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { DbRepositories } from '../db/index.js';
import { requireCapability } from '../auth/require.js';
import { LOOKBACK_DAYS, daySummaries, dayView, inLookback, spanDays } from './service.js';

export interface DayRoutesOptions {
  db: DbRepositories;
}

const MAX_RANGE_DAYS = 31;

function problem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/problem+json').send({ code, message });
}

/**
 * Day history (ADR-0016), for the caller only (CLAUDE.md invariant 5):
 *
 *   GET /v1/me/days/{date}        the working day dated YYYY-MM-DD
 *   GET /v1/me/days?from=&to=     totals per working day (≤ 31 days)
 */
const dayRoutesImpl: FastifyPluginAsync<DayRoutesOptions> = async (app, opts) => {
  /** The caller's employee id, or a reply already sent. */
  async function employeeOf(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const user = req.auth ? await opts.db.users.findByEntraObjectId(req.auth.oid) : null;
    if (!user) {
      await problem(
        reply,
        403,
        'no_user_for_oid',
        'authenticated Entra oid has no CloudPunch user',
      );
      return null;
    }
    if (!user.employeeId) {
      await problem(reply, 404, 'no_employee', 'this account is not linked to an employee');
      return null;
    }
    return user.employeeId;
  }

  const guard = { preHandler: [requireCapability([Capability.SelfTimelineRead])] };

  app.get('/v1/me/days/:date', guard, async (req, reply) => {
    const { date } = req.params as { date: string };
    const now = new Date();
    if (!inLookback(date, now)) {
      return problem(
        reply,
        400,
        'date_out_of_range',
        `date must be YYYY-MM-DD within the last ${LOOKBACK_DAYS} days`,
      );
    }
    const employeeId = await employeeOf(req, reply);
    if (!employeeId) return reply;
    return reply.code(200).send(await dayView(opts.db, employeeId, date, now));
  });

  app.get('/v1/me/days', guard, async (req, reply) => {
    const { from, to } = req.query as { from?: string; to?: string };
    const now = new Date();
    if (!from || !to || !inLookback(from, now) || !inLookback(to, now) || to < from) {
      return problem(
        reply,
        400,
        'range_invalid',
        `from and to must be YYYY-MM-DD within the last ${LOOKBACK_DAYS} days, from ≤ to`,
      );
    }
    if (spanDays(from, to) > MAX_RANGE_DAYS) {
      return problem(reply, 400, 'range_too_long', `at most ${MAX_RANGE_DAYS} days`);
    }
    const employeeId = await employeeOf(req, reply);
    if (!employeeId) return reply;
    return reply.code(200).send({ days: await daySummaries(opts.db, employeeId, from, to, now) });
  });
};

export const dayRoutes = fp(dayRoutesImpl, { name: 'cloudpunch-days', fastify: '4.x' });

export default dayRoutes;
