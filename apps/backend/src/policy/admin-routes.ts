import { randomUUID } from 'node:crypto';
import { Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import type { DbRepositories, PolicyOverride, PolicyScope } from '../db/index.js';
import { requireCapability } from '../auth/require.js';
import { PolicyInvalidError, policyIssues } from './resolve.js';
import { effectivePolicyFor } from './service.js';

export interface PolicyAdminRoutesOptions {
  db: DbRepositories;
}

/**
 * Policy overrides per scope (ADR-0015 §4):
 *
 *   GET|PUT|DELETE /v1/admin/policy/global
 *   GET|PUT|DELETE /v1/admin/policy/departments/:id
 *   GET|PUT|DELETE /v1/admin/policy/employees/:id
 *   GET            /v1/admin/policy/employees/:id/effective
 *
 * Global needs `admin.policy.write`; department and employee scopes also
 * accept HR's `hr.policy.write`. Anyone who can write may read, and so
 * may Auditors. Every change writes an audit_log row in the same
 * transaction (policy doc §14). A per-employee change needs a reason.
 */

const WRITE_GLOBAL = [Capability.AdminPolicyWrite];
const WRITE_SCOPED = [Capability.AdminPolicyWrite, Capability.HrPolicyWrite];
const READ = [Capability.AdminPolicyWrite, Capability.HrPolicyWrite, Capability.AuditReadAll];

const putBodySchema = z
  .object({
    document: z.record(z.unknown()),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const deleteBodySchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict()
  .optional();

const idSchema = z.string().uuid();

interface Target {
  scope: PolicyScope;
  scopeId: string | null;
}

function problem(reply: FastifyReply, status: number, code: string, message: string, extra = {}) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ code, message, ...extra });
}

function view(target: Target, o: PolicyOverride | null) {
  return {
    scope: target.scope,
    scope_id: target.scopeId,
    override: o
      ? {
          document: o.document,
          reason: o.reason,
          updated_by_user_id: o.updatedByUserId,
          updated_at: o.updatedAt.toISOString(),
        }
      : null,
  };
}

const policyAdminRoutesImpl: FastifyPluginAsync<PolicyAdminRoutesOptions> = async (app, opts) => {
  const { db } = opts;

  /** Resolve `:id` for a scope and check it exists. Replies on failure. */
  async function target(
    scope: PolicyScope,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Target | null> {
    if (scope === 'global') return { scope, scopeId: null };
    const raw = (req.params as { id?: string }).id;
    const parsed = idSchema.safeParse(raw);
    if (!parsed.success) {
      await problem(reply, 400, 'validation', 'id must be a UUID');
      return null;
    }
    const exists =
      scope === 'department'
        ? await db.departments.exists(parsed.data)
        : (await db.employees.findById(parsed.data)) !== null;
    if (!exists) {
      await problem(reply, 404, `unknown_${scope}`, `no ${scope} with that id`);
      return null;
    }
    return { scope, scopeId: parsed.data };
  }

  /** The caller's CloudPunch user id (the audit actor). Replies on failure. */
  async function actor(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const user = req.auth ? await db.users.findByEntraObjectId(req.auth.oid) : null;
    if (!user) {
      await problem(
        reply,
        403,
        'no_user_for_oid',
        'authenticated Entra oid has no CloudPunch user',
      );
      return null;
    }
    return user.id;
  }

  const scopes: { scope: PolicyScope; path: string }[] = [
    { scope: 'global', path: '/v1/admin/policy/global' },
    { scope: 'department', path: '/v1/admin/policy/departments/:id' },
    { scope: 'employee', path: '/v1/admin/policy/employees/:id' },
  ];

  for (const { scope, path } of scopes) {
    const write = scope === 'global' ? WRITE_GLOBAL : WRITE_SCOPED;

    app.get(path, { preHandler: [requireCapability(READ)] }, async (req, reply) => {
      const t = await target(scope, req, reply);
      if (!t) return reply;
      return reply.code(200).send(view(t, await db.policies.find(t.scope, t.scopeId)));
    });

    app.put(path, { preHandler: [requireCapability(write)] }, async (req, reply) => {
      const body = putBodySchema.safeParse(req.body);
      if (!body.success) {
        return problem(reply, 400, 'validation', 'body must be {document, reason?}', {
          issues: body.error.issues,
        });
      }
      const t = await target(scope, req, reply);
      if (!t) return reply;
      const reason = body.data.reason ?? null;
      if (scope === 'employee' && !reason) {
        return problem(reply, 400, 'reason_required', 'a per-employee override needs a reason');
      }
      const issues = policyIssues(body.data.document);
      if (issues.length > 0) {
        return problem(reply, 400, 'policy_invalid', 'the policy document is invalid', { issues });
      }
      const actorUserId = await actor(req, reply);
      if (!actorUserId) return reply;

      await db.policies.put(
        {
          ...t,
          reason,
          actorUserId,
          correlationId: randomUUID(),
          at: new Date(),
        },
        body.data.document,
      );
      return reply.code(200).send(view(t, await db.policies.find(t.scope, t.scopeId)));
    });

    app.delete(path, { preHandler: [requireCapability(write)] }, async (req, reply) => {
      const body = deleteBodySchema.safeParse(req.body ?? undefined);
      if (!body.success) {
        return problem(reply, 400, 'validation', 'body must be {reason?}', {
          issues: body.error.issues,
        });
      }
      const t = await target(scope, req, reply);
      if (!t) return reply;
      const reason = body.data?.reason ?? null;
      if (scope === 'employee' && !reason) {
        return problem(
          reply,
          400,
          'reason_required',
          'removing a per-employee override needs a reason',
        );
      }
      const actorUserId = await actor(req, reply);
      if (!actorUserId) return reply;

      const removed = await db.policies.remove({
        ...t,
        reason,
        actorUserId,
        correlationId: randomUUID(),
        at: new Date(),
      });
      if (!removed) return problem(reply, 404, 'not_found', 'no override at this scope');
      return reply.code(204).send();
    });
  }

  app.get(
    '/v1/admin/policy/employees/:id/effective',
    { preHandler: [requireCapability(READ)] },
    async (req, reply) => {
      const t = await target('employee', req, reply);
      if (!t?.scopeId) return reply;
      const employee = await db.employees.findById(t.scopeId);
      if (!employee) return problem(reply, 404, 'unknown_employee', 'no employee with that id');
      try {
        return reply.code(200).send(await effectivePolicyFor(db, employee));
      } catch (err) {
        if (err instanceof PolicyInvalidError) {
          return problem(reply, 500, 'policy_invalid', 'a stored override is invalid', {
            issues: err.issues,
          });
        }
        throw err;
      }
    },
  );
};

export const policyAdminRoutes = fp(policyAdminRoutesImpl, {
  name: 'cloudpunch-policy-admin',
  fastify: '4.x',
});

export default policyAdminRoutes;
