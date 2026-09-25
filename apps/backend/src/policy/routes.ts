import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { DbRepositories } from '../db/index.js';
import { requireAuth } from '../auth/require.js';
import { PolicyInvalidError } from './resolve.js';
import { effectivePolicyFor } from './service.js';

export interface PolicyRoutesOptions {
  db: DbRepositories;
}

/**
 * GET /v1/me/policy — the caller's effective policy and its content
 * version (ADR-0015 §3). The ETag is the version; `If-None-Match` with
 * the current version answers 304 so the desktop's 15-minute poll is
 * cheap.
 */
const policyRoutesImpl: FastifyPluginAsync<PolicyRoutesOptions> = async (app, opts) => {
  app.get('/v1/me/policy', { preHandler: [requireAuth] }, async (req, reply) => {
    const auth = req.auth;
    if (!auth) {
      return reply
        .code(500)
        .type('application/problem+json')
        .send({ code: 'internal', message: 'auth preHandler did not populate req.auth' });
    }
    const user = await opts.db.users.findByEntraObjectId(auth.oid);
    if (!user) {
      return reply.code(403).type('application/problem+json').send({
        code: 'no_user_for_oid',
        message: 'authenticated Entra oid has no CloudPunch user record',
      });
    }
    const employee = user.employeeId ? await opts.db.employees.findById(user.employeeId) : null;
    if (!employee) {
      return reply.code(404).type('application/problem+json').send({
        code: 'no_employee',
        message: 'this account is not linked to an employee, so no policy applies',
      });
    }

    let effective;
    try {
      effective = await effectivePolicyFor(opts.db, employee);
    } catch (err) {
      if (err instanceof PolicyInvalidError) {
        req.log.error({ issues: err.issues }, 'stored policy override is invalid');
        return reply.code(500).type('application/problem+json').send({
          code: 'policy_invalid',
          message: 'the stored policy for this employee is invalid; an administrator must fix it',
        });
      }
      throw err;
    }

    const etag = `"${effective.version}"`;
    reply.header('etag', etag).header('cache-control', 'private, no-cache');
    if (matches(req.headers['if-none-match'], etag)) {
      return reply.code(304).send();
    }
    return reply.code(200).send(effective);
  });
};

/** RFC 9110 `If-None-Match`: a list of tags, or `*`. */
function matches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const tags = (Array.isArray(header) ? header.join(',') : header)
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''));
  return tags.includes('*') || tags.includes(etag);
}

export const policyRoutes = fp(policyRoutesImpl, {
  name: 'cloudpunch-policy',
  fastify: '4.x',
});

export default policyRoutes;
