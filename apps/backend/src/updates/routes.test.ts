import { AppRole } from '@cloudpunch/shared';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { authPlugin } from '../auth/plugin.js';
import type { Release } from '../landing/routes.js';
import { isNewer, updateRoutes } from './routes.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const REQUIRED_SCOPE = 'api.access';
const KID = 'test-key-1';
const BYTES = 'MZ-installer';

let signerPrivate: KeyLike;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signerPrivate = kp.privateKey;
  const pubJwk = await exportJWK(kp.publicKey);
  pubJwk.kid = KID;
  pubJwk.alg = 'RS256';
  pubJwk.use = 'sig';
  jwks = createLocalJWKSet({ keys: [pubJwk] });
});

async function bearer(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    aud: CLIENT_ID,
    tid: TENANT_ID,
    oid: randomUUID(),
    scp: REQUIRED_SCOPE,
    roles: [AppRole.Employee],
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signerPrivate);
  return `Bearer ${token}`;
}

function release(over: Partial<Release> = {}): Release {
  return {
    version: '0.1.2',
    file: 'CloudPunch_0.1.2_x64-setup.exe',
    size: Buffer.byteLength(BYTES),
    sha256: 'a'.repeat(64),
    published_at: '2026-09-29T09:00:00Z',
    notes: ['Updates itself', 'Faster sign-in'],
    signature: 'dW50cnVzdGVkIGNvbW1lbnQ=',
    ...over,
  };
}

function unsigned(over: Partial<Release> = {}): Release {
  const r = release(over);
  delete r.signature;
  return r;
}

function publish(releases: Release[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-updates-'));
  mkdirSync(join(dir, 'windows'), { recursive: true });
  for (const r of releases) writeFileSync(join(dir, 'windows', r.file), BYTES);
  writeFileSync(join(dir, 'windows', 'releases.json'), JSON.stringify(releases));
  return dir;
}

async function app(downloadsDir?: string) {
  const a = Fastify();
  await a.register(authPlugin, {
    jwks,
    issuer: ISSUER,
    audience: CLIENT_ID,
    tenantId: TENANT_ID,
    requiredScope: REQUIRED_SCOPE,
  });
  await a.register(updateRoutes, { downloadsDir, siteUrl: 'https://cloudpunch.aptask.com/' });
  return a;
}

describe('isNewer', () => {
  it('compares x.y.z numerically and never offers anything unparseable', () => {
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
    expect(isNewer('0.2.0', '0.1.99')).toBe(true);
    expect(isNewer('0.1.1', '0.1.1')).toBe(false);
    expect(isNewer('0.1.0', '0.1.1')).toBe(false);
    expect(isNewer('0.1.2-beta', '0.1.1')).toBe(false);
    expect(isNewer('0.1.2', 'garbage')).toBe(false);
  });
});

describe('GET /v1/desktop/update/windows/:current', () => {
  it('needs the app token', async () => {
    const a = await app(publish([release()]));
    const res = await a.inject({ method: 'GET', url: '/v1/desktop/update/windows/0.1.1' });
    expect(res.statusCode).toBe(401);
  });

  it('offers the newest signed release as a Tauri manifest', async () => {
    const a = await app(publish([release()]));
    const res = await a.inject({
      method: 'GET',
      url: '/v1/desktop/update/windows/0.1.1',
      headers: { authorization: await bearer() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      version: '0.1.2',
      notes: 'Updates itself\nFaster sign-in',
      pub_date: '2026-09-29T09:00:00Z',
      url: 'https://cloudpunch.aptask.com/v1/desktop/update/files/windows/CloudPunch_0.1.2_x64-setup.exe',
      signature: 'dW50cnVzdGVkIGNvbW1lbnQ=',
    });
  });

  it('answers 204 when up to date, ahead, or nothing signed is published', async () => {
    const auth = { authorization: await bearer() };
    const signed = await app(publish([release()]));
    for (const v of ['0.1.2', '0.1.3']) {
      const res = await signed.inject({
        method: 'GET',
        url: `/v1/desktop/update/windows/${v}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(204);
    }
    const bare = await app(publish([unsigned()]));
    const res = await bare.inject({
      method: 'GET',
      url: '/v1/desktop/update/windows/0.1.1',
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    const none = await app();
    expect(
      (await none.inject({ method: 'GET', url: '/v1/desktop/update/windows/0.1.1', headers: auth }))
        .statusCode,
    ).toBe(204);
  });

  it('skips an unsigned newest release for the newest signed one', async () => {
    const a = await app(
      publish([unsigned({ version: '0.1.3', file: 'CloudPunch_0.1.3_x64-setup.exe' }), release()]),
    );
    const res = await a.inject({
      method: 'GET',
      url: '/v1/desktop/update/windows/0.1.1',
      headers: { authorization: await bearer() },
    });
    expect((res.json() as { version: string }).version).toBe('0.1.2');
  });
});

describe('GET /v1/desktop/update/files/windows/:file', () => {
  it('serves a listed, signed installer to the app only', async () => {
    const a = await app(publish([release()]));
    const url = '/v1/desktop/update/files/windows/CloudPunch_0.1.2_x64-setup.exe';
    expect((await a.inject({ method: 'GET', url })).statusCode).toBe(401);
    const res = await a.inject({ method: 'GET', url, headers: { authorization: await bearer() } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(BYTES);
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(BYTES)));
  });

  it('refuses files that are not a signed release', async () => {
    const dir = publish([release()]);
    writeFileSync(join(dir, 'windows', 'other.exe'), BYTES);
    const a = await app(dir);
    const auth = { authorization: await bearer() };
    for (const file of ['other.exe', '..%2Freleases.json', 'releases.json']) {
      const res = await a.inject({
        method: 'GET',
        url: `/v1/desktop/update/files/windows/${file}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('answers 503 while the file is still being copied', async () => {
    const dir = publish([release()]);
    writeFileSync(join(dir, 'windows', 'CloudPunch_0.1.2_x64-setup.exe'), 'MZ');
    const a = await app(dir);
    const res = await a.inject({
      method: 'GET',
      url: '/v1/desktop/update/files/windows/CloudPunch_0.1.2_x64-setup.exe',
      headers: { authorization: await bearer() },
    });
    expect(res.statusCode).toBe(503);
  });
});
