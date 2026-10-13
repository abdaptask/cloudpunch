import { Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { requireCapability } from '../auth/require.js';
import type { DbRepositories, PolicyScope } from '../db/index.js';
import { nameOf } from '../team/service.js';
import { describePerson, describePolicy, item, mentioned } from './describe.js';

/**
 * Change history (ADR-0038 §3, §8), read from audit_log:
 *
 *   GET /v1/admin/employees/:id/history[?limit]          a person's changes
 *   GET /v1/admin/policy/global/history[?limit]          company settings saves
 *   GET /v1/admin/policy/departments/:id/history[?limit] a department's
 *
 * Newest first, 50 by default (at most 200). Read-only: who, when, what
 * and why, in words. Opening someone's day or exceptions isn't a change
 * and isn't listed.
 */

export interface HistoryRoutesOptions {
  db: DbRepositories;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function problem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/problem+json').send({ code, message });
}

function limitOf(q: unknown): number {
  const n = Number((q as { limit?: string }).limit ?? 50);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 200) : 50;
}

const historyRoutesImpl: FastifyPluginAsync<HistoryRoutesOptions> = async (app, opts) => {
  const db = opts.db;

  app.get(
    '/v1/admin/employees/:id/history',
    { preHandler: [requireCapability([Capability.HrEmployeeRead, Capability.AuditReadAll])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const employee = UUID.test(id) ? await db.employees.findById(id) : null;
      if (!employee) return problem(reply, 404, 'not_found', 'no such employee');
      const rows = await db.history.personHistory(
        employee.id,
        employee.entraObjectId ?? null,
        limitOf(req.query),
      );
      const names = new Map<string, string>();
      for (const other of new Set(rows.flatMap(mentioned))) {
        const e = await db.employees.findById(other);
        if (e) names.set(other, nameOf(e));
      }
      return reply.code(200).send({ entries: rows.map((r) => item(r, describePerson(r, names))) });
    },
  );

  const READ = [Capability.AdminPolicyWrite, Capability.HrPolicyWrite, Capability.AuditReadAll];
  const policy = async (
    reply: FastifyReply,
    scope: PolicyScope,
    scopeId: string | null,
    q: unknown,
  ) => {
    const rows = await db.history.policyHistory(scope, scopeId, limitOf(q));
    return reply.code(200).send({ entries: rows.map((r) => item(r, describePolicy(r))) });
  };

  app.get(
    '/v1/admin/policy/global/history',
    { preHandler: [requireCapability(READ)] },
    async (req, reply) => policy(reply, 'global', null, req.query),
  );

  app.get(
    '/v1/admin/policy/departments/:id/history',
    { preHandler: [requireCapability(READ)] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID.test(id)) return problem(reply, 404, 'not_found', 'no such department');
      return policy(reply, 'department', id.toLowerCase(), req.query);
    },
  );
};

export const historyRoutes = fp(historyRoutesImpl, { name: 'cloudpunch-history', fastify: '4.x' });
export default historyRoutes;
