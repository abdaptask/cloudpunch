import { randomUUID } from 'node:crypto';
import { Capability, capabilitiesForRoles } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { requireCapability } from '../auth/require.js';
import type { DbRepositories } from '../db/index.js';
import { LOOKBACK_DAYS, inLookback, spanDays } from '../days/service.js';
import { peopleIn, scopeFor, type TeamScope } from '../team/service.js';
import { countsOf, dayRows, problemsFirst } from './day.js';
import { CSV_SECTIONS, overview, overviewCsv, type CsvSection } from './overview.js';

/**
 * Reports (ADR-0040):
 *
 *   GET /v1/reports/day?date=   each person's day, for the caller's team
 *   GET /v1/reports/overview?from&to             HR and Administrators (§3)
 *   GET /v1/reports/overview.csv?from&to&section  the same, one section as CSV
 *
 * Who is in it follows Team (ADR-0025 §2, invariant 5): a Manager their
 * direct reports; HR and Administrators everyone. Each request writes
 * one audit row (§4).
 */

/** The longest overview range (§3: up to 3 months), and how far back it may start. */
export const MAX_OVERVIEW_DAYS = 93;
const OLDEST_DAYS = 366;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const validDate = (d: string): boolean =>
  DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** A range check for the overview: null when fine, else the problem. */
export function rangeProblem(from: string, to: string, now: Date): string | null {
  if (!validDate(from) || !validDate(to) || from > to) {
    return 'from and to must be YYYY-MM-DD dates, from not after to';
  }
  const today = now.toISOString().slice(0, 10);
  if (spanDays(to, today) < 0) return 'to cannot be after tomorrow';
  if (spanDays(from, today) > OLDEST_DAYS)
    return `from must be within the last ${OLDEST_DAYS} days`;
  if (spanDays(from, to) > MAX_OVERVIEW_DAYS) return `at most ${MAX_OVERVIEW_DAYS} days`;
  return null;
}

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

  /** The overview for the query's range, audited once; or a reply already sent. */
  async function overviewFor(req: FastifyRequest, reply: FastifyReply) {
    const user = req.auth ? await db.users.findByEntraObjectId(req.auth.oid) : null;
    if (!user) {
      await problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
      return null;
    }
    const q = req.query as { from?: string; to?: string; section?: string };
    const now = new Date();
    const bad = rangeProblem(q.from ?? '', q.to ?? '', now);
    if (bad) {
      await problem(reply, 400, 'date_out_of_range', bad);
      return null;
    }
    const from = q.from ?? '';
    const to = q.to ?? '';
    const result = await overview(db, from, to, now);
    await db.reports.auditView({
      actorUserId: user.id,
      report: 'overview',
      detail: { from, to, people: String(result.people.length) },
      correlationId: randomUUID(),
      at: now,
    });
    return result;
  }

  const hrOrAdmin = { preHandler: [requireCapability([Capability.HrEmployeeRead])] };

  app.get('/v1/reports/overview', hrOrAdmin, async (req, reply) => {
    const result = await overviewFor(req, reply);
    if (!result) return reply;
    return reply.code(200).send(result);
  });

  app.get('/v1/reports/overview.csv', hrOrAdmin, async (req, reply) => {
    const section = (req.query as { section?: string }).section ?? '';
    if (!(section in CSV_SECTIONS)) {
      return problem(
        reply,
        400,
        'validation',
        `section must be one of ${Object.keys(CSV_SECTIONS).join(', ')}`,
      );
    }
    const result = await overviewFor(req, reply);
    if (!result) return reply;
    return reply
      .code(200)
      .type('text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="cloudpunch-${section}-${result.from}-to-${result.to}.csv"`,
      )
      .send(overviewCsv(result.people, section as CsvSection));
  });
};

export const reportRoutes = fp(reportRoutesImpl, { name: 'cloudpunch-reports', fastify: '4.x' });
export default reportRoutes;
