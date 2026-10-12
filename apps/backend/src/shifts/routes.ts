import { randomUUID } from 'node:crypto';
import { Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { requireCapability } from '../auth/require.js';
import type {
  AppUser,
  DbRepositories,
  Employee,
  ShiftAssignment,
  ShiftTemplateVersion,
} from '../db/index.js';
import { nameOf } from '../team/service.js';
import { MAX_BULK, replay, requestHash } from '../people/bulk.js';
import { activeWindow, dateIn, shiftDate, shiftOn } from './model.js';
import { shiftHistory, templateOn } from './resolve.js';

/**
 * Shifts (ADR-0031):
 *
 *   GET /v1/me/shift                   your shift, the window you're in now, and whether you said "Not working today"
 *   POST /v1/me/not-working-today      say it for the shift you're in now (no reason asked)
 *   GET /v1/admin/shifts               everyone's current shift (Administrators)
 *   PUT /v1/admin/employees/:id/shift  set or clear someone's shift (Administrators):
 *                                      a pattern, or a named shift (`template_id`), from a date
 *   PUT /v1/admin/employees/bulk/shift the same for up to 200, all or nothing (ADR-0038 §5)
 *
 * Named shifts (ADR-0038 §6), Administrators:
 *
 *   GET  /v1/admin/shift-templates             each with how many people are on it
 *   POST /v1/admin/shift-templates             {name, days, start, end, tz_iana, reason?}
 *   PUT  /v1/admin/shift-templates/:id         a new version from `effective_from` for
 *                                              everyone on it; `dry_run` counts them first
 *   POST /v1/admin/shift-templates/:id/retire  no longer offered; people keep it until moved
 *
 * Holidays (ADR-0037 §1), one company list:
 *
 *   GET /v1/holidays                   the list (anyone signed in), `?from=&to=` dates
 *   PUT /v1/admin/holidays/:date       add or rename one (HR, Administrators)
 *   DELETE /v1/admin/holidays/:date    remove one (HR, Administrators)
 *
 * Every change is a new append-only row with an audit_log row.
 */

export interface ShiftRoutesOptions {
  db: DbRepositories;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** How far ahead `GET /v1/me/shift` lists holidays, so the app knows offline. */
const HOLIDAYS_AHEAD_DAYS = 60;

const holidayBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();

/** A real calendar date in `YYYY-MM-DD`. */
function validDate(d: string): boolean {
  return DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
}

const patternFields = {
  /** ISO weekdays, 1 = Monday … 7 = Sunday; empty clears the shift. */
  days: z.array(z.number().int().min(1).max(7)).max(7),
  start: z.string().regex(HHMM).nullable().optional(),
  end: z.string().regex(HHMM).nullable().optional(),
  tz_iana: z.string().min(1).max(64),
};
const reasonField = z.string().trim().max(500).optional().nullable();
const fromField = z.string().regex(DATE).optional().nullable();

/** One person's shift: a pattern, or a named shift; from a date (today by default). */
const shiftBody = z.union([
  z.object({ ...patternFields, effective_from: fromField, reason: reasonField }).strict(),
  z
    .object({ template_id: z.string().regex(UUID), effective_from: fromField, reason: reasonField })
    .strict(),
]);

const bulkShiftBody = z.union([
  z
    .object({
      idempotency_key: z.string().uuid(),
      employee_ids: z.array(z.string().regex(UUID)).min(1).max(MAX_BULK),
      ...patternFields,
      effective_from: fromField,
      reason: reasonField,
    })
    .strict(),
  z
    .object({
      idempotency_key: z.string().uuid(),
      employee_ids: z.array(z.string().regex(UUID)).min(1).max(MAX_BULK),
      template_id: z.string().regex(UUID),
      effective_from: fromField,
      reason: reasonField,
    })
    .strict(),
]);

/** A named shift's name and pattern: it always has days. */
const templateFields = {
  name: z.string().trim().min(1).max(100),
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  start: z.string().regex(HHMM),
  end: z.string().regex(HHMM),
  tz_iana: z.string().min(1).max(64),
  reason: reasonField,
};
const newTemplateBody = z.object(templateFields).strict();
const templateVersionBody = z
  .object({
    ...templateFields,
    effective_from: z.string().regex(DATE),
    dry_run: z.boolean().optional(),
  })
  .strict();
const retireBody = z.object({ reason: reasonField }).strict();

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
    const rows = await shiftHistory(db, [m.employee.id]);
    const today = rows[0] ? dateIn(now.getTime(), rows[0].tzIana) : now.toISOString().slice(0, 10);
    const w = activeWindow(rows, now);
    const declared = w ? (await db.shifts.notWorking([m.employee.id], [w.date])).size > 0 : false;
    // The app skips its popups on these (ADR-0037 §2): yesterday on,
    // so an overnight shift and every zone are covered.
    const holidays = await db.holidays.between(
      shiftDate(today, -1),
      shiftDate(today, HOLIDAYS_AHEAD_DAYS),
    );
    const off = w ? holidays.find((h) => h.date === w.date) : undefined;
    return reply.code(200).send({
      shift: shiftView(shiftOn(rows, today)),
      window: w ? { date: w.date, start: w.start.toISOString(), end: w.end.toISOString() } : null,
      not_working: declared,
      day_off: off ? { kind: 'holiday', name: off.name } : null,
      holidays: holidays.map((h) => ({ date: h.date, name: h.name })),
    });
  });

  app.post('/v1/me/not-working-today', async (req, reply) => {
    const m = await me(req, reply);
    if (!m) return reply;
    const now = new Date();
    const w = activeWindow(await shiftHistory(db, [m.employee.id]), now);
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

  app.get('/v1/holidays', async (req, reply) => {
    if (!req.auth) return problem(reply, 401, 'unauthorized', 'authentication required');
    const q = req.query as { from?: string; to?: string };
    const today = dateIn(Date.now(), 'UTC');
    const from = q.from ?? shiftDate(today, -30);
    const to = q.to ?? shiftDate(today, 366);
    if (!validDate(from) || !validDate(to) || from > to) {
      return problem(reply, 400, 'validation', 'from and to must be dates, from first');
    }
    const list = await db.holidays.between(from, to);
    return reply.code(200).send({ holidays: list.map((h) => ({ date: h.date, name: h.name })) });
  });

  const holidayAdmin = { preHandler: [requireCapability([Capability.HrHolidayWrite])] };

  async function holidayActor(req: FastifyRequest, reply: FastifyReply) {
    if (!req.auth) {
      await problem(reply, 401, 'unauthorized', 'authentication required');
      return null;
    }
    const actor = await db.users.findByEntraObjectId(req.auth.oid);
    if (!actor) {
      await problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
      return null;
    }
    const { date } = req.params as { date: string };
    if (!validDate(date)) {
      await problem(reply, 400, 'validation', 'the date must be YYYY-MM-DD');
      return null;
    }
    return { actor, date };
  }

  app.put('/v1/admin/holidays/:date', holidayAdmin, async (req, reply) => {
    const a = await holidayActor(req, reply);
    if (!a) return reply;
    const parsed = holidayBody.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, 400, 'validation', parsed.error.issues[0]?.message ?? 'invalid body');
    }
    const saved = await db.holidays.record({
      date: a.date,
      name: parsed.data.name,
      cancelled: false,
      addedByUserId: a.actor.id,
      correlationId: randomUUID(),
      at: new Date(),
    });
    return reply.code(200).send({ date: saved.date, name: saved.name });
  });

  app.delete('/v1/admin/holidays/:date', holidayAdmin, async (req, reply) => {
    const a = await holidayActor(req, reply);
    if (!a) return reply;
    const [current] = await db.holidays.between(a.date, a.date);
    if (!current) return problem(reply, 404, 'not_found', 'that date is not a holiday');
    await db.holidays.record({
      date: a.date,
      name: current.name,
      cancelled: true,
      addedByUserId: a.actor.id,
      correlationId: randomUUID(),
      at: new Date(),
    });
    return reply.code(204).send();
  });

  const admin = { preHandler: [requireCapability([Capability.AdminShiftWrite])] };

  async function actorOf(req: FastifyRequest, reply: FastifyReply): Promise<AppUser | null> {
    if (!req.auth) {
      await problem(reply, 401, 'unauthorized', 'authentication required');
      return null;
    }
    const actor = await db.users.findByEntraObjectId(req.auth.oid);
    if (!actor) await problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
    return actor;
  }

  /** The stored row in force on `date` for each person (named or custom). */
  function inForce(rows: readonly ShiftAssignment[], date: (r: ShiftAssignment) => string) {
    const out = new Map<string, ShiftAssignment>();
    for (const r of rows) {
      if (!out.has(r.employeeId) && r.effectiveFrom <= date(r)) out.set(r.employeeId, r);
    }
    return out;
  }

  /** Newest version of each named shift, by id. */
  function latestOf(versions: readonly ShiftTemplateVersion[]): Map<string, ShiftTemplateVersion> {
    const out = new Map<string, ShiftTemplateVersion>();
    // `templates()` is newest first; a future version is still the latest made.
    for (const v of versions) if (!out.has(v.templateId)) out.set(v.templateId, v);
    return out;
  }

  /**
   * What a shift change sets: a pattern, or a named shift's version on
   * the date, from `effective_from` (today in the shift's zone by
   * default, never earlier). A reply already sent when it can't.
   */
  async function targetOf(
    reply: FastifyReply,
    b: z.infer<typeof shiftBody>,
  ): Promise<{
    days: number[];
    start: string | null;
    end: string | null;
    tzIana: string;
    templateId: string | null;
    from: string;
  } | null> {
    if ('template_id' in b) {
      const id = b.template_id.toLowerCase();
      const versions = (await db.shifts.templates()).filter((v) => v.templateId === id);
      const latest = versions[0];
      if (!latest) {
        await problem(reply, 404, 'template_not_found', 'no such named shift');
        return null;
      }
      const from = b.effective_from ?? dateIn(Date.now(), latest.tzIana);
      if (!validDate(from) || from < dateIn(Date.now(), latest.tzIana)) {
        await problem(reply, 400, 'past_date', 'a shift can change from today on, not before');
        return null;
      }
      // Before its first version: that first version.
      const v = templateOn(versions, id, from) ?? versions.at(-1) ?? latest;
      if (latestOf(versions).get(id)?.retired) {
        await problem(reply, 409, 'template_retired', 'that named shift is retired');
        return null;
      }
      return { days: v.days, start: v.start, end: v.end, tzIana: v.tzIana, templateId: id, from };
    }
    if (!validZone(b.tz_iana)) {
      await problem(reply, 400, 'validation', 'unknown time zone');
      return null;
    }
    const days = [...new Set(b.days)].sort((x, y) => x - y);
    const clearing = days.length === 0;
    if (!clearing && (!b.start || !b.end || b.start === b.end)) {
      await problem(reply, 400, 'validation', 'a shift needs a start and a different end');
      return null;
    }
    const from = b.effective_from ?? dateIn(Date.now(), b.tz_iana);
    if (!validDate(from) || from < dateIn(Date.now(), b.tz_iana)) {
      await problem(reply, 400, 'past_date', 'a shift can change from today on, not before');
      return null;
    }
    return {
      days,
      start: clearing ? null : (b.start ?? null),
      end: clearing ? null : (b.end ?? null),
      tzIana: b.tz_iana,
      templateId: null,
      from,
    };
  }

  app.get('/v1/admin/shifts', admin, async (_req, reply) => {
    const people = await db.employees.listActive();
    const rows = await shiftHistory(
      db,
      people.map((p) => p.id),
    );
    const versions = rows.some((r) => r.templateId) ? await db.shifts.templates() : [];
    const now = Date.now();
    return reply.code(200).send({
      people: people.map((p) => {
        const mine = rows.filter((r) => r.employeeId === p.id);
        const tz = mine[0]?.tzIana ?? 'UTC';
        const today = dateIn(now, tz);
        const s = shiftOn(mine, today);
        const named = s?.templateId ? templateOn(versions, s.templateId, today) : null;
        return {
          employee_id: p.id,
          name: nameOf(p),
          shift: shiftView(s),
          template: s?.templateId && named ? { id: s.templateId, name: named.name } : null,
        };
      }),
    });
  });

  app.put('/v1/admin/employees/:id/shift', admin, async (req, reply) => {
    const actor = await actorOf(req, reply);
    if (!actor) return reply;
    const { id } = req.params as { id: string };
    const e = UUID.test(id) ? await db.employees.findById(id) : null;
    if (!e || e.status !== 'active') return problem(reply, 404, 'not_found', 'no such person');
    const parsed = shiftBody.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, 400, 'validation', parsed.error.issues[0]?.message ?? 'invalid body');
    }
    const target = await targetOf(reply, parsed.data);
    if (!target) return reply;
    const now = new Date();
    const saved = await db.shifts.assign({
      employeeId: e.id,
      days: target.days,
      start: target.start,
      end: target.end,
      tzIana: target.tzIana,
      templateId: target.templateId,
      effectiveFrom: target.from,
      reason: parsed.data.reason ?? null,
      assignedByUserId: actor.id,
      correlationId: randomUUID(),
      at: now,
    });
    return reply.code(200).send({
      employee_id: e.id,
      shift: shiftView(saved),
      template_id: saved.templateId,
      effective_from: saved.effectiveFrom,
    });
  });

  // Bulk (ADR-0038 §5): one shift for many, all or nothing, from a date.
  app.put('/v1/admin/employees/bulk/shift', admin, async (req, reply) => {
    const actor = await actorOf(req, reply);
    if (!actor) return reply;
    const parsed = bulkShiftBody.safeParse(req.body);
    if (!parsed.success) {
      return problem(
        reply,
        400,
        'validation',
        `body must be {idempotency_key, employee_ids (1–${MAX_BULK}), a pattern or template_id, effective_from?, reason?}`,
      );
    }
    const { idempotency_key, employee_ids, ...one } = parsed.data;
    const key = idempotency_key.toLowerCase();
    const hash = requestHash('shift', parsed.data);
    if (await replay(db, reply, actor.id, key, 'shift', hash)) return reply;

    const ids = [...new Set(employee_ids.map((x) => x.toLowerCase()))];
    const employees = await Promise.all(ids.map((x) => db.employees.findById(x)));
    const missing = ids.filter((_, i) => employees[i]?.status !== 'active');
    if (missing.length > 0) {
      return reply.code(404).type('application/problem+json').send({
        code: 'unknown_people',
        message: 'no such active employees',
        employee_ids: missing,
      });
    }
    const target = await targetOf(reply, one);
    if (!target) return reply;

    // Already on exactly this from that date: left as they are.
    const current = inForce(await db.shifts.history(ids), () => target.from);
    const same = (r: ShiftAssignment | undefined): boolean =>
      !!r &&
      (target.templateId
        ? r.templateId === target.templateId
        : r.templateId === null &&
          r.days.join() === target.days.join() &&
          r.start === target.start &&
          r.end === target.end &&
          r.tzIana === target.tzIana);
    const result = {
      template_id: target.templateId,
      effective_from: target.from,
      changed: ids.filter((x) => !same(current.get(x))),
      unchanged: ids.filter((x) => same(current.get(x))),
    };
    const correlationId = randomUUID();
    const at = new Date();
    const saved = await db.shifts.assignMany(
      result.changed.map((employeeId) => ({
        employeeId,
        days: target.days,
        start: target.start,
        end: target.end,
        tzIana: target.tzIana,
        templateId: target.templateId,
        effectiveFrom: target.from,
        reason: one.reason?.trim() || null,
        assignedByUserId: actor.id,
        correlationId,
        at,
      })),
      { actorUserId: actor.id, key, kind: 'shift', requestHash: hash, result, correlationId, at },
    );
    if (!saved) {
      await replay(db, reply, actor.id, key, 'shift', hash);
      return reply;
    }
    req.log.info(
      { changed: result.changed.length, correlationId },
      'shifts: bulk shift set (ADR-0038)',
    );
    return reply.code(200).send(result);
  });

  // Named shifts (ADR-0038 §6).

  /** A named shift's version as the API shows it. */
  const versionView = (v: ShiftTemplateVersion) => ({
    name: v.name,
    days: v.days,
    start: v.start,
    end: v.end,
    tz_iana: v.tzIana,
    effective_from: v.effectiveFrom,
  });

  /** How many people each named shift has on `date` (their zone's today). */
  async function peopleOn(
    date: (r: ShiftAssignment) => string,
  ): Promise<{ byTemplate: Map<string, string[]>; custom: number; none: number }> {
    const people = await db.employees.listActive();
    const current = inForce(await db.shifts.history(people.map((p) => p.id)), date);
    const byTemplate = new Map<string, string[]>();
    let custom = 0;
    for (const p of people) {
      const r = current.get(p.id);
      if (r?.templateId)
        byTemplate.set(r.templateId, [...(byTemplate.get(r.templateId) ?? []), p.id]);
      else if (r && r.days.length > 0) custom += 1;
    }
    return {
      byTemplate,
      custom,
      none: people.length - custom - [...byTemplate.values()].flat().length,
    };
  }

  /** Another named shift, not retired, already has this name. */
  function nameTaken(
    versions: readonly ShiftTemplateVersion[],
    name: string,
    except: string | null,
  ): boolean {
    const wanted = name.trim().toLowerCase();
    return [...latestOf(versions).values()].some(
      (v) => v.templateId !== except && !v.retired && v.name.trim().toLowerCase() === wanted,
    );
  }

  app.get('/v1/admin/shift-templates', admin, async (_req, reply) => {
    const versions = await db.shifts.templates();
    const now = Date.now();
    const counts = await peopleOn((r) => dateIn(now, r.tzIana));
    const templates = [...latestOf(versions).keys()].map((id) => {
      const mine = versions.filter((v) => v.templateId === id);
      const tz = mine[0]?.tzIana ?? 'UTC';
      const today = dateIn(now, tz);
      const v = templateOn(mine, id, today) ?? (mine.at(-1) as ShiftTemplateVersion);
      const next = [...mine].reverse().find((x) => x.effectiveFrom > today) ?? null;
      return {
        id,
        ...versionView(v),
        retired: v.retired,
        next: next ? { ...versionView(next), retired: next.retired } : null,
        people: counts.byTemplate.get(id)?.length ?? 0,
      };
    });
    templates.sort((a, b) => Number(a.retired) - Number(b.retired) || a.name.localeCompare(b.name));
    return reply.code(200).send({ templates, custom: counts.custom, none: counts.none });
  });

  app.post('/v1/admin/shift-templates', admin, async (req, reply) => {
    const actor = await actorOf(req, reply);
    if (!actor) return reply;
    const parsed = newTemplateBody.safeParse(req.body);
    if (!parsed.success || !validZone(parsed.data.tz_iana)) {
      return problem(
        reply,
        400,
        'validation',
        'body must be {name, days, start, end, tz_iana, reason?}',
      );
    }
    const b = parsed.data;
    if (b.start === b.end)
      return problem(reply, 400, 'validation', 'the end must differ from the start');
    if (nameTaken(await db.shifts.templates(), b.name, null)) {
      return problem(reply, 409, 'name_taken', 'another named shift has that name');
    }
    const now = new Date();
    const v = await db.shifts.saveTemplateVersion({
      templateId: null,
      name: b.name.trim(),
      days: [...new Set(b.days)].sort((x, y) => x - y),
      start: b.start,
      end: b.end,
      tzIana: b.tz_iana,
      retired: false,
      effectiveFrom: dateIn(now.getTime(), b.tz_iana),
      reason: b.reason?.trim() || null,
      createdByUserId: actor.id,
      correlationId: randomUUID(),
      at: now,
    });
    return reply.code(201).send({ id: v.templateId, ...versionView(v), retired: false, people: 0 });
  });

  app.put('/v1/admin/shift-templates/:id', admin, async (req, reply) => {
    const actor = await actorOf(req, reply);
    if (!actor) return reply;
    const id = String((req.params as { id?: string }).id ?? '').toLowerCase();
    const versions = await db.shifts.templates();
    const latest = UUID.test(id) ? latestOf(versions).get(id) : undefined;
    if (!latest) return problem(reply, 404, 'template_not_found', 'no such named shift');
    const parsed = templateVersionBody.safeParse(req.body);
    if (!parsed.success || !validZone(parsed.data.tz_iana)) {
      return problem(
        reply,
        400,
        'validation',
        'body must be {name, days, start, end, tz_iana, effective_from, reason?, dry_run?}',
      );
    }
    const b = parsed.data;
    if (b.start === b.end)
      return problem(reply, 400, 'validation', 'the end must differ from the start');
    if (!validDate(b.effective_from) || b.effective_from < dateIn(Date.now(), b.tz_iana)) {
      return problem(reply, 400, 'past_date', 'a named shift can change from today on, not before');
    }
    if (latest.retired)
      return problem(reply, 409, 'template_retired', 'that named shift is retired');
    if (nameTaken(versions, b.name, id)) {
      return problem(reply, 409, 'name_taken', 'another named shift has that name');
    }
    // Who it changes: everyone on it on that date ("14 people from 19 Oct").
    const affected = (await peopleOn(() => b.effective_from)).byTemplate.get(id)?.length ?? 0;
    if (b.dry_run) {
      return reply.code(200).send({ people: affected, effective_from: b.effective_from });
    }
    const now = new Date();
    const v = await db.shifts.saveTemplateVersion({
      templateId: id,
      name: b.name.trim(),
      days: [...new Set(b.days)].sort((x, y) => x - y),
      start: b.start,
      end: b.end,
      tzIana: b.tz_iana,
      retired: false,
      effectiveFrom: b.effective_from,
      reason: b.reason?.trim() || null,
      createdByUserId: actor.id,
      correlationId: randomUUID(),
      at: now,
    });
    return reply.code(200).send({ id, ...versionView(v), retired: false, people: affected });
  });

  app.post('/v1/admin/shift-templates/:id/retire', admin, async (req, reply) => {
    const actor = await actorOf(req, reply);
    if (!actor) return reply;
    const id = String((req.params as { id?: string }).id ?? '').toLowerCase();
    const versions = await db.shifts.templates();
    const latest = UUID.test(id) ? latestOf(versions).get(id) : undefined;
    if (!latest) return problem(reply, 404, 'template_not_found', 'no such named shift');
    const parsed = retireBody.safeParse(req.body ?? {});
    if (!parsed.success) return problem(reply, 400, 'validation', 'body must be {reason?}');
    if (latest.retired) return reply.code(200).send({ id, retired: true });
    const now = new Date();
    // The same pattern, marked retired: nobody's shift changes.
    await db.shifts.saveTemplateVersion({
      templateId: id,
      name: latest.name,
      days: latest.days,
      start: latest.start,
      end: latest.end,
      tzIana: latest.tzIana,
      retired: true,
      effectiveFrom: [
        latest.effectiveFrom,
        dateIn(now.getTime(), latest.tzIana),
      ].sort()[1] as string,
      reason: parsed.data.reason?.trim() || null,
      createdByUserId: actor.id,
      correlationId: randomUUID(),
      at: now,
    });
    return reply.code(200).send({ id, retired: true });
  });
};

export const shiftRoutes = fp(shiftRoutesImpl, { name: 'cloudpunch-shifts', fastify: '4.x' });
export default shiftRoutes;
