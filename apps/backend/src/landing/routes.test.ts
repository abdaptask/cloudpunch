import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { landingRoutes, page, type Release } from './routes.js';

const SHA = 'a'.repeat(64);

function release(over: Partial<Release> = {}, bytes = 'MZ-installer'): Release {
  return {
    version: '0.1.1',
    file: 'CloudPunch_0.1.1_x64-setup.exe',
    size: Buffer.byteLength(bytes),
    sha256: SHA,
    published_at: '2026-09-29T09:00:00Z',
    notes: ['Idle popup after 2 minutes'],
    ...over,
  };
}

function publish(dir: string, releases: unknown[], bytes = 'MZ-installer'): void {
  mkdirSync(join(dir, 'windows'), { recursive: true });
  writeFileSync(join(dir, 'windows', 'CloudPunch_0.1.1_x64-setup.exe'), bytes);
  writeFileSync(join(dir, 'windows', 'releases.json'), JSON.stringify(releases));
}

async function app(downloadsDir?: string) {
  const a = Fastify();
  await a.register(landingRoutes, { downloadsDir });
  return a;
}

describe('landing page', () => {
  it('serves a static, script-free page with the logo and a strict CSP', async () => {
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('src="/brand/logo.png" alt="CloudPunch"');
    expect(res.body).toContain('srcset="/brand/logo-reversed.png"');
    expect(res.body).not.toMatch(/<script/i);
    expect(res.body).not.toContain('Download for Windows');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    for (const [url, type] of [
      ['/brand/logo.png', 'image/png'],
      ['/brand/logo-reversed.png', 'image/png'],
      ['/favicon.ico', 'image/x-icon'],
    ]) {
      const img = await a.inject({ method: 'GET', url: url! });
      expect(img.statusCode, url).toBe(200);
      expect(img.headers['content-type']).toContain(type);
      expect(img.rawPayload.length).toBeGreaterThan(100);
    }
    expect((await a.inject({ method: 'GET', url: '/download/windows' })).statusCode).toBe(404);
    await a.close();
  });

  it('offers the newest release, what is new in it, and earlier versions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-dl-'));
    publish(dir, [
      release(),
      release({
        version: '0.1.0',
        file: 'CloudPunch_0.1.0_x64-setup.exe',
        published_at: '2026-09-28T20:00:00Z',
        notes: ['First pilot build'],
      }),
    ]);
    const a = await app(dir);
    const home = (await a.inject({ method: 'GET', url: '/' })).body;
    expect(home).toContain('href="/download/windows">Download for Windows');
    // The date is today's locale's short month (Sep or Sept); the day and year are fixed.
    expect(home).toMatch(/Version 0\.1\.1 · 29 Sept? 2026 · /);
    expect(home).toContain("What's new in 0.1.1");
    expect(home).toContain('<li>Idle popup after 2 minutes</li>');
    expect(home).toContain('Earlier versions');
    expect(home).toContain('<li>First pilot build</li>');
    expect(home).toContain(`<code>${SHA}</code>`);
    const redirect = await a.inject({ method: 'GET', url: '/download' });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/download/windows');
    const file = await a.inject({ method: 'GET', url: '/download/windows' });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('MZ-installer');
    expect(file.headers['content-disposition']).toBe(
      'attachment; filename="CloudPunch_0.1.1_x64-setup.exe"',
    );
    expect(file.headers['x-checksum-sha256']).toBe(SHA);
    await a.close();
  });

  it('refuses entries that could point outside the folder, and a half-copied file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-dl-'));
    publish(dir, [release({ file: '../../etc/passwd.exe' })]);
    const a = await app(dir);
    expect((await a.inject({ method: 'GET', url: '/download/windows' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/' })).body).not.toContain(
      'Download for Windows',
    );
    await a.close();

    const dir2 = mkdtempSync(join(tmpdir(), 'cp-dl-'));
    publish(dir2, [release({ size: 999 })]);
    const b = await app(dir2);
    expect((await b.inject({ method: 'GET', url: '/download/windows' })).statusCode).toBe(503);
    await b.close();
  });

  it('escapes release text', () => {
    const html = page([release({ notes: ['<script>alert(1)</script>'] })]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&#60;script&#62;');
  });
});
