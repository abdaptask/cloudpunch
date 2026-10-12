import { randomUUID } from 'node:crypto';
import { ALL_APP_ROLES, AppRole, Capability, hasCapability, isAppRole } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { requireCapability } from '../auth/require.js';
import type { DbRepositories } from '../db/index.js';
import { activeDeviceOf, lastEventAt } from '../devices/active.js';
import { MAX_BULK, inTurn, replay, requestHash } from './bulk.js';
import { GraphError, type Graph, type RoleAssignment } from './graph.js';
import { OboError } from './obo.js';
import { HR_ASSIGNABLE, checkRoleChange, diffRoles } from './rules.js';
import { welcomeMessage, type WelcomeMessage, type WelcomeSettings } from './welcome.js';

/**
 * People (ADR-0020): Administrators and HR find someone in the company
 * directory and set their CloudPunch roles, without the Entra portal.
 *
 *   GET /v1/admin/people                everyone with a CloudPunch role
 *   GET /v1/admin/people/search?q=      directory search (2+ characters)
 *   PUT /v1/admin/people/:oid/roles     {roles, reason?}: set exactly these
 *
 * Bulk (ADR-0038 §5), up to 200 people, one Graph call per person, so
 * each person's answer is listed (done, already, or why not):
 *
 *   POST /v1/admin/people/bulk/roles    {idempotency_key, oids, add, remove, reason?}
 *   POST /v1/admin/people/bulk/welcome  {idempotency_key, oids, note?}
 *
 * One machine at a time (ADR-0028 §4), Administrators only, by employee id:
 *
 *   GET  /v1/people/:employeeId/active-device            the open session's machine, or 204
 *   POST /v1/people/:employeeId/active-device/sign-out   {device_id}: sign that machine out
 *
 * Roles stay in Entra (invariant 6): every change is an Entra app-role
 * assignment, made with the caller's own delegated rights (OBO). Giving
 * someone Employee also creates their employee record. Every change is
 * audited.
 */

export interface PeopleRoutesOptions {
  db: DbRepositories;
  /** Graph as the caller, from their bearer token; null when not configured. */
  graphFor: ((userToken: string) => Promise<Graph>) | null;
  /** Welcome emails (ADR-0021); null when not configured. */
  welcome?: {
    settings: WelcomeSettings;
    /** Newest published version, for the email. */
    version: () => Promise<string | null>;
    send: (m: WelcomeMessage) => Promise<void>;
  } | null;
}

/** No second welcome email to the same person within this long. */
const WELCOME_GAP_MS = 10 * 60_000;

const READ = [Capability.AdminEmployeeAssignRole, Capability.HrEmployeeWrite];
/** Roles that come with an employee record (ADR-0020, amended 2026-10-08). */
const RECORD_ROLES: readonly AppRole[] = [AppRole.Employee, AppRole.Manager, AppRole.HR];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Signing someone out of a machine (ADR-0028 §4): Administrator only. */
const SIGN_OUT = [Capability.AdminDeviceRevoke];

const signOutBody = z.object({ device_id: z.string().uuid() }).strict();

