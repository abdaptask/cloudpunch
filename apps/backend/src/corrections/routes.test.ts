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
import type { Employee } from '../db/index.js';
import { correctionRoutes } from './routes.js';

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'k1';
const H = 3_600_000;

let signer: KeyLike;
let jwks: JWTVerifyGetKey;
let db: InMemoryDb;

// Mona manages Roshni and is an Administrator; Nilesh is another
// Administrator; Sam has no manager; Hema is HR.
const mona = randomUUID();
const roshni = randomUUID();
const nilesh = randomUUID();
const sam = randomUUID();
const hema = randomUUID();
const oidOf: Record<string, string> = {};
const userOf: Record<string, string> = {};

const EMP = [AppRole.Employee];
const MGR_ADMIN = [AppRole.Employee, AppRole.Manager, AppRole.Administrator];
const ADMIN = [AppRole.Employee, AppRole.Administrator];
const HR = [AppRole.Employee, AppRole.HR];

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signer = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = KID;
  pub.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [pub] });
});

function person(id: string, name: string, managerId: string | null): Employee {
  return {
    id,
    source: 'local_admin',
    greythrEmployeeId: null,
    employeeNumber: null,
    givenName: name,
    familyName: 'Test',
    displayName: `${name} Test`,
    workEmail: `${name.toLowerCase()}@aptask.com`,
    status: 'active',
    reportingManagerId: managerId,
  };
}

beforeEach(() => {
  db = new InMemoryDb();
  const people: [string, string, string | null][] = [
    [mona, 'Mona', null],
    [roshni, 'Roshni', mona],
    [nilesh, 'Nilesh', mona],
    [sam, 'Sam', null],
    [hema, 'Hema', null],
  ];
  for (const [id, name, m] of people) {
    db.seedEmployee(person(id, name, m));
    const oid = randomUUID();
    const userId = randomUUID();
    oidOf[id] = oid;
    userOf[id] = userId;
    db.seedUser(
      {
        id: userId,
        entraObjectId: oid,
        workEmail: `${name.toLowerCase()}@aptask.com`,
        displayName: `${name} Test`,
        isServiceAccount: false,
        breakGlass: false,
        employeeId: id,
      },
      oid,
    );
  }
});

async function call(
  as: string,
  roles: readonly string[],
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    aud: CLIENT_ID,
    tid: TENANT_ID,
    oid: oidOf[as],
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
  await app.register(correctionRoutes, { db });
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

/** `hoursAgo` → an ISO string in IST, as the desktop would send it. */
function ist(hoursAgo: number): string {
  const at = new Date(Date.now() - hoursAgo * H + 330 * 60_000);
  return at.toISOString().slice(0, 19) + '+05:30';
}

const body = (fromH: number, toH: number, kind = 'working') => ({
  from: ist(fromH),
  to: ist(toH),
  tz_iana: 'Asia/Kolkata',
  kind,
  reason: 'The app did not record this',
});

interface Queue {
  to_endorse: { name: string; correction: { id: string; status: string } }[];
  to_approve: { name: string; correction: { id: string; status: string } }[];
}

const decide = (as: string, roles: readonly string[], id: string, decision: string) =>
  call(as, roles, 'POST', `/v1/corrections/${id}/decision`, { decision });

describe('a manager corrects a report; another Administrator approves (ADR-0030 §3)', () => {
  it('is endorsed at once, never approved by its author, approved by someone else', async () => {
    const res = await call(mona, MGR_ADMIN, 'POST', `/v1/team/${roshni}/corrections`, body(30, 22));
    expect(res.statusCode).toBe(201);
    const c = (res.json() as { correction: { id: string; status: string; from: string } })
      .correction;
    expect(c.status).toBe('endorsed');
    expect(c.from.endsWith('+05:30')).toBe(true);

    // Mona entered it: it isn't hers to approve.
    const monaQ = (await call(mona, MGR_ADMIN, 'GET', '/v1/corrections/queue')).json() as Queue;
    expect(monaQ.to_approve).toEqual([]);
    expect((await decide(mona, MGR_ADMIN, c.id, 'approve')).statusCode).toBe(409);

    const nileshQ = (await call(nilesh, ADMIN, 'GET', '/v1/corrections/queue')).json() as Queue;
    expect(nileshQ.to_approve.map((i) => [i.name, i.correction.id])).toEqual([
      ['Roshni Test', c.id],
    ]);
    const ok = await decide(nilesh, ADMIN, c.id, 'approve');
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { correction: { status: string } }).correction.status).toBe('approved');
    // Final: nothing more.
    expect((await decide(nilesh, ADMIN, c.id, 'reject')).statusCode).toBe(409);
    expect(db.correctionAudit.map((a) => a.action)).toEqual([
      'correction_requested',
      'correction_approved',
    ]);
  });

  it('only a direct manager may correct someone; HR and strangers get 404', async () => {
    expect(
      (await call(hema, HR, 'POST', `/v1/team/${roshni}/corrections`, body(30, 22))).statusCode,
    ).toBe(404);
    expect(
      (await call(mona, MGR_ADMIN, 'POST', `/v1/team/${sam}/corrections`, body(30, 22))).statusCode,
    ).toBe(404);
    expect(
      (await call(roshni, EMP, 'POST', `/v1/team/${nilesh}/corrections`, body(30, 22))).statusCode,
    ).toBe(403);
  });
});

