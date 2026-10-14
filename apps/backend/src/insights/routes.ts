import { randomUUID } from 'node:crypto';
import { Capability, capabilitiesForRoles } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import type { ShiftMail } from '../alerts/mail.js';
import { requireAuth, requireCapability } from '../auth/require.js';
import type { AppUser, DbRepositories, Employee, Insight, InsightEvent } from '../db/index.js';
import { INDIA_TZ, rangeRows } from '../reports/day.js';
import { dateIn, shiftDate } from '../shifts/model.js';
import { nameOf, peopleIn, scopeFor, type TeamScope } from '../team/service.js';
import { FOLLOW_UP_DAYS, type Evidence } from './job.js';
import { draftNudge, headlineOf, stripOf, WINDOW_DAYS, type InsightKind } from './rules.js';

/**
 * Actionable insights (ADR-0047):
 *
 *   GET  /v1/insights?status=live|closed   findings in the caller's scope
 *   GET  /v1/insights/:id/history          what happened to one
 *   POST /v1/insights/:id/nudge  {message} email the person (manager copied)
 *   POST /v1/insights/:id/dismiss {reason}
 *   GET  /v1/me/insights                   my last 14 days and findings
 *   POST /v1/me/insights/:id/context {text} my side of it
 *
 * Scope follows Team (invariant 5): Administrators and HR everyone, a
 * Manager their direct reports, an Employee only themselves (§4).
 */

export interface InsightRoutesOptions {
  db: DbRepositories;
  /** CloudPunch's mailbox; without it a nudge is refused (503). */
  send?: ((m: ShiftMail) => Promise<void>) | null;
  siteUrl: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nudgeBody = z.object({ message: z.string().trim().min(10).max(2000) }).strict();
const dismissBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const contextBody = z.object({ text: z.string().trim().min(3).max(1000) }).strict();

const SUBJECT: Record<InsightKind, string> = {
  late_starts: 'Your start times in the last two weeks',
  missed_starts: 'Shift days without a clock-in',
  short_days: 'Your hours against your shift',
  long_idle: 'Idle time in CloudPunch',
  breaks_over: 'Your breaks',
  forgets_clock_out: 'Clocking out at the end of the day',
  long_days: 'Your long days',
};

function problem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/problem+json').send({ code, message });
}

const firstName = (e: Employee): string => e.givenName || nameOf(e).split(' ')[0] || nameOf(e);

export interface InsightView {
  id: string;
  employee_id: string;
  name: string;
  manager_name: string | null;
  kind: string;
  severity: string;
  status: string;
  headline: string;
  evidence: unknown;
  follow_up_on: string | null;
  no_change: boolean;
  opened_at: string;
  updated_at: string;
  /** The nudge as drafted, to edit. */
  draft: string;
  /** The latest step, for the list. */
  last: { action: string; at: string; by: string | null; note: string | null } | null;
}

function viewOf(
  i: Insight,
  people: ReadonlyMap<string, Employee>,
  last: InsightEvent | undefined,
): InsightView {
  const e = people.get(i.employeeId);
  const manager = e?.reportingManagerId ? people.get(e.reportingManagerId) : undefined;
  const ev = (i.evidence ?? {}) as Partial<Evidence>;
  const kind = i.kind as InsightKind;
  return {
    id: i.id,
    employee_id: i.employeeId,
    name: e ? nameOf(e) : 'Someone no longer listed',
    manager_name: manager ? nameOf(manager) : null,
    kind: i.kind,
    severity: i.severity,
    status: i.status,
    headline: headlineOf({ kind, count: ev.count ?? 0 }),
    evidence: i.evidence,
    follow_up_on: i.followUpOn,
    no_change: i.noChange,
    opened_at: i.openedAt.toISOString(),
    updated_at: i.updatedAt.toISOString(),
    draft: e ? draftNudge(firstName(e), { kind, dates: ev.dates ?? [] }) : '',
    last: last
      ? { action: last.action, at: last.at.toISOString(), by: last.actorName, note: last.note }
      : null,
  };
}

