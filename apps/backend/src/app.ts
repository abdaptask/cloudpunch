import Fastify from 'fastify';
import type { Logger } from 'pino';
import { authPlugin } from './auth/plugin.js';
import { createEntraJwks } from './auth/jwks.js';
import type { Env } from './config/env.js';
import { ConnectionRecorder } from './connections/recorder.js';
import { connectionRoutes } from './connections/routes.js';
import { correctionRoutes } from './corrections/routes.js';
import { DbIpProviderLookup } from './connections/provider.js';
import type { DbRepositories } from './db/index.js';
import { dayRoutes } from './days/routes.js';
import { devicesRoutes } from './devices/routes.js';
import { eventsRoutes } from './events/routes.js';
import { healthPlugin, type HealthProbe } from './health/routes.js';
import { landingRoutes } from './landing/routes.js';
import { meRoutes } from './me/routes.js';
import { readFileSync } from 'node:fs';
import { createGraph, type Graph } from './people/graph.js';
import { graphTokenForApp, graphTokenOnBehalfOf } from './people/obo.js';
import { addressList, sendWelcome } from './people/welcome.js';
import { readReleases } from './landing/routes.js';
import { peopleRoutes, type PeopleRoutesOptions } from './people/routes.js';
import { policyAdminRoutes } from './policy/admin-routes.js';
import { policyRoutes } from './policy/routes.js';
import { updateRoutes } from './updates/routes.js';
import { teamRoutes } from './team/routes.js';

export interface BuildAppOptions {
  /** Tests inject a fake Graph; otherwise built from the OBO certificate. */
  graphFor?: ((userToken: string) => Promise<Graph>) | null;
  /** Tests inject welcome sending; otherwise built from WELCOME_* settings. */
  welcome?: PeopleRoutesOptions['welcome'];
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
    // Pilot: Caddy on the same host terminates TLS (ADR-0019); trust only it.
    trustProxy:
      opts.env.CLOUDPUNCH_ENV === 'prod' ||
      (opts.env.CLOUDPUNCH_ENV === 'pilot' ? '127.0.0.1' : false),
    bodyLimit: 1024 * 1024, // 1 MB — event batches are the largest bodies, and they cap at 100 events
  });

  // A friendly page for anyone opening the address in a browser.
  await app.register(landingRoutes, { downloadsDir: opts.env.DOWNLOADS_DIR });

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

  // Desktop auto-update (ADR-0022): needs only a valid token, no db.
  await app.register(updateRoutes, {
    downloadsDir: opts.env.DOWNLOADS_DIR,
    siteUrl: opts.env.PUBLIC_SITE_URL,
  });

  if (opts.db) {
    // ADR-0029: off until the global `connections.record` setting is on.
    const connections = new ConnectionRecorder({
      db: opts.db,
      log: app.log,
      providers: new DbIpProviderLookup(opts.env.DBIP_ASN_MMDB, app.log),
    });
    await app.register(meRoutes, { db: opts.db });
    await app.register(devicesRoutes, { db: opts.db, connections });
    await app.register(eventsRoutes, { db: opts.db, connections });
    await app.register(dayRoutes, { db: opts.db });
    await app.register(policyRoutes, { db: opts.db });
    await app.register(policyAdminRoutes, { db: opts.db });
    await app.register(teamRoutes, { db: opts.db });
    await app.register(connectionRoutes, { db: opts.db });
    await app.register(correctionRoutes, { db: opts.db });
    await app.register(peopleRoutes, {
      db: opts.db,
      graphFor: opts.graphFor ?? graphFromEnv(opts),
      welcome: opts.welcome === undefined ? welcomeFromEnv(opts) : opts.welcome,
    });
  } else {
    opts.logger.warn(
      'buildApp called without a DbRepositories; /v1/me, /v1/me/policy, /v1/devices/enroll, and /v1/events are not registered.',
    );
  }

  return app;
}

/**
 * People's Graph access (ADR-0020): on behalf of the caller, when the
 * OBO certificate is configured; otherwise null (routes answer 503).
 */
function graphFromEnv(opts: BuildAppOptions): ((userToken: string) => Promise<Graph>) | null {
  const { env } = opts;
  if (
    !env.ENTRA_TENANT_ID ||
    !env.ENTRA_API_CLIENT_ID ||
    !env.ENTRA_OBO_CERT_KEY_PATH ||
    !env.ENTRA_OBO_CERT_THUMBPRINT
  ) {
    return null;
  }
  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(env.ENTRA_OBO_CERT_KEY_PATH, 'utf8');
  } catch (err) {
    opts.logger.error({ err: String(err) }, 'people: OBO key unreadable; People disabled');
    return null;
  }
  const cfg = {
    tenantId: env.ENTRA_TENANT_ID,
    clientId: env.ENTRA_API_CLIENT_ID,
    privateKeyPem,
    thumbprint: env.ENTRA_OBO_CERT_THUMBPRINT,
  };
  const apiAppId = env.ENTRA_API_CLIENT_ID;
  return async (userToken) =>
    createGraph({ token: await graphTokenOnBehalfOf(cfg, userToken), apiAppId });
}

/**
 * Welcome emails (ADR-0021): sent as WELCOME_FROM with CloudPunch's own
 * token, which Exchange limits to that one mailbox. Off unless
 * WELCOME_FROM and the certificate are configured.
 */
function welcomeFromEnv(opts: BuildAppOptions): NonNullable<PeopleRoutesOptions['welcome']> | null {
  const { env } = opts;
  if (
    !env.WELCOME_FROM ||
    !env.ENTRA_TENANT_ID ||
    !env.ENTRA_API_CLIENT_ID ||
    !env.ENTRA_OBO_CERT_KEY_PATH ||
    !env.ENTRA_OBO_CERT_THUMBPRINT
  ) {
    return null;
  }
  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(env.ENTRA_OBO_CERT_KEY_PATH, 'utf8');
  } catch {
    return null;
  }
  const cfg = {
    tenantId: env.ENTRA_TENANT_ID,
    clientId: env.ENTRA_API_CLIENT_ID,
    privateKeyPem,
    thumbprint: env.ENTRA_OBO_CERT_THUMBPRINT,
  };
  const downloadsDir = env.DOWNLOADS_DIR;
  return {
    settings: {
      from: env.WELCOME_FROM,
      cc: addressList(env.WELCOME_CC),
      siteUrl: env.PUBLIC_SITE_URL,
      supportEmail: env.SUPPORT_EMAIL,
    },
    version: async () => (await readReleases(downloadsDir))[0]?.version ?? null,
    send: async (m) => sendWelcome(await graphTokenForApp(cfg), m),
  };
}
