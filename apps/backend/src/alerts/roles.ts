import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { DbRepositories } from '../db/index.js';

/**
 * ADR-0037 (the owner chose "remember roles"): note the roles each
 * person's sign-in token carries, so the alert emails can find the
 * Administrators and HR. Only for choosing email recipients; access is
 * still checked against each request's own token (invariant 6).
 *
 * The last roles seen per person are kept in memory, so a request
 * writes only when someone's roles changed (or once after a restart).
 * Never fails the request: errors are logged.
 */
export class RoleNotes {
  private readonly last = new Map<string, string>();

  constructor(
    private readonly db: DbRepositories,
    private readonly log: FastifyBaseLogger,
  ) {}

  async fromRequest(req: FastifyRequest): Promise<void> {
    const auth = req.auth;
    if (!auth) return;
    const roles = [...auth.roles].sort();
    const key = roles.join(',');
    if (this.last.get(auth.oid) === key) return;
    try {
      await this.db.roles.note(auth.oid, roles, 'token', new Date());
      this.last.set(auth.oid, key);
    } catch (err) {
      this.log.warn({ err }, 'roles: could not note');
    }
  }
}
