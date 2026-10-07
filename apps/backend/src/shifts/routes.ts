import { randomUUID } from 'node:crypto';
import { Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { requireCapability } from '../auth/require.js';
import type { AppUser, DbRepositories, Employee, ShiftAssignment } from '../db/index.js';
import { nameOf } from '../team/service.js';
import { activeWindow, dateIn, shiftOn } from './model.js';

/**
 * Shifts (ADR-0031):
 *
 *   GET /v1/me/shift                   your shift, the window you're in now, and whether you said "Not working today"
 *   POST /v1/me/not-working-today      say it for the shift you're in now (no reason asked)
 *   GET /v1/admin/shifts               everyone's current shift (Administrators)
 *   PUT /v1/admin/employees/:id/shift  set or clear someone's shift (Administrators)
 *
 * Every change is a new append-only row with an audit_log row.
 */

export interface ShiftRoutesOptions {
  db: DbRepositories;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const shiftBody = z
  .object({
    /** ISO weekdays, 1 = Monday … 7 = Sunday; empty clears the shift. */
    days: z.array(z.number().int().min(1).max(7)).max(7),
    start: z.string().regex(HHMM).nullable().optional(),
    end: z.string().regex(HHMM).nullable().optional(),
    tz_iana: z.string().min(1).max(64),
    reason: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

function problem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/problem+json').send({ code, message });
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A shift as the API shows it, or null for none. */
export function shiftView(s: ShiftAssignment | null) {
  return s && s.start && s.end
    ? { days: s.days, start: s.start, end: s.end, tz_iana: s.tzIana }
    : null;
}

const shiftRoutesImpl: FastifyPluginAsync<ShiftRoutesOptions> = async (app, opts) => {
  const db = opts.db;

  async function me(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ user: AppUser; employee: Employee } | null> {
    if (!req.auth) {
      await problem(reply, 401, 'unauthorized', 'authentication required');
      return null;
    }
    const user = await db.users.findByEntraObjectId(req.auth.oid);
    const employee = user?.employeeId ? await db.employees.findById(user.employeeId) : null;
    if (!user || !employee) {
      await problem(reply, 404, 'no_employee', 'your account has no employee record');
      return null;
    }
    return { user, employee };
  }

  app.get('/v1/me/shift', async (req, reply) => {
    const m = await me(req, reply);
    if (!m) return reply;
    const now = new Date();
    const rows = await db.shifts.history([m.employee.id]);
    const today = rows[0] ? dateIn(now.getTime(), rows[0].tzIana) : now.toISOString().slice(0, 10);
    const w = activeWindow(rows, now);
    const declared = w ? (await db.shifts.notWorking([m.employee.id], [w.date])).size > 0 : false;
    return reply.code(200).send({
      shift: shiftView(shiftOn(rows, today)),
      window: w ? { date: w.date, start: w.start.toISOString(), end: w.end.toISOString() } : null,
      not_working: declared,
    });
  });

  app.post('/v1/me/not-working-today', async (req, reply) => {
    const m = await me(req, reply);
    if (!m) return reply;
    const now = new Date();
    const w = activeWindow(await db.shifts.history([m.employee.id]), now);
    if (!w) return problem(reply, 409, 'no_shift_now', 'you are not in a shift right now');
    await db.shifts.declareNotWorking({
      employeeId: m.employee.id,
      shiftDate: w.date,
      declaredByUserId: m.user.id,
      correlationId: randomUUID(),
      at: now,
    });
    return reply.code(200).send({ date: w.date });
  });

  const admin = { preHandler: [requireCapability([Capability.AdminShiftWrite])] };

  app.get('/v1/admin/shifts', admin, async (_req, reply) => {
    const people = await db.employees.listActive();
    const rows = await db.shifts.history(people.map((p) => p.id));
    const now = Date.now();
    return reply.code(200).send({
      people: people.map((p) => {
        const mine = rows.filter((r) => r.employeeId === p.id);
        const tz = mine[0]?.tzIana ?? 'UTC';
        return {
          employee_id: p.id,
          name: nameOf(p),
          shift: shiftView(shiftOn(mine, dateIn(now, tz))),
        };
      }),
    });
  });

  app.put('/v1/admin/employees/:id/shift', admin, async (req, reply) => {
    if (!req.auth) return problem(reply, 401, 'unauthorized', 'authentication required');
    const actor = await db.users.findByEntraObjectId(req.auth.oid);
    if (!actor)
      return problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
    const { id } = req.params as { id: string };
    const e = UUID.test(id) ? await db.employees.findById(id) : null;
    if (!e || e.status !== 'active') return problem(reply, 404, 'not_found', 'no such person');
    const parsed = shiftBody.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, 400, 'validation', parsed.error.issues[0]?.message ?? 'invalid body');
    }
    const b = parsed.data;
    if (!validZone(b.tz_iana)) return problem(reply, 400, 'validation', 'unknown time zone');
    const days = [...new Set(b.days)].sort((x, y) => x - y);
    const clearing = days.length === 0;
    if (!clearing && (!b.start || !b.end || b.start === b.end)) {
      return problem(reply, 400, 'validation', 'a shift needs a start and a different end');
    }
    const now = new Date();
    const saved = await db.shifts.assign({
      employeeId: e.id,
      days,
      start: clearing ? null : (b.start ?? null),
      end: clearing ? null : (b.end ?? null),
      tzIana: b.tz_iana,
      // From today in the shift's zone; a later start date can come later.
      effectiveFrom: dateIn(now.getTime(), b.tz_iana),
      reason: b.reason ?? null,
      assignedByUserId: actor.id,
      correlationId: randomUUID(),
      at: now,
    });
    return reply.code(200).send({ employee_id: e.id, shift: shiftView(saved) });
  });
};

export const shiftRoutes = fp(shiftRoutesImpl, { name: 'cloudpunch-shifts', fastify: '4.x' });
export default shiftRoutes;
