import { randomUUID } from 'node:crypto';
import { Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import type { ShiftMail } from '../alerts/mail.js';
import { requireAuth, requireCapability } from '../auth/require.js';
import type { AppUser, DbRepositories, Employee, ManagerNote } from '../db/index.js';
import { INDIA_TZ, rangeRows } from '../reports/day.js';
import { dateIn, shiftDate } from '../shifts/model.js';
import { nameOf } from '../team/service.js';
import { NOTE_DAYS, noteMail, summaryOf, TOPICS, type NoteSummary } from './summary.js';

/**
 * "Tell manager" (ADR-0055):
 *
 *   GET  /v1/admin/people/:employeeId/manager-notes   manager, 14 days, past notes
 *   POST /v1/admin/people/:employeeId/manager-notes   {topics, message}
 *   GET  /v1/team/manager-notes                        notes addressed to me
 *   POST /v1/team/manager-notes/:id/seen
 *
 * HR and Administrators send (`hr.employee.write`). Only the manager a
 * note went to can see it in Team or mark it seen. The person it is
 * about never gets it from any endpoint (§4).
 */

export interface ManagerNoteRoutesOptions {
  db: DbRepositories;
  /** CloudPunch's mailbox; without it a note is refused (503). */
  send?: ((m: ShiftMail) => Promise<void>) | null;
  siteUrl: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Notes stay in a manager's Team list this long once seen. */
const SHOWN_DAYS = 30;

const sendBody = z
  .object({
    topics: z
      .array(z.enum(['activity', 'timings', 'breaks', 'missed']))
      .min(1)
      .max(4)
      .transform((xs) => TOPICS.filter((t) => xs.includes(t))),
    message: z.string().trim().min(10).max(2000),
  })
  .strict();

function problem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/problem+json').send({ code, message });
}

const firstName = (e: Employee): string => e.givenName || nameOf(e).split(' ')[0] || nameOf(e);

/** The 14 days ending yesterday, India time. */
function window(now: Date): { from: string; to: string } {
  const to = shiftDate(dateIn(now.getTime(), INDIA_TZ), -1);
  return { from: shiftDate(to, -(NOTE_DAYS - 1)), to };
}

export interface NoteView {
  id: string;
  employee_id: string;
  name: string;
  manager_id: string;
  manager_name: string;
  sent_by: string | null;
  sent_at: string;
  topics: string[];
  message: string;
  summary: unknown;
  seen_at: string | null;
  seen_by: string | null;
  follow_up_on: string;
  follow_up: unknown;
}

const viewOf = (n: ManagerNote, names: ReadonlyMap<string, string>): NoteView => ({
  id: n.id,
  employee_id: n.employeeId,
  name: names.get(n.employeeId) ?? 'Someone no longer listed',
  manager_id: n.managerId,
  manager_name: names.get(n.managerId) ?? 'Someone no longer listed',
  sent_by: n.sentByName,
  sent_at: n.sentAt.toISOString(),
  topics: n.topics,
  message: n.message,
  summary: n.summary,
  seen_at: n.seenAt ? n.seenAt.toISOString() : null,
  seen_by: n.seenByName,
  follow_up_on: n.followUpOn,
  follow_up: n.followUp,
});

/** Why a note can't be sent about this person, or null. */
type Blocked = 'inactive' | 'no_manager' | 'self' | 'own_manager' | null;

const managerNoteRoutesImpl: FastifyPluginAsync<ManagerNoteRoutesOptions> = async (app, opts) => {
  const db = opts.db;

  async function userOf(req: FastifyRequest, reply: FastifyReply): Promise<AppUser | null> {
    const user = req.auth ? await db.users.findByEntraObjectId(req.auth.oid) : null;
    if (!user) {
      await problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
      return null;
    }
    return user;
  }

  async function namesFor(ids: Iterable<string>): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const id of new Set(ids)) {
      const e = await db.employees.findById(id);
      if (e) names.set(id, nameOf(e));
    }
    return names;
  }

  /** The person, their manager, and whether a note can go. */
  async function subject(
    employeeId: string,
    caller: AppUser,
  ): Promise<{ person: Employee; manager: Employee | null; blocked: Blocked } | null> {
    const person = UUID.test(employeeId) ? await db.employees.findById(employeeId) : null;
    if (!person) return null;
    const manager = person.reportingManagerId
      ? await db.employees.findById(person.reportingManagerId)
      : null;
    const active = manager && manager.status === 'active' ? manager : null;
    const blocked: Blocked =
      person.status !== 'active'
        ? 'inactive'
        : !active
          ? 'no_manager'
          : caller.employeeId === person.id
            ? 'self'
            : caller.employeeId === active.id
              ? 'own_manager'
              : null;
    return { person, manager: active, blocked };
  }

  async function summaryFor(person: Employee, now: Date): Promise<NoteSummary> {
    const w = window(now);
    return summaryOf(await rangeRows(db, [person], w.from, w.to, now), w.from, w.to);
  }

  const hr = { preHandler: [requireCapability([Capability.HrEmployeeWrite])] };

  app.get('/v1/admin/people/:employeeId/manager-notes', hr, async (req, reply) => {
    const caller = await userOf(req, reply);
    if (!caller) return reply;
    const s = await subject((req.params as { employeeId: string }).employeeId, caller);
    if (!s) return problem(reply, 404, 'not_found', 'no such employee');
    const notes = await db.managerNotes.forEmployee(s.person.id, 20);
    const names = await namesFor([s.person.id, ...notes.map((n) => n.managerId)]);
    return reply.code(200).send({
      name: nameOf(s.person),
      manager: s.manager ? { id: s.manager.id, name: nameOf(s.manager) } : null,
      blocked: s.blocked,
      summary: s.person.status === 'active' ? await summaryFor(s.person, new Date()) : null,
      follow_up_days: NOTE_DAYS,
      notes: notes.map((n) => viewOf(n, names)),
    });
  });

  app.post('/v1/admin/people/:employeeId/manager-notes', hr, async (req, reply) => {
    const caller = await userOf(req, reply);
    if (!caller) return reply;
    const body = sendBody.safeParse(req.body);
    if (!body.success) {
      return problem(
        reply,
        400,
        'validation',
        'body must be {topics: [activity|timings|breaks|missed, …], message} (10–2000 characters)',
      );
    }
    const s = await subject((req.params as { employeeId: string }).employeeId, caller);
    if (!s) return problem(reply, 404, 'not_found', 'no such employee');
    if (s.blocked || !s.manager) {
      const why: Record<Exclude<Blocked, null>, string> = {
        inactive: 'this person is deactivated',
        no_manager: 'this person has no manager',
        self: "you can't send a note about yourself",
        own_manager: "you are this person's manager",
      };
      const code = s.blocked ?? 'no_manager';
      return problem(reply, 409, code, why[code]);
    }
    if (!opts.send) {
      return problem(reply, 503, 'mail_not_configured', "CloudPunch's mailbox isn't set up");
    }
    const manager = s.manager;
    if (!manager.workEmail) return problem(reply, 409, 'no_email', 'the manager has no work email');
    const at = new Date();
    const summary = await summaryFor(s.person, at);
    const followUpOn = shiftDate(dateIn(at.getTime(), INDIA_TZ), NOTE_DAYS);
    const mail = noteMail({
      person: nameOf(s.person),
      personFirst: firstName(s.person),
      manager: nameOf(manager),
      managerFirst: firstName(manager),
      sender: caller.displayName,
      topics: body.data.topics,
      message: body.data.message,
      summary,
      followUpOn,
      siteUrl: opts.siteUrl,
    });
    const cc =
      caller.workEmail && caller.workEmail.toLowerCase() !== manager.workEmail.toLowerCase()
        ? [caller.workEmail]
        : [];
    await opts.send({ to: [manager.workEmail], cc, ...mail });
    const note = await db.managerNotes.create({
      employeeId: s.person.id,
      managerId: manager.id,
      sentBy: caller.id,
      topics: body.data.topics,
      message: body.data.message,
      summary,
      sentAt: at,
      followUpOn,
      correlationId: randomUUID(),
    });
    req.log.info({ note: note.id }, 'manager note: sent');
    const names = new Map([
      [s.person.id, nameOf(s.person)],
      [manager.id, nameOf(manager)],
    ]);
    return reply.code(201).send(viewOf(note, names));
  });

  // The manager's side (§3): notes addressed to the caller only.
  app.get('/v1/team/manager-notes', { preHandler: [requireAuth] }, async (req, reply) => {
    const caller = await userOf(req, reply);
    if (!caller) return reply;
    if (!caller.employeeId) return reply.code(200).send({ notes: [] });
    const since = new Date(Date.now() - SHOWN_DAYS * 86_400_000);
    const notes = await db.managerNotes.forManager(caller.employeeId, since);
    const names = await namesFor(notes.flatMap((n) => [n.employeeId, n.managerId]));
    return reply.code(200).send({ notes: notes.map((n) => viewOf(n, names)) });
  });

  app.post('/v1/team/manager-notes/:id/seen', { preHandler: [requireAuth] }, async (req, reply) => {
    const caller = await userOf(req, reply);
    if (!caller) return reply;
    const { id } = req.params as { id: string };
    const note = UUID.test(id) ? await db.managerNotes.find(id) : null;
    if (!note || !caller.employeeId || note.managerId !== caller.employeeId) {
      return problem(reply, 404, 'not_found', 'no such note for you');
    }
    const at = new Date();
    const changed = await db.managerNotes.markSeen(note.id, caller.id, at, randomUUID());
    const seen = changed ? at : (note.seenAt ?? at);
    return reply.code(200).send({ seen_at: seen.toISOString(), changed });
  });
};

export const managerNoteRoutes = fp(managerNoteRoutesImpl, {
  name: 'cloudpunch-manager-notes',
  fastify: '4.x',
});
export default managerNoteRoutes;
