import { Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { requireCapability } from '../auth/require.js';
import type { DbRepositories } from '../db/index.js';
import { RETENTION_KINDS, retentionDays, retentionSettings } from './settings.js';

/**
 * ADR-0044 §3, Administrators:
 *
 *   GET /v1/admin/retention/preview[?time_records_years&idle_notes_days
 *        &audit_log_years&notifications_days&operational_days]
 *
 * What the clean-up would remove now, per kind, for the periods given
 * (or the saved ones). A dry run: nothing changes.
 */

export interface RetentionRoutesOptions {
  db: DbRepositories;
}

/** Each setting and its allowed range (the policy schema's; the low end is the floor). */
const FIELDS = {
  time_records_years: [3, 50],
  idle_notes_days: [90, 3650],
  audit_log_years: [3, 50],
  notifications_days: [120, 3650],
  operational_days: [30, 3650],
} as const;
const NAMES = Object.keys(FIELDS) as (keyof typeof FIELDS)[];

const retentionRoutesImpl: FastifyPluginAsync<RetentionRoutesOptions> = async (app, opts) => {
  const db = opts.db;

  app.get(
    '/v1/admin/retention/preview',
    { preHandler: [requireCapability([Capability.AdminPolicyWrite])] },
    async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const saved = await retentionSettings(db);
      // Periods from the query where given (whole numbers), else saved.
      const asked: Record<string, unknown> = {};
      for (const f of NAMES) {
        const v = q[f];
        if (v === undefined) continue;
        const n = Number(v);
        const [lo, hi] = FIELDS[f];
        if (!Number.isInteger(n) || n < lo || n > hi) {
          return reply
            .code(400)
            .type('application/problem+json')
            .send({
              code: 'validation',
              message: `${f} must be a whole number from ${lo} to ${hi}`,
            });
        }
        asked[f] = n;
      }
      const days = NAMES.some((f) => q[f] !== undefined) ? retentionDays(asked) : saved.days;
      const kinds = [];
      for (const kind of RETENTION_KINDS) {
        kinds.push({
          kind,
          days: days[kind],
          rows: await db.retention.purge(kind, days[kind], true),
        });
      }
      return reply.code(200).send({ enabled: saved.enabled, kinds });
    },
  );
};

export const retentionRoutes = fp(retentionRoutesImpl, {
  name: 'cloudpunch-retention',
  fastify: '4.x',
});
export default retentionRoutes;
