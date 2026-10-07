import { randomUUID } from 'node:crypto';
import { Capability, capabilitiesForRoles } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { requireCapability } from '../auth/require.js';
import {
  CorrectionDecisionConflictError,
  type AppUser,
  type CorrectionDecisionKind,
  type CorrectionWithDecisions,
  type DbRepositories,
  type Employee,
} from '../db/index.js';
import { localDate } from '../days/build.js';
import { CORRECTION_KINDS, correctionStatus } from '../days/corrections.js';
import { LOOKBACK_DAYS, correctionView } from '../days/service.js';
import { nameOf } from '../team/service.js';

/**
 * Time corrections (ADR-0030 §3):
 *
 *   POST /v1/me/corrections                   ask to correct your own time
 *   POST /v1/team/:employeeId/corrections     a manager corrects a direct report (endorsed)
 *   GET  /v1/corrections/queue                what waits on the caller
 *   POST /v1/corrections/:id/decision         { decision: endorse | approve | reject | withdraw, note? }
 *
 * Employee asks → their manager endorses → an Administrator approves.
 * No manager in CloudPunch: straight to an Administrator. Nobody
 * decides on their own correction or their own time. HR has no part
 * for now. Each request and decision is written to audit_log with it.
 */

export interface CorrectionRoutesOptions {
  db: DbRepositories;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ADR-0030 §5. */
const MAX_SPAN_MS = 16 * 3_600_000;
const DAY_MS = 86_400_000;
/** Clock skew allowed on "never in the future". */
const SKEW_MS = 60_000;

/** ISO 8601 with an explicit offset, so the person's zone is known. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?([+-]\d{2}:\d{2}|Z)$/;

const requestBody = z
  .object({
    from: z.string().regex(ISO_WITH_OFFSET),
    to: z.string().regex(ISO_WITH_OFFSET),
    tz_iana: z.string().min(1).max(64),
    kind: z.enum(CORRECTION_KINDS),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const decisionBody = z
  .object({
    decision: z.enum(['endorse', 'approve', 'reject', 'withdraw']),
    note: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

const PAST: Record<string, CorrectionDecisionKind> = {
  endorse: 'endorsed',
  approve: 'approved',
  reject: 'rejected',
  withdraw: 'withdrawn',
};

function problem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/problem+json').send({ code, message });
}

/** Minutes east of UTC written in an ISO string (`Z` is 0). */
function offsetOf(iso: string): number {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Who may do what with a correction, at its current status. */
export function allowed(
  c: CorrectionWithDecisions,
  subject: Employee,
  caller: AppUser,
  isApprover: boolean,
): Record<'endorse' | 'approve' | 'reject' | 'withdraw', boolean> {
  const status = correctionStatus(c);
  const open = status === 'requested' || status === 'endorsed';
  const isManager = caller.employeeId !== null && subject.reportingManagerId === caller.employeeId;
  const involved =
    c.requestedByUserId === caller.id ||
    c.decisions.some((d) => d.decision === 'endorsed' && d.decidedByUserId === caller.id) ||
    caller.employeeId === subject.id;
  // No manager: the request goes straight to an Administrator.
  const atApproval =
    status === 'endorsed' || (status === 'requested' && !subject.reportingManagerId);
  const canEndorse = status === 'requested' && isManager && caller.employeeId !== subject.id;
  const canApprove = atApproval && isApprover && !involved;
  return {
    endorse: canEndorse,
    approve: canApprove,
    reject: open && (canEndorse || canApprove),
    withdraw: open && c.requestedByUserId === caller.id,
  };
}

const correctionRoutesImpl: FastifyPluginAsync<CorrectionRoutesOptions> = async (app, opts) => {
  const db = opts.db;

  async function caller(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ user: AppUser; approver: boolean } | null> {
    const user = req.auth ? await db.users.findByEntraObjectId(req.auth.oid) : null;
    if (!user || !req.auth) {
      await problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
      return null;
    }
    const caps = new Set<string>(capabilitiesForRoles(req.auth.roles));
    return { user, approver: caps.has(Capability.AdminCorrectionApprove) };
  }

  /** Validate and store a correction; the reply is sent either way. */
  async function request(
    reply: FastifyReply,
    body: unknown,
    subject: Employee,
    by: AppUser,
    endorse: boolean,
  ) {
    const parsed = requestBody.safeParse(body);
    if (!parsed.success) {
      return problem(reply, 400, 'validation', parsed.error.issues[0]?.message ?? 'invalid body');
    }
    const b = parsed.data;
    const from = new Date(b.from);
    const to = new Date(b.to);
    const now = Date.now();
    if (!validZone(b.tz_iana)) return problem(reply, 400, 'validation', 'unknown time zone');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      return problem(reply, 400, 'validation', 'to must be after from');
    }
    if (to.getTime() - from.getTime() > MAX_SPAN_MS) {
      return problem(reply, 400, 'too_long', 'a correction covers at most 16 hours');
    }
    if (to.getTime() > now + SKEW_MS) {
      return problem(reply, 400, 'in_future', 'a correction cannot reach into the future');
    }
    if (from.getTime() < now - (LOOKBACK_DAYS + 1) * DAY_MS) {
      return problem(reply, 400, 'too_old', `only the last ${LOOKBACK_DAYS} days can be corrected`);
    }
    const nearby = await db.corrections.listForEmployee(subject.id, from, to);
    if (nearby.some((c) => ['requested', 'endorsed'].includes(correctionStatus(c)))) {
      return problem(
        reply,
        409,
        'overlaps_pending',
        'a pending correction already covers part of this time',
      );
    }
    const c = await db.corrections.request({
      employeeId: subject.id,
      fromAt: from,
      toAt: to,
      tzIana: b.tz_iana,
      utcOffsetMinutes: offsetOf(b.from),
      kind: b.kind,
      reason: b.reason,
      requestedByUserId: by.id,
      endorse,
      correlationId: randomUUID(),
      at: new Date(),
    });
    return reply.code(201).send({ correction: await correctionView(db, c, new Map()) });
  }

  app.post(
    '/v1/me/corrections',
    { preHandler: [requireCapability([Capability.SelfCorrectionRequest])] },
    async (req, reply) => {
      const c = await caller(req, reply);
      if (!c) return reply;
      const me = c.user.employeeId ? await db.employees.findById(c.user.employeeId) : null;
      if (!me || me.status !== 'active') {
        return problem(reply, 403, 'no_employee', 'your account has no active employee record');
      }
      return request(reply, req.body, me, c.user, false);
    },
  );

  app.post(
    '/v1/team/:employeeId/corrections',
    { preHandler: [requireCapability([Capability.TeamCorrectionReview])] },
    async (req, reply) => {
      const c = await caller(req, reply);
      if (!c) return reply;
      const { employeeId } = req.params as { employeeId: string };
      const e = UUID.test(employeeId) ? await db.employees.findById(employeeId) : null;
      // Direct reports only (ADR-0030 §3; HR has no part), else 404.
      if (
        !e ||
        e.status !== 'active' ||
        !c.user.employeeId ||
        e.reportingManagerId !== c.user.employeeId
      ) {
        return problem(reply, 404, 'not_found', 'no such person on your team');
      }
      return request(reply, req.body, e, c.user, true);
    },
  );

  app.get('/v1/corrections/queue', async (req, reply) => {
    if (!req.auth) return problem(reply, 401, 'unauthorized', 'authentication required');
    const c = await caller(req, reply);
    if (!c) return reply;
    const names = new Map<string, string>();
    const toEndorse = [];
    const toApprove = [];
    for (const corr of await db.corrections.listOpen()) {
      const subject = await db.employees.findById(corr.employeeId);
      if (!subject) continue;
      const can = allowed(corr, subject, c.user, c.approver);
      if (!can.endorse && !can.approve) continue;
      const item = {
        employee_id: subject.id,
        name: nameOf(subject),
        date: localDate(corr.fromAt, corr.utcOffsetMinutes),
        correction: await correctionView(db, corr, names),
      };
      if (can.approve) toApprove.push(item);
      else toEndorse.push(item);
    }
    return reply.code(200).send({ to_endorse: toEndorse, to_approve: toApprove });
  });

  app.post('/v1/corrections/:id/decision', async (req, reply) => {
    if (!req.auth) return problem(reply, 401, 'unauthorized', 'authentication required');
    const c = await caller(req, reply);
    if (!c) return reply;
    const { id } = req.params as { id: string };
    const parsed = decisionBody.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, 400, 'validation', parsed.error.issues[0]?.message ?? 'invalid body');
    }
    const corr = UUID.test(id) ? await db.corrections.findById(id) : null;
    const subject = corr ? await db.employees.findById(corr.employeeId) : null;
    // Only someone with a part in it learns it exists (invariant 5).
    const can = corr && subject ? allowed(corr, subject, c.user, c.approver) : null;
    const visible =
      corr &&
      subject &&
      (c.approver ||
        corr.requestedByUserId === c.user.id ||
        c.user.employeeId === subject.id ||
        subject.reportingManagerId === c.user.employeeId);
    if (!corr || !subject || !can || !visible) {
      return problem(reply, 404, 'not_found', 'no such correction');
    }
    const { decision, note } = parsed.data;
    if (!can[decision]) {
      return problem(
        reply,
        409,
        'not_allowed',
        `you can't ${decision} this correction (it is ${correctionStatus(corr)})`,
      );
    }
    try {
      await db.corrections.decide({
        correctionId: corr.id,
        employeeId: subject.id,
        decision: PAST[decision] ?? 'rejected',
        decidedByUserId: c.user.id,
        note: note ?? null,
        correlationId: randomUUID(),
        at: new Date(),
      });
    } catch (e) {
      if (e instanceof CorrectionDecisionConflictError) {
        return problem(reply, 409, 'already_decided', 'someone decided this correction already');
      }
      throw e;
    }
    const after = await db.corrections.findById(corr.id);
    return reply
      .code(200)
      .send({ correction: after ? await correctionView(db, after, new Map()) : null });
  });
};

export const correctionRoutes = fp(correctionRoutesImpl, {
  name: 'cloudpunch-corrections',
  fastify: '4.x',
});
export default correctionRoutes;
