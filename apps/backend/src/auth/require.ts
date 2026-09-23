import { hasAnyCapability, type Capability } from '@cloudpunch/shared';
import type { preHandlerAsyncHookHandler } from 'fastify';

/**
 * Fastify `preHandler` that requires an authenticated request bearing
 * at least one of the given capabilities.
 *
 * Responses:
 *   - 401 `{ code: "unauthorized", message: "authentication required" }`
 *     if the request has no valid `auth` context (missing / malformed /
 *     invalid token).
 *   - 403 `{ code: "forbidden", message: "insufficient role" }` if the
 *     request is authenticated but the caller's roles do not grant any
 *     of the required capabilities.
 *   - Continues to the route handler otherwise.
 */
export function requireCapability(
  required: Capability | readonly Capability[],
): preHandlerAsyncHookHandler {
  const list: readonly Capability[] = Array.isArray(required) ? required : [required as Capability];

  return async (req, reply) => {
    if (!req.auth) {
      await reply
        .code(401)
        .type('application/problem+json')
        .send({ code: 'unauthorized', message: 'authentication required' });
      return;
    }

    if (!hasAnyCapability(req.auth.roles, list)) {
      await reply
        .code(403)
        .type('application/problem+json')
        .send({ code: 'forbidden', message: 'insufficient role' });
      return;
    }
  };
}

/**
 * Simpler variant: require only an authenticated user, regardless of
 * capability. Use for endpoints that any signed-in employee can call
 * (e.g. the "who am I" self endpoint).
 */
export const requireAuth: preHandlerAsyncHookHandler = async (req, reply) => {
  if (!req.auth) {
    await reply
      .code(401)
      .type('application/problem+json')
      .send({ code: 'unauthorized', message: 'authentication required' });
  }
};
