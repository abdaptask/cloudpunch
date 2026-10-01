import { randomUUID } from 'node:crypto';
import { Capability, capabilitiesForRoles } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { requireCapability } from '../auth/require.js';
import type { AppUser, DbRepositories, DeviceConnection, Employee } from '../db/index.js';
import { effectivePolicyForScope } from '../policy/service.js';
import { inScope, nameOf, peopleIn, type TeamScope } from '../team/service.js';

/**
 * Where people connect from (ADR-0029 §5):
 *
 *   GET /v1/me/connections                   your own, last 30 days
 *   GET /v1/team/connections                 each person's latest (Team list)
 *   GET /v1/team/:employeeId/connections     a person's, last 30 days
 *
 * Administrators see everyone; a Manager sees direct reports only; HR
 * and Auditors see no one (not even with HR's org-wide team view).
 * Outside the caller's scope is 404. Opening a person's history is
 * audited; the Team list, which refreshes every 30 seconds, audits each
 * person at most once an hour per viewer.
 */

export interface ConnectionRoutesOptions {
  db: DbRepositories;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KEEP_DAYS = 30;
const LIST_AUDIT_EVERY_MS = 60 * 60 * 1000;
/** CC BY 4.0: shown wherever provider names are (ADR-0029 §3). */
export const ATTRIBUTION = 'IP data by DB-IP';

/** Whose connections the caller may see (ADR-0029 §5). */
export function connectionScope(
  capabilities: ReadonlySet<string>,
  callerEmployeeId: string | null,
): TeamScope {
  if (capabilities.has(Capability.AdminConnectionRead)) return { kind: 'all' };
  if (capabilities.has(Capability.TeamConnectionRead) && callerEmployeeId) {
    return { kind: 'reports', managerId: callerEmployeeId };
  }
  return { kind: 'none' };
}

export interface ConnectionView {
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
  provider: string | null;
  asn: number | null;
  device_os: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

function problem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/problem+json').send({ code, message });
}

const connectionRoutesImpl: FastifyPluginAsync<ConnectionRoutesOptions> = async (app, opts) => {
  const db = opts.db;
  const now = opts.now ?? (() => new Date());
  const since = () => new Date(now().getTime() - KEEP_DAYS * 86_400_000);
  /** `${actor}:${employee}` → when the Team list last audited it. */
  const listAudited = new Map<string, number>();

  async function view(rows: readonly DeviceConnection[]): Promise<ConnectionView[]> {
    const os = new Map<string, string | null>();
    for (const id of new Set(rows.map((r) => r.deviceId))) {
      os.set(id, (await db.devices.findById(id))?.os ?? null);
    }
    return rows.map((r) => ({
      ip: r.ip,
      city: r.city,
      region: r.region,
      country: r.country,
      provider: r.provider,
      asn: r.asn,
      device_os: os.get(r.deviceId) ?? null,
      first_seen_at: r.firstSeenAt.toISOString(),
      last_seen_at: r.lastSeenAt.toISOString(),
    }));
  }

  async function recording(): Promise<boolean> {
    const { policy } = await effectivePolicyForScope(db, 'global', null);
    return (policy['connections'] as { record?: unknown } | undefined)?.record === true;
  }

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
    return { user, scope: connectionScope(caps, user.employeeId) };
  }

  const audit = (actor: AppUser, employeeId: string, detail: Record<string, string>) =>
    db.employees.auditView({
      actorUserId: actor.id,
      employeeId,
      action: 'connections_viewed',
      detail,
      correlationId: randomUUID(),
      at: now(),
    });

  app.get(
    '/v1/me/connections',
    { preHandler: [requireCapability([Capability.SelfConnectionRead])] },
    async (req, reply) => {
      const user = req.auth ? await db.users.findByEntraObjectId(req.auth.oid) : null;
      if (!user?.employeeId) {
        return problem(reply, 403, 'no_employee_for_user', 'your account has no employee record');
      }
      const rows = await db.connections.listForEmployee(user.employeeId, since());
      return reply.code(200).send({
        recording: await recording(),
        keep_days: KEEP_DAYS,
        attribution: ATTRIBUTION,
        connections: await view(rows),
      });
    },
  );

  const team = {
    preHandler: [
      requireCapability([Capability.AdminConnectionRead, Capability.TeamConnectionRead]),
    ],
  };

  app.get('/v1/team/connections', team, async (req, reply) => {
    const c = await caller(req, reply);
    if (!c) return reply;
    const people: Employee[] = await peopleIn(db, c.scope);
    const latest = await db.connections.latestForEmployees(
      people.map((p) => p.id),
      since(),
    );
    const t = now().getTime();
    for (const id of latest.keys()) {
      const key = `${c.user.id}:${id}`;
      if (t - (listAudited.get(key) ?? 0) < LIST_AUDIT_EVERY_MS) continue;
      listAudited.set(key, t);
      await audit(c.user, id, { view: 'team_list' });
    }
    const rows = [...latest.values()];
    const views = await view(rows);
    const names = new Map(people.map((p) => [p.id, nameOf(p)]));
    return reply.code(200).send({
      recording: await recording(),
      attribution: ATTRIBUTION,
      people: rows.map((r, i) => ({
        employee_id: r.employeeId,
        name: names.get(r.employeeId) ?? '',
        ...views[i],
      })),
    });
  });

  app.get('/v1/team/:employeeId/connections', team, async (req, reply) => {
    const c = await caller(req, reply);
    if (!c) return reply;
    const { employeeId } = req.params as { employeeId: string };
    const e = UUID.test(employeeId) ? await db.employees.findById(employeeId) : null;
    if (!e || !inScope(c.scope, e)) {
      return problem(reply, 404, 'not_found', 'no such person on your team');
    }
    await audit(c.user, e.id, { view: 'history' });
    const rows = await db.connections.listForEmployee(e.id, since());
    return reply.code(200).send({
      name: nameOf(e),
      recording: await recording(),
      keep_days: KEEP_DAYS,
      attribution: ATTRIBUTION,
      connections: await view(rows),
    });
  });
};

export const connectionRoutes = fp(connectionRoutesImpl, {
  name: 'cloudpunch-connection-routes',
  fastify: '4.x',
});
