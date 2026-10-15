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
import type { ShiftMail } from '../alerts/mail.js';
import { authPlugin } from '../auth/plugin.js';
import type { AppUser } from '../db/index.js';
import { InMemoryDb } from '../db/in-memory.js';
import type { Release } from '../landing/routes.js';
import { REMIND_EVERY_MS, reminderMail, updateRemindRoutes } from './remind.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'test-key-1';

let signer: KeyLike;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signer = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  Object.assign(jwk, { kid: KID, alg: 'RS256', use: 'sig' });
  jwks = createLocalJWKSet({ keys: [jwk] });
});

async function bearer(oid: string, roles: string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ aud: CLIENT_ID, tid: TENANT_ID, oid, scp: 'api.access', roles })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signer);
  return `Bearer ${token}`;
}

function release(version: string): Release {
  return {
    version,
    file: `CloudPunch_${version}.exe`,
    size: 1,
    sha256: 'a'.repeat(64),
    published_at: '2026-10-15T09:00:00Z',
    notes: ['x'],
    signature: 'c2ln',
  };
}

function publish(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-remind-'));
  for (const [p, v] of [
    ['windows', '0.1.46'],
    ['macos', '0.1.46'],
  ] as const) {
    mkdirSync(join(dir, p), { recursive: true });
    writeFileSync(join(dir, p, 'releases.json'), JSON.stringify([release(v)]));
  }
  return dir;
}

const user = (name: string, email: string, employeeId: string | null = null): AppUser => ({
  id: randomUUID(),
  entraObjectId: randomUUID(),
  workEmail: email,
  displayName: name,
  isServiceAccount: false,
  breakGlass: false,
  employeeId,
});

async function setup(opts: { mail?: boolean; failFor?: string } = {}) {
  const db = new InMemoryDb();
  const admin = user('Abdulla Sheikh', 'abdulla@aptask.com');
  const sweta = user('Sweta Pandit', 'sweta@aptask.com');
  const eela = user('Eela Kapilla', 'eela@aptask.com');
  const noMail = user('No Mail', '');
  const nobody = user('No Computer', 'nobody@aptask.com');
  for (const u of [admin, sweta, eela, noMail, nobody]) db.seedUser(u);
  const enroll = (userId: string, os: 'windows' | 'macos', appVersion: string) =>
    db.devices.enroll({
      id: randomUUID(),
      userId,
      os,
      hostnameHash: `sha256-${randomUUID()}`,
      publicKeyEd25519: new Uint8Array(32),
      appVersion,
    });
  await enroll(sweta.id, 'windows', '0.1.32');
  await enroll(sweta.id, 'macos', '0.1.46');
  await enroll(eela.id, 'macos', '0.1.46');
  await enroll(noMail.id, 'windows', '0.1.40');
  const sent: ShiftMail[] = [];
  const now = { t: new Date('2026-10-15T18:00:00Z') };
  const app = Fastify();
  await app.register(authPlugin, {
    jwks,
    issuer: ISSUER,
    audience: CLIENT_ID,
    tenantId: TENANT_ID,
    requiredScope: 'api.access',
  });
  await app.register(updateRemindRoutes, {
    db,
    send:
      opts.mail === false
        ? null
        : async (m) => {
            if (opts.failFor && m.to.includes(opts.failFor)) throw new Error('Graph down');
            sent.push(m);
          },
    downloadsDir: publish(),
    siteUrl: 'https://cloudpunch.aptask.com/',
    now: () => now.t,
  });
  const auth = await bearer(admin.entraObjectId, [AppRole.Administrator]);
  const remind = (ids: string[], message?: string, token = auth) =>
    app.inject({
      method: 'POST',
      url: '/v1/admin/updates/remind',
      headers: { authorization: token },
      payload: { user_ids: ids, ...(message ? { message } : {}) },
    });
  return { db, app, sent, now, remind, admin, sweta, eela, noMail, nobody };
}

