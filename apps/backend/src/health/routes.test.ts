import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { healthPlugin } from './routes.js';

describe('healthPlugin', () => {
  it('returns 200 from /livez', async () => {
    const app = Fastify();
    await app.register(healthPlugin, { version: '0.0.0', env: 'test' });
    const res = await app.inject({ method: 'GET', url: '/livez' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('returns 200 from /readyz', async () => {
    const app = Fastify();
    await app.register(healthPlugin, { version: '0.0.0', env: 'test' });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', checks: {} });
    await app.close();
  });

  it('runs probes on /deep-healthz and reports each', async () => {
    const app = Fastify();
    await app.register(healthPlugin, {
      version: '1.2.3',
      env: 'test',
      probes: [
        { name: 'always_ok', check: async () => ({ ok: true, detail: 'up' }) },
        { name: 'always_bad', check: async () => ({ ok: false, detail: 'down' }) },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/deep-healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      version: string;
      env: string;
      checks: Record<string, { ok: boolean; detail?: string }>;
    };
    expect(body.status).toBe('degraded');
    expect(body.version).toBe('1.2.3');
    expect(body.env).toBe('test');
    expect(body.checks['always_ok']?.ok).toBe(true);
    expect(body.checks['always_bad']?.ok).toBe(false);
    await app.close();
  });

  it('treats a throwing probe as a failure and captures the message', async () => {
    const app = Fastify();
    await app.register(healthPlugin, {
      version: '0.0.0',
      env: 'test',
      probes: [
        {
          name: 'oops',
          check: async () => {
            throw new Error('nope');
          },
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/deep-healthz' });
    const body = res.json() as { checks: Record<string, { ok: boolean; detail?: string }> };
    expect(body.checks['oops']?.ok).toBe(false);
    expect(body.checks['oops']?.detail).toBe('nope');
    await app.close();
  });
});
