import { randomUUID } from 'node:crypto';
import { Capability, capabilitiesForRoles } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { requireCapability } from '../auth/require.js';
import type { DbRepositories } from '../db/index.js';
import { LOOKBACK_DAYS, inLookback } from '../days/service.js';
import { peopleIn, scopeFor, type TeamScope } from '../team/service.js';
import { countsOf, dayRows, problemsFirst } from './day.js';

/**
 * Reports (ADR-0040):
 *
 *   GET /v1/reports/day?date=   each person's day, for the caller's team
 *
 * Who is in it follows Team (ADR-0025 §2, invariant 5): a Manager their
 * direct reports; HR and Administrators everyone. Each request writes
 * one audit row (§4).
 */

export interface ReportRoutesOptions {
  db: DbRepositories;
}

function problem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/problem+json').send({ code, message });
}

const reportRoutesImpl: FastifyPluginAsync<ReportRoutesOptions> = async (app, opts) => {
  const db = opts.db;

  app.get(
    '/v1/reports/day',
    {
      preHandler: [requireCapability([Capability.TeamTimelineRead, Capability.HrEmployeeRead])],
    },
    async (req, reply) => {
      const user = req.auth ? await db.users.findByEntraObjectId(req.auth.oid) : null;
      if (!user || !req.auth) {
        return problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
      }
      const now = new Date();
      const date = (req.query as { date?: string }).date ?? '';
      if (!inLookback(date, now)) {
        return problem(
          reply,
          400,
          'date_out_of_range',
          `date must be YYYY-MM-DD within the last ${LOOKBACK_DAYS} days`,
        );
      }
      // Administrators (HR employee read) see everyone, even without the HR role.
      const caps = new Set<string>(capabilitiesForRoles(req.auth.roles));
      const scope: TeamScope = caps.has(Capability.HrEmployeeRead)
        ? { kind: 'all' }
        : scopeFor(caps, user.employeeId);
      const rows = await dayRows(db, await peopleIn(db, scope), date, now);
      await db.reports.auditView({
        actorUserId: user.id,
        report: 'day',
        detail: { date, people: String(rows.length) },
        correlationId: randomUUID(),
        at: now,
      });
      return reply.code(200).send({ date, counts: countsOf(rows), people: problemsFirst(rows) });
    },
  );
};

export const reportRoutes = fp(reportRoutesImpl, { name: 'cloudpunch-reports', fastify: '4.x' });
export default reportRoutes;
