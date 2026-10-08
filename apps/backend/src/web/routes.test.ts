import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEB_CSP, webRoutes, type WebOptions } from './routes.js';

const TENANT = 'a6300e5c-dae4-413c-a6d2-646fbc2aa587';
const WEB = 'c0d42233-0f69-4379-9956-f6f7e48a5278';
const SCOPE = 'api://63bca00e-a546-4f0c-a076-e2450e52406e/api.access';

/** A fake build: index.html, a fingerprinted script, and a secret next door. */
function built(): string {
  const root = mkdtempSync(join(tmpdir(), 'cp-web-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>CloudPunch</title>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(root, 'secret.txt'), 'do not serve');
  return dist;
}

async function app(opts: WebOptions) {
  const a = Fastify();
  await a.register(webRoutes, opts);
  return a;
}

const configured = (distDir: string): WebOptions => ({
  distDir,
  tenantId: TENANT,
  webClientId: WEB,
  apiScope: SCOPE,
});

describe('web dashboard at /app/ (ADR-0033)', () => {
  it('serves the app with a strict CSP and no caching of the page', async () => {
    const a = await app(configured(built()));
    const res = await a.inject({ method: 'GET', url: '/app/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>CloudPunch</title>');
    expect(res.headers['content-security-policy']).toBe(WEB_CSP);
    expect(WEB_CSP).toContain("script-src 'self'");
    expect(WEB_CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('/app redirects to /app/, and app paths fall back to the page', async () => {
    const a = await app(configured(built()));
    const r = await a.inject({ method: 'GET', url: '/app' });
    expect(r.statusCode).toBe(301);
    expect(r.headers.location).toBe('/app/');
    const deep = await a.inject({ method: 'GET', url: '/app/team/42' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<title>CloudPunch</title>');
  });

  it('serves fingerprinted assets for a year; a missing file is a 404', async () => {
    const a = await app(configured(built()));
    const js = await a.inject({ method: 'GET', url: '/app/assets/index-abc123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    expect(js.headers['cache-control']).toContain('immutable');
    const missing = await a.inject({ method: 'GET', url: '/app/assets/nope.js' });
    expect(missing.statusCode).toBe(404);
  });

  it('never serves a file outside the build', async () => {
    const a = await app(configured(built()));
    for (const url of [
      '/app/../secret.txt',
      '/app/%2e%2e/secret.txt',
      '/app/assets/../../secret.txt',
    ]) {
      const res = await a.inject({ method: 'GET', url });
      expect(res.body).not.toContain('do not serve');
    }
  });

  it('hands the app its sign-in settings', async () => {
    const a = await app(configured(built()));
    const res = await a.inject({ method: 'GET', url: '/app/config.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: TENANT, clientId: WEB, apiScope: SCOPE });
  });

  it('says so when it is not set up or not installed', async () => {
    const a = await app({ distDir: join(tmpdir(), 'cp-web-none') });
    expect((await a.inject({ method: 'GET', url: '/app/config.json' })).statusCode).toBe(503);
    const page = await a.inject({ method: 'GET', url: '/app/' });
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain('not installed');
  });
});
