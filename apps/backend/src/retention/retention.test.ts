import { AppRole } from '@cloudpunch/shared';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose';
import { pino } from 'pino';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authPlugin } from '../auth/plugin.js';
import { InMemoryDb } from '../db/in-memory.js';
import { wallToUtc } from '../shifts/model.js';
import { RetentionJob } from './job.js';
import { retentionRoutes } from './routes.js';
import { RETENTION_FLOOR_DAYS, retentionDays, retentionSettings, yearsToDays } from './settings.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'k1';
const log = pino({ level: 'silent' });

let signer: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signer = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = KID;
  pub.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [pub] });
});

beforeEach(() => {
  db = new InMemoryDb();
});

async function setPolicy(retention: Record<string, unknown>) {
  await db.policies.put(
    {
      scope: 'global',
      scopeId: null,
      reason: null,
      actorUserId: randomUUID(),
      correlationId: randomUUID(),
      at: new Date(),
    },
    { retention },
  );
}

async function get(roles: readonly string[], url: string) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    aud: CLIENT_ID,
    tid: TENANT_ID,
    oid: randomUUID(),
    scp: 'api.access',
    roles,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signer);
  const app = Fastify();
  await app.register(authPlugin, {
    jwks,
    issuer: ISSUER,
    audience: CLIENT_ID,
    tenantId: TENANT_ID,
    requiredScope: 'api.access',
  });
  await app.register(retentionRoutes, { db });
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

describe('retention settings (ADR-0044 §1)', () => {
  it('off by default, with the proposed periods; years count leap days', async () => {
    expect(await retentionSettings(db)).toEqual({
      enabled: false,
      days: {
        time_records: 1827,
        idle_notes: 365,
        audit_log: 2557,
        notifications: 365,
        operational: 90,
      },
    });
    expect(yearsToDays(3)).toBe(1096);
  });

  it('never below a floor: out-of-range values fall back to the defaults', () => {
    const days = retentionDays({
      time_records_years: 3,
      idle_notes_days: 10,
      audit_log_years: 1,
      notifications_days: 120,
      operational_days: 30,
    });
    expect(days).toEqual({
      time_records: 1096,
      idle_notes: 365,
      audit_log: 2557,
      notifications: 120,
      operational: 30,
    });
    for (const [kind, d] of Object.entries(days)) {
      expect(d).toBeGreaterThanOrEqual(RETENTION_FLOOR_DAYS[kind as keyof typeof days]);
    }
  });
});

describe('RetentionJob (ADR-0044 §3)', () => {
  const ist = (hhmm: string, date = '2026-10-14') => wallToUtc(date, hhmm, 'Asia/Kolkata');
  const job = (at: () => Date) => new RetentionJob({ db, log, now: at });

  it('does nothing while switched off', async () => {
    expect(await job(() => ist('03:00')).runOnce()).toEqual({});
    expect(db.retentionCalls).toEqual([]);
  });

  it('once a day after 02:00 India time, each kind with its period, for real', async () => {
    await setPolicy({ enabled: true, idle_notes_days: 180 });
    db.retentionRows.idle_notes = 12;
    db.retentionRows.audit_log = 3;
    let now = ist('01:59');
    const j = job(() => now);
    expect(await j.runOnce()).toEqual({});
    now = ist('02:00');
    expect(await j.runOnce()).toEqual({
      time_records: 0,
      idle_notes: 12,
      audit_log: 3,
      notifications: 0,
      operational: 0,
    });
    expect(db.retentionCalls).toEqual([
      { kind: 'time_records', days: 1827, dryRun: false },
      { kind: 'idle_notes', days: 180, dryRun: false },
      { kind: 'audit_log', days: 2557, dryRun: false },
      { kind: 'notifications', days: 365, dryRun: false },
      { kind: 'operational', days: 90, dryRun: false },
    ]);
    // Not again the same day; again the next.
    now = ist('09:00');
    expect(await j.runOnce()).toEqual({});
    now = ist('02:30', '2026-10-15');
    expect(Object.keys(await j.runOnce())).toHaveLength(5);
  });

  it('one kind failing does not stop the others', async () => {
    await setPolicy({ enabled: true });
    const purge = db.retention.purge.bind(db.retention);
    db.retention.purge = async (kind, days, dryRun) => {
      if (kind === 'audit_log') throw new Error('database down');
      return purge(kind, days, dryRun);
    };
    const removed = await job(() => ist('02:10')).runOnce();
    expect(Object.keys(removed)).toEqual([
      'time_records',
      'idle_notes',
      'notifications',
      'operational',
    ]);
  });
});

describe('GET /v1/admin/retention/preview (ADR-0044 §3)', () => {
  it('Administrators see what would go, for the saved or the asked periods; nothing is removed', async () => {
    db.retentionRows.idle_notes = 40;
    db.retentionRows.time_records = 7;
    const saved = await get([AppRole.Administrator], '/v1/admin/retention/preview');
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      enabled: false,
      kinds: [
        { kind: 'time_records', days: 1827, rows: 7 },
        { kind: 'idle_notes', days: 365, rows: 40 },
        { kind: 'audit_log', days: 2557, rows: 0 },
        { kind: 'notifications', days: 365, rows: 0 },
        { kind: 'operational', days: 90, rows: 0 },
      ],
    });
    const asked = await get(
      [AppRole.Administrator],
      '/v1/admin/retention/preview?time_records_years=3&idle_notes_days=90&audit_log_years=3&notifications_days=120&operational_days=30',
    );
    expect((asked.json() as { kinds: { days: number }[] }).kinds.map((k) => k.days)).toEqual([
      1096, 90, 1096, 120, 30,
    ]);
    expect(db.retentionCalls.every((c) => c.dryRun)).toBe(true);
    expect(db.retentionRows.idle_notes).toBe(40);
  });

  it('refuses a period below its floor, and anyone but an Administrator', async () => {
    const low = await get(
      [AppRole.Administrator],
      '/v1/admin/retention/preview?idle_notes_days=30',
    );
    expect(low.statusCode).toBe(400);
    expect((await get([AppRole.HR], '/v1/admin/retention/preview')).statusCode).toBe(403);
    expect(db.retentionCalls).toEqual([]);
  });
});