describe('an employee asks', () => {
  it('their manager endorses, then an Administrator approves', async () => {
    const res = await call(roshni, EMP, 'POST', '/v1/me/corrections', body(30, 22));
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { correction: { id: string; status: string } }).correction.id;

    // Not at the Administrators yet: the manager endorses first.
    expect(
      ((await call(nilesh, ADMIN, 'GET', '/v1/corrections/queue')).json() as Queue).to_approve,
    ).toEqual([]);
    const monaQ = (await call(mona, MGR_ADMIN, 'GET', '/v1/corrections/queue')).json() as Queue;
    expect(monaQ.to_endorse.map((i) => i.correction.id)).toEqual([id]);
    expect((await decide(roshni, EMP, id, 'endorse')).statusCode).toBe(409);
    expect((await decide(mona, MGR_ADMIN, id, 'endorse')).statusCode).toBe(200);
    // The endorser can't approve it too.
    expect((await decide(mona, MGR_ADMIN, id, 'approve')).statusCode).toBe(409);
    expect((await decide(nilesh, ADMIN, id, 'approve')).statusCode).toBe(200);
  });

  it('with no manager it goes straight to an Administrator', async () => {
    const res = await call(sam, EMP, 'POST', '/v1/me/corrections', body(30, 22));
    const id = (res.json() as { correction: { id: string } }).correction.id;
    const q = (await call(nilesh, ADMIN, 'GET', '/v1/corrections/queue')).json() as Queue;
    expect(q.to_approve.map((i) => i.correction.id)).toEqual([id]);
  });

  it('an Administrator never approves a correction to their own time', async () => {
    const res = await call(nilesh, ADMIN, 'POST', '/v1/me/corrections', body(30, 22));
    const id = (res.json() as { correction: { id: string } }).correction.id;
    await decide(mona, MGR_ADMIN, id, 'endorse');
    expect((await decide(nilesh, ADMIN, id, 'approve')).statusCode).toBe(409);
  });

  it('the requester can withdraw; someone with no part gets 404', async () => {
    const res = await call(roshni, EMP, 'POST', '/v1/me/corrections', body(30, 22));
    const id = (res.json() as { correction: { id: string } }).correction.id;
    expect((await decide(sam, EMP, id, 'withdraw')).statusCode).toBe(404);
    expect((await decide(roshni, EMP, id, 'withdraw')).statusCode).toBe(200);
    expect((await decide(roshni, EMP, id, 'withdraw')).statusCode).toBe(409);
  });

  it('a manager can reject at endorsement', async () => {
    const res = await call(roshni, EMP, 'POST', '/v1/me/corrections', body(30, 22));
    const id = (res.json() as { correction: { id: string } }).correction.id;
    const r = await decide(mona, MGR_ADMIN, id, 'reject');
    expect((r.json() as { correction: { status: string } }).correction.status).toBe('rejected');
  });
});