const putBody = z
  .object({
    roles: z.array(z.string()).max(ALL_APP_ROLES.length),
    reason: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

const bulkIds = z.array(z.string().uuid()).min(1).max(MAX_BULK);
const bulkRolesBody = z
  .object({
    idempotency_key: z.string().uuid(),
    oids: bulkIds,
    add: z.array(z.string()).max(ALL_APP_ROLES.length),
    remove: z.array(z.string()).max(ALL_APP_ROLES.length),
    reason: z.string().trim().max(500).optional().nullable(),
  })
  .strict();
const bulkWelcomeBody = z
  .object({
    idempotency_key: z.string().uuid(),
    oids: bulkIds,
    note: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

/** Graph calls at once in a bulk request: quick enough, gentle on Graph. */
const BULK_PARALLEL = 4;

/** One person's answer in a bulk request. */
interface BulkOutcome {
  oid: string;
  outcome: 'done' | 'already' | 'sent' | 'refused' | 'failed';
  code?: string;
  unassigned_reports?: { id: string; name: string }[];
}

/** A Graph failure for one person, as a code (the others go on). */
function graphCode(err: unknown): string {
  if (err instanceof GraphError) {
    if (err.status === 403) return 'directory_forbidden';
    if (err.status === 404) return 'unknown_person';
    return 'directory_error';
  }
  throw err;
}

function problem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/problem+json').send({ code, message });
}

function bearer(req: FastifyRequest): string {
  return (req.headers.authorization ?? '').slice(7).trim();
}

/** "Farheen Khanam" → given, family (for a directory entry without them). */
function splitName(name: string): [string, string] {
  const parts = name.trim().split(/\s+/);
  const given = parts.shift() ?? name;
  return [given, parts.join(' ') || given];
}

const peopleRoutesImpl: FastifyPluginAsync<PeopleRoutesOptions> = async (app, opts) => {
  const { db, graphFor } = opts;
  const welcome = opts.welcome ?? null;

  /** Run `fn` with Graph as the caller, mapping failures to replies. */
  async function withGraph(
    req: FastifyRequest,
    reply: FastifyReply,
    fn: (g: Graph) => Promise<unknown>,
  ): Promise<unknown> {
    if (!graphFor) {
      return problem(reply, 503, 'people_not_configured', 'directory access is not set up');
    }
    try {
      return await fn(await graphFor(bearer(req)));
    } catch (err) {
      if (err instanceof OboError) {
        if (err.code === 'consent_required') {
          return problem(reply, 503, 'consent_required', 'Microsoft Graph consent is missing');
        }
        if (err.code === 'not_permitted') {
          return problem(reply, 403, 'directory_forbidden', 'the directory refused this sign-in');
        }
        return problem(reply, 503, 'directory_unavailable', err.message);
      }
      if (err instanceof GraphError) {
        req.log.warn({ graph: err.code, status: err.status }, 'people: graph call failed');
        if (err.status === 403) {
          return problem(
            reply,
            403,
            'directory_forbidden',
            'your directory rights do not allow this (are you an owner of the CloudPunch API app?)',
          );
        }
        if (err.status === 404) return problem(reply, 404, 'unknown_person', 'no such person');
        return problem(reply, 502, 'directory_error', err.code);
      }
      throw err;
    }
  }

  /**
   * Set exactly `wanted` for one person, already checked against the
   * rules. Records follow roles (ADR-0020 §4, amended): Employee,
   * Manager or HR come with an employee record (a reporting line links
   * two, and a manager may never install the app); with none of them
   * left, the record is turned off and drops out of Reporting lines and
   * Team, its history kept. Also on a save with no role change, which
   * fixes a record from before this rule.
   */
  async function applyRoles(
    g: Graph,
    i: {
      oid: string;
      mine: readonly RoleAssignment[];
      current: readonly AppRole[];
      wanted: readonly AppRole[];
      actorUserId: string;
      reason: string | null;
      correlationId: string;
      at: Date;
    },
  ): Promise<{ changed: boolean; unassigned: { id: string; name: string }[] } | 'unknown_person'> {
    const { oid, actorUserId, reason, correlationId, at } = i;
    const diff = diffRoles(i.current, i.wanted);
    const needsRecord = i.wanted.some((r) => RECORD_ROLES.includes(r));
    const record = await db.employees.findByEntraObjectId(oid);
    if (needsRecord && !record) {
      const user = await g.getUser(oid);
      if (!user) return 'unknown_person';
      const [given, family] =
        user.givenName && user.surname ? [user.givenName, user.surname] : splitName(user.name);
      await db.people.provision({ oid, email: user.email, givenName: given, familyName: family });
    }
    const setRecord = async (active: boolean): Promise<{ id: string; name: string }[]> =>
      record
        ? (
            await db.people.setRecordActive({
              employeeId: record.id,
              active,
              actorUserId,
              reason,
              correlationId,
              at,
            })
          ).unassigned
        : [];
    if (needsRecord) await setRecord(true);

    const changed = diff.add.length > 0 || diff.remove.length > 0;
    if (changed) {
      for (const role of diff.add) await g.assign(oid, role);
      for (const role of diff.remove) {
        for (const a of i.mine.filter((x) => x.role === role)) await g.unassign(a.id);
      }
      await db.people.auditRoleChange({
        actorUserId,
        targetOid: oid,
        previousRoles: [...i.current],
        newRoles: [...i.wanted],
        reason,
        correlationId,
        at,
      });
      // Alert recipients follow at once (ADR-0037), not at their next sign-in.
      await db.roles.note(oid, [...i.wanted], 'people', at);
    }
    // Turned off only once Entra has the roles removed.
    const unassigned = needsRecord ? [] : await setRecord(false);
    return { changed, unassigned };
  }

  app.get('/v1/admin/people', { preHandler: [requireCapability(READ)] }, async (req, reply) =>
    withGraph(req, reply, async (g) => {
      const byOid = new Map<string, { oid: string; name: string; roles: AppRole[] }>();
      for (const a of await g.listAssignments()) {
        const p = byOid.get(a.oid) ?? { oid: a.oid, name: a.name, roles: [] };
        if (!p.roles.includes(a.role)) p.roles.push(a.role);
        byOid.set(a.oid, p);
      }
      const people = await Promise.all(
        [...byOid.values()].map(async (p) => ({
          ...p,
          roles: ALL_APP_ROLES.filter((r) => p.roles.includes(r)),
          has_employee_record: (await db.employees.findByEntraObjectId(p.oid)) !== null,
        })),
      );
      people.sort((a, b) => a.name.localeCompare(b.name));
      return reply.code(200).send({ people });
    }),
  );

  app.get(
    '/v1/admin/people/search',
    { preHandler: [requireCapability(READ)] },
    async (req, reply) => {
      const raw = (req.query as { q?: unknown }).q;
      const q = typeof raw === 'string' ? raw.trim() : '';
      if (q.length < 2 || q.length > 100) {
        return problem(reply, 400, 'validation', 'q must be 2–100 characters');
      }
      return withGraph(req, reply, async (g) =>
        reply.code(200).send({ users: await g.searchUsers(q) }),
      );
    },
  );

  /** The welcome email for `oid`, built from their directory entry. */
  async function draft(
    req: FastifyRequest,
    reply: FastifyReply,
    note: string | null,
  ): Promise<WelcomeMessage | FastifyReply> {
    const oid = String((req.params as { oid?: string }).oid ?? '').toLowerCase();
    if (!UUID.test(oid)) return problem(reply, 400, 'validation', 'oid must be a UUID');
    if (!welcome) {
      return problem(reply, 503, 'welcome_not_configured', 'welcome emails are not set up');
    }
    let message: WelcomeMessage | null = null;
    const answered = await withGraph(req, reply, async (g) => {
      const m = await welcomeFor(g, oid, note);
      if (m === 'unknown_person') {
        return problem(reply, 404, 'unknown_person', 'no such person in the directory');
      }
      if (m === 'no_email') {
        return problem(reply, 400, 'no_email', 'this person has no email address');
      }
      message = m;
      return null;
    });
    return message ?? (answered as FastifyReply);
  }

  /** The welcome email for `oid` from their directory entry. */
  async function welcomeFor(
    g: Graph,
    oid: string,
    note: string | null,
  ): Promise<WelcomeMessage | 'unknown_person' | 'no_email'> {
    if (!welcome) throw new Error('welcome emails are not set up');
    const user = await g.getUser(oid);
    if (!user) return 'unknown_person';
    if (!user.email) return 'no_email';
    return welcomeMessage(welcome.settings, {
      firstName: user.givenName ?? splitName(user.name)[0],
      to: user.email,
      version: await welcome.version(),
      note,
    });
  }

  /** The caller and their CloudPunch user, or null with a reply sent. */
  async function actorOf(req: FastifyRequest, reply: FastifyReply) {
    const auth = req.auth;
    if (!auth) {
      await problem(reply, 401, 'unauthorized', 'authentication required');
      return null;
    }
    const actor = await db.users.findByEntraObjectId(auth.oid);
    if (!actor) {
      await problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
      return null;
    }
    return { auth, actor };
  }

  app.get(
    '/v1/admin/people/:oid/welcome',
    { preHandler: [requireCapability(READ)] },
    async (req, reply) => {
      const m = await draft(req, reply, null);
      if (!('html' in m)) return m;
      return reply.code(200).send(m);
    },
  );

  app.post(
    '/v1/admin/people/:oid/welcome',
    { preHandler: [requireCapability(READ)] },
    async (req, reply) => {
      const body = z
        .object({ note: z.string().trim().max(500).optional().nullable() })
        .strict()
        .safeParse(req.body ?? {});
      if (!body.success) return problem(reply, 400, 'validation', 'body must be {note?}');
      const auth = req.auth;
      if (!auth) return problem(reply, 401, 'unauthorized', 'authentication required');
      const actor = await db.users.findByEntraObjectId(auth.oid);
      if (!actor)
        return problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
      const oid = String((req.params as { oid?: string }).oid ?? '').toLowerCase();
      // From the audit log, so it holds across restarts and servers.
      const last = UUID.test(oid) ? await db.people.lastWelcomeAt(oid) : null;
      if (last && Date.now() - last.getTime() < WELCOME_GAP_MS) {
        return problem(reply, 429, 'welcome_recently_sent', 'a welcome email was just sent');
      }
      const m = await draft(req, reply, body.data.note?.trim() || null);
      if (!('html' in m) || !welcome) return m;
      try {
        await welcome.send(m);
      } catch (err) {
        const status = (err as { status?: number }).status ?? 0;
        req.log.warn({ status, code: (err as { code?: string }).code }, 'welcome: send failed');
        return problem(
          reply,
          status === 403 || status === 401 ? 503 : 502,
          status === 403 || status === 401 ? 'welcome_not_permitted' : 'welcome_send_failed',
          'the email could not be sent',
        );
      }
      await db.people.auditWelcome({
        actorUserId: actor.id,
        targetOid: oid,
        to: m.to,
        cc: m.cc,
        correlationId: randomUUID(),
        at: new Date(),
      });
      return reply.code(200).send({ sent: true, to: m.to, cc: m.cc });
    },
  );

  app.put(
    '/v1/admin/people/:oid/roles',
    { preHandler: [requireCapability(READ)] },
    async (req, reply) => {
      const oid = String((req.params as { oid?: string }).oid ?? '').toLowerCase();
      if (!UUID.test(oid)) return problem(reply, 400, 'validation', 'oid must be a UUID');
      const body = putBody.safeParse(req.body);
      if (!body.success || !body.data.roles.every(isAppRole)) {
        return problem(reply, 400, 'validation', 'body must be {roles: AppRole[], reason?}');
      }
      const wanted = ALL_APP_ROLES.filter((r) => body.data.roles.includes(r));
      const auth = req.auth;
      if (!auth) return problem(reply, 401, 'unauthorized', 'authentication required');
      const actor = await db.users.findByEntraObjectId(auth.oid);
      if (!actor)
        return problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');

      return withGraph(req, reply, async (g) => {
        const all = await g.listAssignments();
        const mine = all.filter((a) => a.oid === oid);
        const current = ALL_APP_ROLES.filter((r) => mine.some((a) => a.role === r));
        const diff = diffRoles(current, wanted);
        const refusal = checkRoleChange({
          callerRoles: auth.roles,
          callerOid: auth.oid,
          targetOid: oid,
          diff,
          administrators: [
            ...new Set(all.filter((a) => a.role === AppRole.Administrator).map((a) => a.oid)),
          ],
        });
        if (refusal) {
          const text: Record<typeof refusal, string> = {
            not_allowed_for_role: 'HR can give or remove Employee and Manager only',
            cannot_remove_own_admin: "you can't remove your own Administrator role",
            last_administrator: 'CloudPunch needs at least one Administrator',
          };
          return problem(reply, 403, refusal, text[refusal]);
        }
        const done = await applyRoles(g, {
          oid,
          mine,
          current,
          wanted,
          actorUserId: actor.id,
          reason: body.data.reason?.trim() || null,
          correlationId: randomUUID(),
          at: new Date(),
        });
        if (done === 'unknown_person') {
          return problem(reply, 404, 'unknown_person', 'no such person in the directory');
        }
        return reply.code(200).send({
          oid,
          roles: done.changed ? wanted : current,
          changed: done.changed,
          ...(done.unassigned.length > 0 ? { unassigned_reports: done.unassigned } : {}),
        });
      });
    },
  );

  // Bulk roles (ADR-0038 §5): add or remove roles for many people, one
  // Graph call each, so not all or nothing: each person's answer is
  // listed. The rules for one person still hold for each; the last
  // Administrator is checked against the whole batch.
  app.post(
    '/v1/admin/people/bulk/roles',
    { preHandler: [requireCapability(READ)] },
    async (req, reply) => {
      const body = bulkRolesBody.safeParse(req.body);
      const add = body.success ? body.data.add : [];
      const remove = body.success ? body.data.remove : [];
      if (
        !body.success ||
        ![...add, ...remove].every(isAppRole) ||
        add.length + remove.length === 0 ||
        add.some((r) => remove.includes(r))
      ) {
        return problem(
          reply,
          400,
          'validation',
          `body must be {idempotency_key, oids (1–${MAX_BULK}), add, remove, reason?}: roles to add or remove, not both`,
        );
      }
      const who = await actorOf(req, reply);
      if (!who) return reply;
      const { auth, actor } = who;
      const key = body.data.idempotency_key.toLowerCase();
      const hash = requestHash('roles', body.data);
      if (await replay(db, reply, actor.id, key, 'roles', hash)) return reply;

      const adding = ALL_APP_ROLES.filter((r) => add.includes(r));
      const removing = ALL_APP_ROLES.filter((r) => remove.includes(r));
      const touched = [...adding, ...removing];
      if (
        !hasCapability(auth.roles, Capability.AdminEmployeeAssignRole) &&
        touched.some((r) => !HR_ASSIGNABLE.includes(r))
      ) {
        return problem(
          reply,
          403,
          'not_allowed_for_role',
          'HR can give or remove Employee and Manager only',
        );
      }
      const oids = [...new Set(body.data.oids.map((o) => o.toLowerCase()))];

      return withGraph(req, reply, async (g) => {
        const all = await g.listAssignments();
        const admins = [
          ...new Set(all.filter((a) => a.role === AppRole.Administrator).map((a) => a.oid)),
        ];
        // The caller keeps theirs (refused below), so counts as left.
        if (
          removing.includes(AppRole.Administrator) &&
          admins.every((o) => oids.includes(o) && o !== auth.oid)
        ) {
          return problem(
            reply,
            403,
            'last_administrator',
            'CloudPunch needs at least one Administrator',
          );
        }
        const reason = body.data.reason?.trim() || null;
        const correlationId = randomUUID();
        const at = new Date();
        const results = await inTurn(oids, BULK_PARALLEL, async (oid): Promise<BulkOutcome> => {
          const mine = all.filter((a) => a.oid === oid);
          const current = ALL_APP_ROLES.filter((r) => mine.some((a) => a.role === r));
          const wanted = ALL_APP_ROLES.filter(
            (r) => (current.includes(r) || adding.includes(r)) && !removing.includes(r),
          );
          const refusal = checkRoleChange({
            callerRoles: auth.roles,
            callerOid: auth.oid,
            targetOid: oid,
            diff: diffRoles(current, wanted),
            administrators: admins,
          });
          if (refusal) return { oid, outcome: 'refused', code: refusal };
          try {
            const done = await applyRoles(g, {
              oid,
              mine,
              current,
              wanted,
              actorUserId: actor.id,
              reason,
              correlationId,
              at,
            });
            if (done === 'unknown_person') return { oid, outcome: 'failed', code: done };
            return {
              oid,
              outcome: done.changed ? 'done' : 'already',
              ...(done.unassigned.length > 0 ? { unassigned_reports: done.unassigned } : {}),
            };
          } catch (err) {
            req.log.warn({ oid }, 'people: bulk role change failed for one person');
            return { oid, outcome: 'failed', code: graphCode(err) };
          }
        });
        const result = { add: adding, remove: removing, results };
        await db.bulkRequests.save({
          actorUserId: actor.id,
          key,
          kind: 'roles',
          requestHash: hash,
          result,
          correlationId,
          at,
        });
        req.log.info({ people: oids.length, correlationId }, 'people: bulk roles (ADR-0038)');
        return reply.code(200).send(result);
      });
    },
  );

  // Bulk welcome emails (ADR-0038 §5): one each, and the 10-minute gap
  // per person still applies (`welcome_recently_sent`).
  app.post(
    '/v1/admin/people/bulk/welcome',
    { preHandler: [requireCapability(READ)] },
    async (req, reply) => {
      const body = bulkWelcomeBody.safeParse(req.body);
      if (!body.success) {
        return problem(
          reply,
          400,
          'validation',
          `body must be {idempotency_key, oids (1–${MAX_BULK}), note?}`,
        );
      }
      const who = await actorOf(req, reply);
      if (!who) return reply;
      const { actor } = who;
      const mail = welcome;
      if (!mail) {
        return problem(reply, 503, 'welcome_not_configured', 'welcome emails are not set up');
      }
      const key = body.data.idempotency_key.toLowerCase();
      const hash = requestHash('welcome', body.data);
      if (await replay(db, reply, actor.id, key, 'welcome', hash)) return reply;
      const note = body.data.note?.trim() || null;
      const oids = [...new Set(body.data.oids.map((o) => o.toLowerCase()))];

      return withGraph(req, reply, async (g) => {
        const correlationId = randomUUID();
        const results = await inTurn(oids, BULK_PARALLEL, async (oid): Promise<BulkOutcome> => {
          const last = await db.people.lastWelcomeAt(oid);
          if (last && Date.now() - last.getTime() < WELCOME_GAP_MS) {
            return { oid, outcome: 'refused', code: 'welcome_recently_sent' };
          }
          let m: WelcomeMessage | 'unknown_person' | 'no_email';
          try {
            m = await welcomeFor(g, oid, note);
          } catch (err) {
            return { oid, outcome: 'failed', code: graphCode(err) };
          }
          if (typeof m === 'string') return { oid, outcome: 'failed', code: m };
          try {
            await mail.send(m);
          } catch (err) {
            const status = (err as { status?: number }).status ?? 0;
            req.log.warn({ status }, 'welcome: bulk send failed for one person');
            const code =
              status === 403 || status === 401 ? 'welcome_not_permitted' : 'welcome_send_failed';
            return { oid, outcome: 'failed', code };
          }
          await db.people.auditWelcome({
            actorUserId: actor.id,
            targetOid: oid,
            to: m.to,
            cc: m.cc,
            correlationId,
            at: new Date(),
          });
          return { oid, outcome: 'sent' };
        });
        const result = { results };
        await db.bulkRequests.save({
          actorUserId: actor.id,
          key,
          kind: 'welcome',
          requestHash: hash,
          result,
          correlationId,
          at: new Date(),
        });
        req.log.info({ people: oids.length, correlationId }, 'people: bulk welcome (ADR-0038)');
        return reply.code(200).send(result);
      });
    },
  );

  /** The employee `:employeeId`, or a reply already sent. */
  async function employeeParam(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const id = String((req.params as { employeeId?: string }).employeeId ?? '').toLowerCase();
    if (!UUID.test(id)) {
      await problem(reply, 400, 'validation', 'employeeId must be a UUID');
      return null;
    }
    if (!(await db.employees.findById(id))) {
      await problem(reply, 404, 'unknown_person', 'no such employee');
      return null;
    }
    return id;
  }

  app.get(
    '/v1/people/:employeeId/active-device',
    { preHandler: [requireCapability(SIGN_OUT)] },
    async (req, reply) => {
      const employeeId = await employeeParam(req, reply);
      if (!employeeId) return reply;
      const active = await activeDeviceOf(db, employeeId);
      if (!active) return reply.code(204).send();
      return reply.code(200).send({
        device_id: active.deviceId,
        os: active.os,
        enrolled_at: active.enrolledAt.toISOString(),
        opened_at: active.openedAt.toISOString(),
        last_event_at: (await lastEventAt(db, active.session, new Date())).toISOString(),
      });
    },
  );

  app.post(
    '/v1/people/:employeeId/active-device/sign-out',
    { preHandler: [requireCapability(SIGN_OUT)] },
    async (req, reply) => {
      const body = signOutBody.safeParse(req.body ?? {});
      if (!body.success) return problem(reply, 400, 'validation', 'body must be {device_id}');
      const auth = req.auth;
      if (!auth) return problem(reply, 401, 'unauthorized', 'authentication required');
      const actor = await db.users.findByEntraObjectId(auth.oid);
      if (!actor)
        return problem(reply, 403, 'no_user_for_oid', 'your account has no CloudPunch user');
      const employeeId = await employeeParam(req, reply);
      if (!employeeId) return reply;

      // The device must be this employee's (invariant 5: no acting on
      // someone else's machine through the wrong person).
      const deviceId = body.data.device_id.toLowerCase();
      const device = await db.devices.findById(deviceId);
      const owner = device ? await db.users.findById(device.userId) : null;
      if (!device || owner?.employeeId !== employeeId) {
        return problem(reply, 404, 'unknown_device', 'no such device for this employee');
      }

      const now = new Date();
      const open = await db.timeSessions.findOpenByEmployeeId(employeeId);
      const session = open && open.deviceId === device.id ? open : null;
      const { closedAt } = await db.devices.signOut({
        deviceId: device.id,
        employeeId,
        sessionId: session?.id ?? null,
        closedAt: session ? await lastEventAt(db, session, now) : null,
        actorUserId: actor.id,
        correlationId: randomUUID(),
        at: now,
      });
      req.log.info(
        { deviceId: device.id, employeeId, closed: closedAt !== null },
        'people: machine signed out (ADR-0028)',
      );
      return reply.code(200).send({ closed_at: closedAt ? closedAt.toISOString() : null });
    },
  );
};

export const _welcomeGapMs = WELCOME_GAP_MS;

export const peopleRoutes = fp(peopleRoutesImpl, { name: 'cloudpunch-people', fastify: '4.x' });
export default peopleRoutes;
