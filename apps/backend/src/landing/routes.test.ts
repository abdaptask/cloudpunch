import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { landingRoutes } from './routes.js';

describe('landing page', () => {
  it('serves a static, script-free page with a strict CSP', async () => {
    const app = Fastify();
    await app.register(landingRoutes);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<h1>CloudPunch</h1>');
    expect(res.body).toContain('Sign in with your ApTask Microsoft account');
    expect(res.body).not.toMatch(/<script/i);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const fav = await app.inject({ method: 'GET', url: '/favicon.ico' });
    expect(fav.statusCode).toBe(204);
    await app.close();
  });
});
