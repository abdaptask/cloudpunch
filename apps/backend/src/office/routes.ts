import { randomUUID } from 'node:crypto';
import { Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { requireCapability } from '../auth/require.js';
import type { AppUser, DbRepositories } from '../db/index.js';
import { MAX_BULK, replay, requestHash } from '../people/bulk.js';
import { dateIn, shiftDate } from '../shifts/model.js';
import { shiftHistory } from '../shifts/resolve.js';
import { inOffice, weekdaysOn } from './model.js';

/**
 * In-office days (ADR-0039 §5), Administrators and HR:
 *
 *   GET /v1/admin/office-days?from&to                  everyone's office days in a range
 *   PUT /v1/admin/employees/:id/office-pattern         {weekdays, effective_from?, reason?}
 *   PUT /v1/admin/employees/:id/office-days/:date      {in_office, reason?}
 *   PUT /v1/admin/employees/bulk/office-pattern        the pattern for up to 200, all or nothing
 *
 * Each change is a new append-only row with an audit_log row.
 */

export interface OfficeRoutesOptions {
  db: DbRepositories;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** How far back a one-off can be set (to fix a late flag), and the range limit. */
const PAST_DAYS = 31;
const MAX_RANGE_DAYS = 400;

const weekdays = z.array(z.number().int().min(1).max(7)).max(7);
const reason = z.string().trim().max(500).optional().nullable();
const patternBody = z
  .object({ weekdays, effective_from: z.string().regex(DATE).optional().nullable(), reason })
  .strict();
const dayBody = z.object({ in_office: z.boolean(), reason }).strict();
const bulkBody = z
  .object({
    idempotency_key: z.string().uuid(),
    employee_ids: z.array(z.string().regex(UUID)).min(1).max(MAX_BULK),
    weekdays,
    effective_from: z.string().regex(DATE).optional().nullable(),
    reason,
  })
  .strict();

function problem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/problem+json').send({ code, message });
}

/** A real calendar date in `YYYY-MM-DD`. */
function validDate(d: string): boolean {
  return DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
}

const sortDays = (d: readonly number[]): number[] => [...new Set(d)].sort((a, b) => a - b);

const officeRoutesImpl: FastifyPluginAsync<OfficeRoutesOptions> = async (app, opts) => {
  const { db } = opts;
  const write = { preHandler: [requireCapability([Capability.HrEmployeeWrite])] };

  async function actorOf(req: FastifyRequest, reply: FastifyReply): Promise<AppUser | null> {
    const actor = req.auth ? await db.users.findByEntraObjectId(req.auth.oid) : null;
    if (!actor) await problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
    return actor;
  }

  /** Today in this person's shift zone (UTC with no shift), as holidays use. */
  async function todayFor(employeeId: string): Promise<string> {
    const [row] = await shiftHistory(db, [employeeId]);
    return dateIn(Date.now(), row?.tzIana ?? 'UTC');
  }

  app.get('/v1/admin/office-days', write, async (req, reply) => {
    const q = req.query as { from?: string; to?: string };
    const today = dateIn(Date.now(), 'UTC');
    const from = q.from ?? today;
    const to = q.to ?? shiftDate(today, 30);
    if (!validDate(from) || !validDate(to) || to < from) {
      return problem(reply, 400, 'validation', 'from and to must be dates, from ≤ to');
    }
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) {
      return problem(reply, 400, 'validation', `at most ${MAX_RANGE_DAYS} days`);
    }
    const people = await db.employees.listActive();
    const ids = people.map((p) => p.id);
    const [patterns, days] = await Promise.all([
      db.office.patterns(ids),
      db.office.days(ids, from, to),
    ]);
    return reply.code(200).send({
      people: people.map((p) => {
        const mine = patterns.filter((x) => x.employeeId === p.id);
        const oneOffs = days.filter((x) => x.employeeId === p.id);
        // The latest one-off per date only.
        const dates = [...new Set(oneOffs.map((d) => d.date))].sort();
        return {
          employee_id: p.id,
          weekdays: weekdaysOn(mine, to < today ? to : today),
          days: dates.map((date) => ({ date, in_office: inOffice([], oneOffs, date) })),
        };
      }),
    });
  });

  app.put('/v1/admin/employees/:id/office-pattern', write, async (req, reply) => {
    const actor = await actorOf(req, reply);
    if (!actor) return reply;
    const { id } = req.params as { id: string };
    const e = UUID.test(id) ? await db.employees.findById(id) : null;
    if (!e || e.status !== 'active') return problem(reply, 404, 'not_found', 'no such person');
    const body = patternBody.safeParse(req.body);
    if (!body.success) {
      return problem(reply, 400, 'validation', 'body must be {weekdays, effective_from?, reason?}');
    }
    const today = await todayFor(e.id);
    const from = body.data.effective_from ?? today;
    if (!validDate(from) || from < today) {
      return problem(reply, 400, 'past_date', 'office weekdays change from today on');
    }
    const saved = await db.office.setPattern({
      employeeId: e.id,
      weekdays: sortDays(body.data.weekdays),
      effectiveFrom: from,
      reason: body.data.reason?.trim() || null,
      setByUserId: actor.id,
      correlationId: randomUUID(),
      at: new Date(),
    });
    return reply.code(200).send({
      employee_id: e.id,
      weekdays: saved.weekdays,
      effective_from: saved.effectiveFrom,
    });
  });

  app.put('/v1/admin/employees/:id/office-days/:date', write, async (req, reply) => {
    const actor = await actorOf(req, reply);
    if (!actor) return reply;
    const { id, date } = req.params as { id: string; date: string };
    const e = UUID.test(id) ? await db.employees.findById(id) : null;
    if (!e || e.status !== 'active') return problem(reply, 404, 'not_found', 'no such person');
    const body = dayBody.safeParse(req.body);
    if (!body.success)
      return problem(reply, 400, 'validation', 'body must be {in_office, reason?}');
    const today = await todayFor(e.id);
    if (
      !validDate(date) ||
      date < shiftDate(today, -PAST_DAYS) ||
      date > shiftDate(today, MAX_RANGE_DAYS)
    ) {
      return problem(reply, 400, 'validation', `a date from ${PAST_DAYS} days ago to a year ahead`);
    }
    const saved = await db.office.setDay({
      employeeId: e.id,
      date,
      inOffice: body.data.in_office,
      reason: body.data.reason?.trim() || null,
      setByUserId: actor.id,
      correlationId: randomUUID(),
      at: new Date(),
    });
    return reply.code(200).send({ employee_id: e.id, date: saved.date, in_office: saved.inOffice });
  });

  // Bulk (ADR-0038 §5): the same office weekdays for many, all or nothing.
  app.put('/v1/admin/employees/bulk/office-pattern', write, async (req, reply) => {
    const actor = await actorOf(req, reply);
    if (!actor) return reply;
    const body = bulkBody.safeParse(req.body);
    if (!body.success) {
      return problem(
        reply,
        400,
        'validation',
        `body must be {idempotency_key, employee_ids (1–${MAX_BULK}), weekdays, effective_from?, reason?}`,
      );
    }
    const key = body.data.idempotency_key.toLowerCase();
    const hash = requestHash('office', body.data);
    if (await replay(db, reply, actor.id, key, 'office', hash)) return reply;
    const ids = [...new Set(body.data.employee_ids.map((x) => x.toLowerCase()))];
    const employees = await Promise.all(ids.map((x) => db.employees.findById(x)));
    const missing = ids.filter((_, i) => employees[i]?.status !== 'active');
    if (missing.length > 0) {
      return reply.code(404).type('application/problem+json').send({
        code: 'unknown_people',
        message: 'no such active employees',
        employee_ids: missing,
      });
    }
    // One date for everyone: today in UTC unless given; never the past.
    const today = dateIn(Date.now(), 'UTC');
    const from = body.data.effective_from ?? today;
    if (!validDate(from) || from < shiftDate(today, -1)) {
      return problem(reply, 400, 'past_date', 'office weekdays change from today on');
    }
    const days = sortDays(body.data.weekdays);
    const current = await db.office.patterns(ids);
    const same = (id: string): boolean =>
      weekdaysOn(
        current.filter((p) => p.employeeId === id),
        from,
      ).join() === days.join();
    const result = {
      weekdays: days,
      effective_from: from,
      changed: ids.filter((x) => !same(x)),
      unchanged: ids.filter((x) => same(x)),
    };
    const correlationId = randomUUID();
    const at = new Date();
    const saved = await db.office.setPatterns(
      result.changed.map((employeeId) => ({
        employeeId,
        weekdays: days,
        effectiveFrom: from,
        reason: body.data.reason?.trim() || null,
        setByUserId: actor.id,
        correlationId,
        at,
      })),
      { actorUserId: actor.id, key, kind: 'office', requestHash: hash, result, correlationId, at },
    );
    if (!saved) {
      await replay(db, reply, actor.id, key, 'office', hash);
      return reply;
    }
    return reply.code(200).send(result);
  });
};

export const officeRoutes = fp(officeRoutesImpl, { name: 'cloudpunch-office', fastify: '4.x' });
export default officeRoutes;
