import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export interface HealthDeps {
  version: string;
  env: string;
  /**
   * Deep health probes contributed by other modules (DB, Redis, greytHR).
   * Each returns `{ ok: boolean, latencyMs?: number, detail?: string }`.
   * Empty in Phase 1; wired up in later phases. Explicit `| undefined` is
   * required under `exactOptionalPropertyTypes`.
   */
  probes?: readonly HealthProbe[] | undefined;
}

export interface HealthProbe {
  name: string;
  check: () => Promise<{ ok: boolean; latencyMs?: number; detail?: string }>;
}

/**
 * Registers the standard health endpoints.
 *
 * - `/livez`   — cheap, no dependencies. If the process is running, respond 200.
 * - `/readyz`  — declares readiness to accept traffic. Should reflect any
 *                external dependencies the service NEEDS at boot.
 * - `/deep-healthz` — expensive, runs registered probes and reports each.
 */
export const healthPlugin: FastifyPluginAsync<HealthDeps> = async (
  app: FastifyInstance,
  deps: HealthDeps,
) => {
  app.get('/livez', async () => ({ status: 'ok' }));

  app.get('/readyz', async () => {
    return { status: 'ok', checks: {} };
  });

  app.get('/deep-healthz', async () => {
    const probes = deps.probes ?? [];
    const results: Record<string, { ok: boolean; latencyMs?: number; detail?: string }> = {};
    let allOk = true;
    for (const p of probes) {
      const t0 = performance.now();
      try {
        const r = await p.check();
        results[p.name] = { ...r, latencyMs: r.latencyMs ?? performance.now() - t0 };
        if (!r.ok) allOk = false;
      } catch (err) {
        results[p.name] = {
          ok: false,
          latencyMs: performance.now() - t0,
          detail: err instanceof Error ? err.message : 'probe threw',
        };
        allOk = false;
      }
    }
    return {
      status: allOk ? 'ok' : 'degraded',
      version: deps.version,
      env: deps.env,
      checks: results,
    };
  });
};
