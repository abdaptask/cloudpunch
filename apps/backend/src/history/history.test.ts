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
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authPlugin } from '../auth/plugin.js';
import { InMemoryDb } from '../db/in-memory.js';
import type { AuditEntry } from '../db/index.js';
import { describePerson, describePolicy, weekdays } from './describe.js';
import { historyRoutes } from './routes.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'k1';

let signer: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;

const roshni = randomUUID();
const nilesh = randomUUID();
const roshniOid = randomUUID();
const dept = randomUUID();

const row = (over: Partial<AuditEntry>): AuditEntry => ({
  at: new Date('2026-10-13T10:00:00Z'),
  actorName: 'Abdulla Sheikh',
  action: 'x',
  entityType: 'employee',
  entityId: roshni,
  before: null,
  after: null,
  reason: null,
  ...over,
});

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
  for (const [id, name, oid] of [
    [roshni, 'Roshni', roshniOid],
    [nilesh, 'Nilesh', null],
  ] as const) {
    db.seedEmployee({
      id,
      source: 'local_admin',
      greythrEmployeeId: null,
      employeeNumber: null,
      givenName: name,
      familyName: 'Test',
      displayName: `${name} Test`,
      workEmail: `${name.toLowerCase()}@aptask.com`,
      status: 'active',
      reportingManagerId: null,
      entraObjectId: oid,
    });
  }
});

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
  await app.register(historyRoutes, { db });
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

describe('change history in words (ADR-0038 §8)', () => {
  it('each kind of change to a person', () => {
    const names = new Map([[nilesh, 'Nilesh Test']]);
    const say = (over: Partial<AuditEntry>) => describePerson(row(over), names);
    expect(
      say({
        action: 'reporting_manager_set',
        before: { manager_employee_id: null },
        after: { manager_employee_id: nilesh },
      }),
    ).toBe('Manager: none → Nilesh Test');
    expect(
      say({
        action: 'roles_set',
        before: { roles: ['Employee'] },
        after: { roles: ['Employee', 'Manager'] },
      }),
    ).toBe('Roles: Employee → Employee, Manager');
    expect(
      say({
        action: 'shift_assigned',
        after: {
          days: [1, 2, 3, 4, 5],
          start: '09:00',
          end: '18:00',
          tz_iana: 'Asia/Kolkata',
          effective_from: '2026-10-12',
        },
      }),
    ).toBe('Shift: Mon–Fri 09:00–18:00 (Asia/Kolkata), from 2026-10-12');
    expect(
      say({
        action: 'shift_assigned',
        after: { days: [], start: null, end: null, effective_from: '2026-10-12' },
      }),
    ).toBe('Shift: no shift, from 2026-10-12');
    expect(
      say({
        action: 'office_pattern_set',
        after: { weekdays: [2, 4], effective_from: '2026-10-13' },
      }),
    ).toBe('Office days: Tue, Thu, from 2026-10-13');
    expect(say({ action: 'office_day_set', after: { date: '2026-10-14', in_office: false } })).toBe(
      'Not in the office on 2026-10-14',
    );
    expect(
      say({ action: 'status_set', before: { status: 'active' }, after: { status: 'inactive' } }),
    ).toBe('Record: active → inactive');
    expect(weekdays([7, 6])).toBe('Sat, Sun');
  });

  it('a settings save lists the values it changed', () => {
    const save = (before: unknown, after: unknown) =>
      describePolicy(
        row({
          action: 'policy_set',
          entityType: 'policy_override',
          before: before === null ? null : { scope: 'global', document: before },
          after: { scope: 'global', document: after },
        }),
      );
    expect(
      save(
        { alerts: { shift_emails: false }, idle: { threshold_seconds: 120 } },
        {
          alerts: { shift_emails: true },
          idle: { threshold_seconds: 120 },
          reports: { day_emails: true },
        },
      ),
    ).toBe('alerts.shift_emails: off → on; reports.day_emails: not set → on');
    expect(save({ a: 1 }, { a: 1 })).toBe('Saved with no changes');
    expect(describePolicy(row({ action: 'policy_clear', entityType: 'policy_override' }))).toBe(
      'Settings removed (back to the company values)',
    );
  });
});

describe('GET history (ADR-0038 §8)', () => {
  it("a person's changes, newest first: roles by Entra id, computers, never the views", async () => {
    const device = randomUUID();
    db.deviceOwners.set(device, roshni);
    db.auditRows.push(
      row({ action: 'status_set', before: { status: 'inactive' }, after: { status: 'active' } }),
      row({ action: 'day_viewed', after: { date: '2026-10-12' } }),
      row({
        at: new Date('2026-10-13T11:00:00Z'),
        action: 'roles_set',
        entityType: 'app_role_assignment',
        entityId: roshniOid,
        before: { roles: [] },
        after: { roles: ['Employee'] },
        reason: 'joined',
      }),
      row({
        at: new Date('2026-10-13T09:00:00Z'),
        action: 'device_signed_out',
        entityType: 'device',
        entityId: device,
      }),
      row({ action: 'status_set', entityId: nilesh }),
    );
    const res = await get([AppRole.HR], `/v1/admin/employees/${roshni}/history`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      entries: [
        {
          at: '2026-10-13T11:00:00.000Z',
          by: 'Abdulla Sheikh',
          action: 'roles_set',
          summary: 'Roles: none → Employee',
          reason: 'joined',
        },
        expect.objectContaining({ summary: 'Record: inactive → active' }),
        expect.objectContaining({ summary: 'Signed out of a computer' }),
      ],
    });
    expect((await get([AppRole.Manager], `/v1/admin/employees/${roshni}/history`)).statusCode).toBe(
      403,
    );
    expect(
      (await get([AppRole.HR], `/v1/admin/employees/${randomUUID()}/history`)).statusCode,
    ).toBe(404);
  });

  it('settings history per scope, with a limit', async () => {
    for (let i = 0; i < 3; i++) {
      db.auditRows.push(
        row({
          at: new Date(Date.UTC(2026, 9, 10 + i)),
          action: 'policy_set',
          entityType: 'policy_override',
          entityId: null,
          before: { scope: 'global', document: { idle: { threshold_seconds: 120 + i } } },
          after: { scope: 'global', document: { idle: { threshold_seconds: 121 + i } } },
        }),
      );
    }
    db.auditRows.push(
      row({
        action: 'policy_set',
        entityType: 'policy_override',
        entityId: dept,
        after: { scope: 'department', document: { away: { offer_training: false } } },
      }),
    );
    const global = await get([AppRole.Administrator], '/v1/admin/policy/global/history?limit=2');
    expect(
      (global.json() as { entries: { summary: string }[] }).entries.map((e) => e.summary),
    ).toEqual(['idle.threshold_seconds: 122 → 123', 'idle.threshold_seconds: 121 → 122']);
    const d = await get([AppRole.HR], `/v1/admin/policy/departments/${dept}/history`);
    expect((d.json() as { entries: { summary: string }[] }).entries.map((e) => e.summary)).toEqual([
      'away.offer_training: not set → off',
    ]);
    expect((await get([AppRole.Employee], '/v1/admin/policy/global/history')).statusCode).toBe(403);
  });
});
