import Fastify from 'fastify';
import type { Logger } from 'pino';
import { authPlugin } from './auth/plugin.js';
import { createEntraJwks } from './auth/jwks.js';
import type { Env } from './config/env.js';
import type { DbRepositories } from './db/index.js';
import { devicesRoutes } from './devices/routes.js';
import { eventsRoutes } from './events/routes.js';
import { healthPlugin, type HealthProbe } from './health/routes.js';
import { meRoutes } from './me/routes.js';
import { policyAdminRoutes } from './policy/admin-routes.js';
import { policyRoutes } from './policy/routes.js';

export interface BuildAppOptions {
  env: Env;
  logger: Logger;
  db?: DbRepositories | undefined;
  probes?: readonly HealthProbe[] | undefined;
}

/**
 * Fastify app factory. Returns a configured, un-listened server so
 * tests can drive it via `app.inject`. Phase 1 registers health and
 * auth only; route modules for time, timesheet, admin, and integration
 * land in later phases.
 */
export async function buildApp(opts: BuildAppOptions) {
  const app = Fastify({
    logger: opts.logger,
    disableRequestLogging: false,
    trustProxy: opts.env.CLOUDPUNCH_ENV === 'prod',
    bodyLimit: 1024 * 1024, // 1 MB — event batches are the largest bodies, and they cap at 100 events
  });

  await app.register(healthPlugin, {
    version: opts.env.APP_VERSION,
    env: opts.env.CLOUDPUNCH_ENV,
    ...(opts.probes ? { probes: opts.probes } : {}),
  });

  // Auth plugin wires the onRequest bearer-token verification. If the
  // Entra config is not yet populated (dev bootstrap without a tenant
  // ID), the plugin is skipped and no route requires auth. This is
  // safe because non-health routes register their own guards which
  // will 401 in the absence of `req.auth`.
  if (
    opts.env.ENTRA_TENANT_ID &&
    opts.env.ENTRA_API_CLIENT_ID &&
    opts.env.ENTRA_API_APPLICATION_ID_URI
  ) {
    const jwks = createEntraJwks({
      uri: new URL(
        `https://login.microsoftonline.com/${opts.env.ENTRA_TENANT_ID}/discovery/v2.0/keys`,
      ),
    });
    await app.register(authPlugin, {
      jwks,
      issuer: `https://login.microsoftonline.com/${opts.env.ENTRA_TENANT_ID}/v2.0`,
      audience: opts.env.ENTRA_API_CLIENT_ID,
      tenantId: opts.env.ENTRA_TENANT_ID,
      requiredScope: opts.env.ENTRA_REQUIRED_SCOPE,
    });
  } else {
    opts.logger.warn(
      'ENTRA_TENANT_ID / ENTRA_API_CLIENT_ID / ENTRA_API_APPLICATION_ID_URI not set; auth plugin skipped. All non-health routes will 401 until configured.',
    );
  }

  if (opts.db) {
    await app.register(meRoutes, { db: opts.db });
    await app.register(devicesRoutes, { db: opts.db });
    await app.register(eventsRoutes, { db: opts.db });
    await app.register(policyRoutes, { db: opts.db });
    await app.register(policyAdminRoutes, { db: opts.db });
  } else {
    opts.logger.warn(
      'buildApp called without a DbRepositories; /v1/me, /v1/me/policy, /v1/devices/enroll, and /v1/events are not registered.',
    );
  }

  return app;
}