describe('POST /v1/admin/updates/remind (Computers → Email to update)', () => {
  it('emails each person behind, on their own, with their versions; skips the rest', async () => {
    const s = await setup();
    const bogus = randomUUID();
    const res = await s.remind(
      [s.sweta.id, s.eela.id, s.noMail.id, s.nobody.id, bogus],
      'Please do this today.',
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sent: 1,
      sent_ids: [s.sweta.id],
      skipped: [
        { id: s.eela.id, reason: 'up_to_date' },
        { id: s.noMail.id, reason: 'no_email' },
        { id: s.nobody.id, reason: 'no_computer' },
        { id: bogus, reason: 'not_found' },
      ],
    });
    expect(s.sent).toHaveLength(1);
    const [m] = s.sent;
    // The address is the server's record, never the request's.
    expect(m?.to).toEqual(['sweta@aptask.com']);
    expect(m?.cc).toEqual([]);
    expect(m?.subject).toBe('Please update CloudPunch to 0.1.46');
    expect(m?.text).toContain('Hi Sweta,');
    expect(m?.text).toContain('Please do this today.');
    expect(m?.text).toContain('Your Windows PC has CloudPunch 0.1.32; the latest is 0.1.46.');
    expect(m?.text).not.toContain('Your Mac');
    expect(m?.text).toContain('https://cloudpunch.aptask.com/app/download/');
    expect(s.db.updateReminderAudit).toMatchObject([
      { userId: s.sweta.id, to: 'sweta@aptask.com', versions: ['0.1.32'], latest: '0.1.46' },
    ]);
  });

  it('once an hour per person', async () => {
    const s = await setup();
    expect((await s.remind([s.sweta.id])).json()).toMatchObject({ sent: 1 });
    s.now.t = new Date(s.now.t.getTime() + REMIND_EVERY_MS - 1);
    expect((await s.remind([s.sweta.id])).json()).toMatchObject({
      sent: 0,
      skipped: [{ id: s.sweta.id, reason: 'reminded_recently' }],
    });
    s.now.t = new Date(s.now.t.getTime() + 2);
    expect((await s.remind([s.sweta.id])).json()).toMatchObject({ sent: 1 });
    expect(s.sent).toHaveLength(2);
  });

  it('a failed send is skipped and not audited', async () => {
    const s = await setup({ failFor: 'sweta@aptask.com' });
    expect((await s.remind([s.sweta.id])).json()).toMatchObject({
      sent: 0,
      skipped: [{ id: s.sweta.id, reason: 'send_failed' }],
    });
    expect(s.db.updateReminderAudit).toHaveLength(0);
  });

  it('needs the push capability, a valid body and the mailbox', async () => {
    const s = await setup();
    const hr = await bearer(randomUUID(), [AppRole.HR]);
    expect((await s.remind([s.sweta.id], undefined, hr)).statusCode).toBe(403);
    const bad = await s.app.inject({
      method: 'POST',
      url: '/v1/admin/updates/remind',
      headers: { authorization: await bearer(s.admin.entraObjectId, [AppRole.Administrator]) },
      payload: { user_ids: ['x'], emails: ['a@b.c'] },
    });
    expect(bad.statusCode).toBe(400);
    const noMail = await setup({ mail: false });
    expect((await noMail.remind([noMail.sweta.id])).statusCode).toBe(503);
  });
});

describe('reminderMail', () => {
  it('lists every computer behind and asks for the newest version', () => {
    const m = reminderMail({
      to: 'a@aptask.com',
      name: '  Amit Bisht ',
      behind: [
        { os: 'windows', version: '0.1.40', latest: '0.1.46' },
        { os: 'macos', version: '0.1.44', latest: '0.1.47' },
      ],
      message: undefined,
      siteUrl: 'https://cloudpunch.aptask.com',
    });
    expect(m.subject).toBe('Please update CloudPunch to 0.1.47');
    expect(m.text.startsWith('Hi Amit,\n\nYour Windows PC has CloudPunch 0.1.40')).toBe(true);
    expect(m.text).toContain('Your Mac has CloudPunch 0.1.44; the latest is 0.1.47.');
    expect(m.text).toContain('Check for updates, then Restart to update');
  });
});