describe('limits (ADR-0030 §5)', () => {
  const ask = (b: unknown) => call(roshni, EMP, 'POST', '/v1/me/corrections', b);
  const code = async (b: unknown) => ((await ask(b)).json() as { code: string }).code;

  it('refuses the future, over 16 hours, older than 30 days, unknown kinds and zones', async () => {
    expect(await code(body(2, -1))).toBe('in_future');
    expect(await code(body(40, 23))).toBe('too_long');
    expect(await code(body(33 * 24, 33 * 24 - 1))).toBe('too_old');
    expect(await code(body(30, 22, 'call_teams'))).toBe('validation');
    expect(await code({ ...body(30, 22), tz_iana: 'Mars/Base' })).toBe('validation');
    expect(await code({ ...body(30, 22), reason: '   ' })).toBe('validation');
    expect(await code(body(22, 30))).toBe('validation');
  });

  it('a new request may not overlap a pending one', async () => {
    expect((await ask(body(30, 22))).statusCode).toBe(201);
    const again = await ask(body(25, 20));
    expect(again.statusCode).toBe(409);
    expect((again.json() as { code: string }).code).toBe('overlaps_pending');
    expect((await ask(body(20, 19))).statusCode).toBe(201);
  });
});

describe('an Administrator corrects on someone’s behalf (ADR-0049)', () => {
  const url = (id: string) => `/v1/admin/employees/${id}/corrections`;

  it('counts at once, for anyone (not only their reports), today included, and is audited', async () => {
    // Nilesh is an Administrator who manages nobody; Sam has no manager.
    const res = await call(nilesh, ADMIN, 'POST', url(sam), body(3, 1, 'working'));
    expect(res.statusCode).toBe(201);
    const c = (
      res.json() as {
        correction: { id: string; status: string; decisions: { decision: string; by: string }[] };
      }
    ).correction;
    expect(c.status).toBe('approved');
    expect(c.decisions.map((d) => [d.decision, d.by])).toEqual([['approved', 'Nilesh Test']]);
    expect(db.correctionAudit.map((a) => [a.action, a.actorUserId])).toEqual([
      ['correction_requested', userOf[nilesh]],
      ['correction_approved', userOf[nilesh]],
    ]);
    // Nothing waits on anyone; it is on Sam's record.
    const q = (await call(mona, MGR_ADMIN, 'GET', '/v1/corrections/queue')).json() as Queue;
    expect([...q.to_approve, ...q.to_endorse]).toEqual([]);
    const listed = await db.corrections.listForEmployee(sam, new Date(0), new Date());
    expect(listed.map((x) => x.id)).toEqual([c.id]);
  });

  it('never their own time, and only for Administrators', async () => {
    const own = await call(nilesh, ADMIN, 'POST', url(nilesh), body(3, 1));
    expect(own.statusCode).toBe(409);
    expect((own.json() as { code: string }).code).toBe('own_time');
    expect((await call(roshni, EMP, 'POST', url(sam), body(3, 1))).statusCode).toBe(403);
    expect((await call(hema, HR, 'POST', url(sam), body(3, 1))).statusCode).toBe(403);
    expect((await call(nilesh, ADMIN, 'POST', url(randomUUID()), body(3, 1))).statusCode).toBe(404);
  });

  it('keeps the limits: never the future, nor over a pending request', async () => {
    const future = await call(nilesh, ADMIN, 'POST', url(sam), body(1, -1));
    expect((future.json() as { code: string }).code).toBe('in_future');
    expect((await call(sam, EMP, 'POST', '/v1/me/corrections', body(5, 3))).statusCode).toBe(201);
    const clash = await call(nilesh, ADMIN, 'POST', url(sam), body(4, 2));
    expect((clash.json() as { code: string }).code).toBe('overlaps_pending');
  });
});