const insightRoutesImpl: FastifyPluginAsync<InsightRoutesOptions> = async (app, opts) => {
  const db = opts.db;

  /** The caller, and whose findings they may see. */
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
    const scope: TeamScope = caps.has(Capability.HrEmployeeRead)
      ? { kind: 'all' }
      : scopeFor(caps, user.employeeId);
    return { user, scope };
  }

  /** The finding, if in the caller's scope; otherwise 404. */
  async function inScope(
    reply: FastifyReply,
    scope: TeamScope,
    id: string,
  ): Promise<{ insight: Insight; people: Map<string, Employee> } | null> {
    const insight = UUID.test(id) ? await db.insights.find(id) : null;
    const people = new Map((await peopleIn(db, scope)).map((p) => [p.id, p]));
    if (!insight || !people.has(insight.employeeId)) {
      await problem(reply, 404, 'not_found', 'no such finding on your team');
      return null;
    }
    // Managers' names for the view.
    for (const p of await db.employees.listActive()) if (!people.has(p.id)) people.set(p.id, p);
    return { insight, people };
  }

  const team = {
    preHandler: [requireCapability([Capability.TeamTimelineRead, Capability.HrEmployeeRead])],
  };

  app.get('/v1/insights', team, async (req, reply) => {
    const c = await caller(req, reply);
    if (!c) return reply;
    const status = (req.query as { status?: string }).status === 'closed' ? 'closed' : 'live';
    const mine = await peopleIn(db, c.scope);
    const ids = mine.map((p) => p.id);
    const rows = await db.insights.list(
      status === 'live' ? ['open', 'nudged'] : ['resolved', 'dismissed'],
      c.scope.kind === 'all' ? undefined : ids,
    );
    const shown = status === 'closed' ? rows.slice(0, 200) : rows;
    const history = await db.insights.historyOf(shown.map((r) => r.id));
    const lastOf = new Map<string, InsightEvent>();
    for (const h of history) lastOf.set(h.insightId, h);
    const people = new Map((await db.employees.listActive()).map((p) => [p.id, p]));
    await db.reports.auditView({
      actorUserId: c.user.id,
      report: 'insights',
      detail: { status, findings: String(shown.length) },
      correlationId: randomUUID(),
      at: new Date(),
    });
    return reply.code(200).send({
      status,
      insights: shown.map((r) => viewOf(r, people, lastOf.get(r.id))),
    });
  });

  app.get('/v1/insights/:id/history', team, async (req, reply) => {
    const c = await caller(req, reply);
    if (!c) return reply;
    const found = await inScope(reply, c.scope, (req.params as { id: string }).id);
    if (!found) return reply;
    const events = await db.insights.history(found.insight.id);
    return reply.code(200).send({
      events: events.map((e) => ({
        action: e.action,
        at: e.at.toISOString(),
        by: e.actorName,
        note: e.note,
        detail: e.detail,
      })),
    });
  });

  app.post('/v1/insights/:id/nudge', team, async (req, reply) => {
    const c = await caller(req, reply);
    if (!c) return reply;
    const body = nudgeBody.safeParse(req.body);
    if (!body.success)
      return problem(reply, 400, 'validation', 'body must be {message} (10–2000 characters)');
    const found = await inScope(reply, c.scope, (req.params as { id: string }).id);
    if (!found) return reply;
    const { insight, people } = found;
    if (insight.status !== 'open' && insight.status !== 'nudged') {
      return problem(reply, 409, 'closed', 'this finding is closed');
    }
    if (!opts.send)
      return problem(reply, 503, 'mail_not_configured', "CloudPunch's mailbox isn't set up");
    const person = people.get(insight.employeeId);
    if (!person?.workEmail) return problem(reply, 409, 'no_email', 'this person has no work email');
    const manager = person.reportingManagerId ? people.get(person.reportingManagerId) : undefined;
    const cc = [manager?.workEmail, c.user.workEmail]
      .filter((x): x is string => !!x && x.toLowerCase() !== person.workEmail.toLowerCase())
      .filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
    const at = new Date();
    const site = opts.siteUrl.replace(/\/$/, '');
    await opts.send({
      to: [person.workEmail],
      cc,
      subject: SUBJECT[insight.kind as InsightKind] ?? 'A note about your time',
      text: `${body.data.message}\n\n${c.user.displayName}\n\nYour last two weeks in CloudPunch: ${site}/app/?view=my-week`,
    });
    const today = dateIn(at.getTime(), INDIA_TZ);
    const saved = await db.insights.change(
      insight.id,
      { status: 'nudged', noChange: false, followUpOn: shiftDate(today, FOLLOW_UP_DAYS) },
      {
        action: 'nudged',
        actorUserId: c.user.id,
        note: body.data.message,
        detail: { to: person.workEmail, cc },
        at,
      },
    );
    req.log.info({ insight: insight.id }, 'insights: nudged');
    return reply.code(200).send({ status: saved.status, follow_up_on: saved.followUpOn });
  });

  app.post('/v1/insights/:id/dismiss', team, async (req, reply) => {
    const c = await caller(req, reply);
    if (!c) return reply;
    const body = dismissBody.safeParse(req.body);
    if (!body.success) return problem(reply, 400, 'validation', 'body must be {reason}');
    const found = await inScope(reply, c.scope, (req.params as { id: string }).id);
    if (!found) return reply;
    if (found.insight.status !== 'open' && found.insight.status !== 'nudged') {
      return problem(reply, 409, 'closed', 'this finding is closed');
    }
    const saved = await db.insights.change(
      found.insight.id,
      { status: 'dismissed', followUpOn: null },
      {
        action: 'dismissed',
        actorUserId: c.user.id,
        note: body.data.reason,
        detail: null,
        at: new Date(),
      },
    );
    return reply.code(200).send({ status: saved.status });
  });

  // My week (ADR-0047 §5): the caller's own days and findings only.
  app.get('/v1/me/insights', { preHandler: [requireAuth] }, async (req, reply) => {
    const user = req.auth ? await db.users.findByEntraObjectId(req.auth.oid) : null;
    const me = user?.employeeId ? await db.employees.findById(user.employeeId) : null;
    if (!me)
      return problem(reply, 403, 'no_employee_for_user', 'your account has no employee record');
    const now = new Date();
    const to = shiftDate(dateIn(now.getTime(), INDIA_TZ), -1);
    const from = shiftDate(to, -(WINDOW_DAYS - 1));
    const rows = await rangeRows(db, [me], from, to, now);
    const live = await db.insights.list(['open', 'nudged'], [me.id]);
    const closed = (await db.insights.list(['resolved', 'dismissed'], [me.id])).filter(
      (i) => now.getTime() - i.updatedAt.getTime() < 30 * 86_400_000,
    );
    const all = [...live, ...closed];
    const history = await db.insights.historyOf(all.map((i) => i.id));
    const worked = rows.filter((r) => r.status === 'worked' || r.status === 'late');
    const shiftDays = rows.filter(
      (r) => ['worked', 'late', 'not_clocked_in'].includes(r.status) && r.shift,
    );
    return reply.code(200).send({
      from,
      to,
      strip: stripOf(rows),
      totals: {
        on_time: rows.filter((r) => r.status === 'worked' && r.shift).length,
        shift_days: shiftDays.length,
        worked_ms: worked.reduce((s, r) => s + r.worked_ms, 0),
        scheduled_ms: shiftDays.reduce((s, r) => s + r.shift_ms, 0),
        idle_ms: worked.reduce((s, r) => s + r.idle_ms, 0),
      },
      findings: all.map((i) => {
        const ev = (i.evidence ?? {}) as Partial<Evidence>;
        const mine = history.filter((h) => h.insightId === i.id);
        return {
          id: i.id,
          kind: i.kind,
          status: i.status,
          headline: headlineOf({ kind: i.kind as InsightKind, count: ev.count ?? 0 }),
          dates: ev.dates ?? [],
          // What was said to them, and what they said; never internal notes.
          nudges: mine
            .filter((h) => h.action === 'nudged')
            .map((h) => ({ at: h.at.toISOString(), by: h.actorName, message: h.note })),
          context: mine
            .filter((h) => h.action === 'explained')
            .map((h) => ({ at: h.at.toISOString(), text: h.note })),
        };
      }),
    });
  });

  app.post('/v1/me/insights/:id/context', { preHandler: [requireAuth] }, async (req, reply) => {
    const user = req.auth ? await db.users.findByEntraObjectId(req.auth.oid) : null;
    if (!user?.employeeId) return problem(reply, 403, 'no_employee_for_user', 'no employee record');
    const body = contextBody.safeParse(req.body);
    if (!body.success)
      return problem(reply, 400, 'validation', 'body must be {text} (3–1000 characters)');
    const { id } = req.params as { id: string };
    const insight = UUID.test(id) ? await db.insights.find(id) : null;
    if (!insight || insight.employeeId !== user.employeeId) {
      return problem(reply, 404, 'not_found', 'no such finding');
    }
    await db.insights.note(insight.id, {
      action: 'explained',
      actorUserId: user.id,
      note: body.data.text,
      detail: null,
      at: new Date(),
    });
    return reply.code(200).send({ ok: true });
  });
};

export const insightRoutes = fp(insightRoutesImpl, { name: 'cloudpunch-insights', fastify: '4.x' });
export default insightRoutes;
