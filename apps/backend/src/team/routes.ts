import { randomUUID } from 'node:crypto';
import { Capability, capabilitiesForRoles } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { requireCapability } from '../auth/require.js';
import type { AppUser, DbRepositories, Employee } from '../db/index.js';
import { LOOKBACK_DAYS, daySummaries, dayView, inLookback, spanDays } from '../days/service.js';
import {
  inScope,
  nameOf,
  peopleIn,
  scopeFor,
  teamExceptions,
  teamNow,
  type TeamScope,
} from './service.js';

/**
 * Manager and HR team views (ADR-0025), and reporting lines:
 *
 *   GET /v1/team                              Team today
 *   GET /v1/team/exceptions?from&to[&employee_id]
 *   GET /v1/team/:employeeId/days/:date       a person's day
 *   GET /v1/team/:employeeId/days?from&to     a person's day totals
 *   GET /v1/admin/employees                   everyone, with their manager (People)
 *   PUT /v1/admin/employees/:id/manager       {manager_employee_id | null, reason?}
 *
 * Every team request checks the caller's scope (a Manager: direct
 * reports; HR: everyone). Anyone outside it is 404, so the API doesn't
 * confirm who exists (invariant 5). Opening someone's day or exceptions
 * is audited (§4).
 */

export interface TeamRoutesOptions {
  db: DbRepositories;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RANGE_DAYS = 31;
const MAX_CHAIN = 50;

const managerBody = z
  .object({
    manager_employee_id: z.string().regex(UUID).nullable(),
    reason: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

function problem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/problem+json').send({ code, message });
}

const teamRoutesImpl: FastifyPluginAsync<TeamRoutesOptions> = async (app, opts) => {
  const db = opts.db;

  /** The caller's user and team scope, or a reply already sent. */
  async function caller(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ user: AppUser; scope: TeamScope } | null> {
    const user = req.auth ? await db.users.findByEntraObjectId(req.auth.oid) : null;
    if (!user || !req.auth) {
      await problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
      return null;
    }
    const caps = new Set<string>(capabilitiesForRoles(req.auth.roles));
    return { user, scope: scopeFor(caps, user.employeeId) };
  }

  /** The person, if in the caller's scope; otherwise 404 (ADR-0025 §2). */
  async function subject(
    reply: FastifyReply,
    scope: TeamScope,
    id: string,
  ): Promise<Employee | null> {
    const e = UUID.test(id) ? await db.employees.findById(id) : null;
    if (!e || !inScope(scope, e)) {
      await problem(reply, 404, 'not_found', 'no such person on your team');
      return null;
    }
    return e;
  }

  const range = (
    reply: FastifyReply,
    q: { from?: string; to?: string },
    now: Date,
  ): { from: string; to: string } | null => {
    const from = q.from ?? '';
    const to = q.to ?? '';
    if (!inLookback(from, now) || !inLookback(to, now) || from > to) {
      void problem(
        reply,
        400,
        'date_out_of_range',
        `from and to must be YYYY-MM-DD within the last ${LOOKBACK_DAYS} days`,
      );
      return null;
    }
    if (spanDays(from, to) > MAX_RANGE_DAYS) {
      void problem(reply, 400, 'range_too_long', `at most ${MAX_RANGE_DAYS} days`);
      return null;
    }
    return { from, to };
  };

  const audit = (
    actor: AppUser,
    employeeId: string,
    action: 'day_viewed' | 'exceptions_viewed',
    detail: Record<string, string>,
  ) =>
    db.employees.auditView({
      actorUserId: actor.id,
      employeeId,
      action,
      detail,
      correlationId: randomUUID(),
      at: new Date(),
    });

  const team = { preHandler: [requireCapability([Capability.TeamTimelineRead])] };

  app.get('/v1/team', team, async (req, reply) => {
    const c = await caller(req, reply);
    if (!c) return reply;
    const people = await peopleIn(db, c.scope);
    return reply.code(200).send({ people: await teamNow(db, people, new Date()) });
  });

  app.get('/v1/team/exceptions', team, async (req, reply) => {
    const c = await caller(req, reply);
    if (!c) return reply;
    const q = req.query as { from?: string; to?: string; employee_id?: string };
    const now = new Date();
    const r = range(reply, q, now);
    if (!r) return reply;
    let people = await peopleIn(db, c.scope);
    if (q.employee_id !== undefined) {
      const one = await subject(reply, c.scope, q.employee_id);
      if (!one) return reply;
      people = [one];
    }
    const found = await teamExceptions(db, people, r.from, r.to, now);
    for (const e of people) await audit(c.user, e.id, 'exceptions_viewed', r);
    return reply.code(200).send({ from: r.from, to: r.to, exceptions: found });
  });

  app.get('/v1/team/:employeeId/days/:date', team, async (req, reply) => {
    const c = await caller(req, reply);
    if (!c) return reply;
    const { employeeId, date } = req.params as { employeeId: string; date: string };
    const e = await subject(reply, c.scope, employeeId);
    if (!e) return reply;
    const now = new Date();
    if (!inLookback(date, now)) {
      return problem(
        reply,
        400,
        'date_out_of_range',
        `date must be YYYY-MM-DD within the last ${LOOKBACK_DAYS} days`,
      );
    }
    await audit(c.user, e.id, 'day_viewed', { date });
    return reply.code(200).send({ name: nameOf(e), ...(await dayView(db, e.id, date, now)) });
  });

  app.get('/v1/team/:employeeId/days', team, async (req, reply) => {
    const c = await caller(req, reply);
    if (!c) return reply;
    const { employeeId } = req.params as { employeeId: string };
    const e = await subject(reply, c.scope, employeeId);
    if (!e) return reply;
    const now = new Date();
    const r = range(reply, req.query as { from?: string; to?: string }, now);
    if (!r) return reply;
    await audit(c.user, e.id, 'day_viewed', r);
    return reply
      .code(200)
      .send({ name: nameOf(e), days: await daySummaries(db, e.id, r.from, r.to, now) });
  });

  // Reporting lines (ADR-0025 §1): HR and Administrators.
  app.get(
    '/v1/admin/employees',
    { preHandler: [requireCapability([Capability.HrEmployeeRead])] },
    async (_req, reply) => {
      const all = await db.employees.listActive();
      return reply.code(200).send({
        employees: all.map((e) => ({
          id: e.id,
          name: nameOf(e),
          email: e.workEmail || null,
          reporting_manager_id: e.reportingManagerId ?? null,
        })),
      });
    },
  );

  app.put(
    '/v1/admin/employees/:id/manager',
    { preHandler: [requireCapability([Capability.HrEmployeeWrite])] },
    async (req, reply) => {
      const body = managerBody.safeParse(req.body);
      if (!body.success) {
        return problem(reply, 400, 'validation', 'body must be {manager_employee_id, reason?}');
      }
      const actor = req.auth ? await db.users.findByEntraObjectId(req.auth.oid) : null;
      if (!actor)
        return problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
      const { id } = req.params as { id: string };
      const employee = UUID.test(id) ? await db.employees.findById(id) : null;
      if (!employee) return problem(reply, 404, 'not_found', 'no such employee');
      const managerId = body.data.manager_employee_id;
      if (managerId !== null) {
        if (managerId === employee.id) {
          return problem(reply, 400, 'self_manager', "someone can't be their own manager");
        }
        const manager = await db.employees.findById(managerId);
        if (!manager || manager.status !== 'active') {
          return problem(
            reply,
            404,
            'manager_not_found',
            'no such active employee to be the manager',
          );
        }
        // No loops: walk up from the new manager.
        let up: string | null | undefined = manager.reportingManagerId;
        for (let i = 0; up && i < MAX_CHAIN; i++) {
          if (up === employee.id) {
            return problem(reply, 400, 'manager_loop', 'that would make a reporting loop');
          }
          up = (await db.employees.findById(up))?.reportingManagerId;
        }
      }
      await db.employees.setReportingManager({
        employeeId: employee.id,
        managerId,
        actorUserId: actor.id,
        reason: body.data.reason ?? null,
        correlationId: randomUUID(),
        at: new Date(),
      });
      return reply.code(200).send({ id: employee.id, reporting_manager_id: managerId });
    },
  );
};

export const teamRoutes = fp(teamRoutesImpl, { name: 'cloudpunch-team', fastify: '4.x' });
export default teamRoutes;
