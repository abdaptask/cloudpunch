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
import type { ShiftMail } from '../alerts/mail.js';
import { authPlugin } from '../auth/plugin.js';
import { InMemoryDb } from '../db/in-memory.js';
import type { DayRow, DayStatus } from '../reports/day.js';
import { followUpNote, ManagerNotesJob } from './job.js';
import { managerNoteRoutes } from './routes.js';
import { compare, followUpMail, noteMail, summaryOf, type NoteSummary } from './summary.js';

const H = 3_600_000;

function row(date: string, status: DayStatus, over: Partial<DayRow> = {}): DayRow {
  return {
    employee_id: 'e1',
    name: 'Zuhaib Mir',
    manager_id: null,
    date,
    status,
    shift:
      status === 'off' ? null : { start: `${date}T03:30:00.000Z`, end: `${date}T12:30:00.000Z` },
    tz: 'Asia/Kolkata',
    clock_in: status === 'worked' || status === 'late' ? `${date}T03:40:00.000Z` : null,
    clock_out: status === 'worked' || status === 'late' ? `${date}T12:35:00.000Z` : null,
    still_in: false,
    minutes_late: status === 'late' ? 40 : null,
    worked_ms: status === 'worked' || status === 'late' ? 8 * H : 0,
    shift_ms: status === 'off' ? 0 : 9 * H,
    idle_ms: 0,
    breaks_ms: 0,
    breaks_over_limit: 0,
    away_ms: 0,
    corrections_waiting: 0,
    segments: [],
    ...over,
  };
}

const day = (n: number): string => `2026-10-${String(n).padStart(2, '0')}`;

describe('summary and follow-up (ADR-0055 §3, §5)', () => {
  const before = summaryOf(
    [
      row(day(1), 'late', { idle_ms: 2 * H, breaks_over_limit: 2 }),
      row(day(2), 'late', { idle_ms: 2 * H }),
      row(day(3), 'worked'),
      row(day(4), 'not_clocked_in'),
      row(day(5), 'holiday'),
      row(day(6), 'off'),
    ],
    day(1),
    day(14),
  );

  it('counts on time, late, missed, hours, idle and long breaks; holidays and days off left out', () => {
    expect(before).toMatchObject({
      shift_days: 4,
      on_time: 1,
      late: 2,
      missed: 1,
      worked_days: 3,
      worked_ms: 24 * H,
      scheduled_ms: 36 * H,
      idle_ms: 4 * H,
      breaks_over: 2,
    });
    expect(before.days.map((d) => d.status)).toEqual([
      'late',
      'late',
      'worked',
      'not_clocked_in',
      'holiday',
      'off',
    ]);
  });

  it('improved, worse, or no change, on the topics chosen', () => {
    const better = summaryOf(
      [row(day(15), 'worked'), row(day(16), 'worked'), row(day(17), 'worked')],
      day(15),
      day(28),
    );
    const r = compare(['timings', 'activity', 'breaks', 'missed'], before, better);
    expect(r.topics.map((t) => [t.topic, t.change])).toEqual([
      ['timings', 'better'],
      ['activity', 'better'],
      ['breaks', 'better'],
      ['missed', 'better'],
    ]);
    expect(r.verdict).toBe('improved');
    expect(r.after).not.toHaveProperty('days');

    const worse = summaryOf(
      [row(day(15), 'late'), row(day(16), 'not_clocked_in'), row(day(17), 'not_clocked_in')],
      day(15),
      day(28),
    );
    expect(compare(['timings', 'missed'], before, worse).verdict).toBe('worse');
    // One fewer long break is a whole break: better.
    expect(
      compare(
        ['breaks'],
        before,
        summaryOf([row(day(15), 'worked', { breaks_over_limit: 1 })], day(15), day(28)),
      ).topics[0]?.change,
    ).toBe('better');
    expect(compare(['activity'], before, before).verdict).toBe('no_change');
    // Nothing worked after: can't tell, so no change.
    const none = summaryOf([row(day(15), 'off')], day(15), day(28));
    const unknown = compare(['activity'], before, none);
    expect(unknown.topics[0]?.change).toBe('unknown');
    expect(unknown.verdict).toBe('no_change');
  });

  it('the email to the manager: the message, the numbers, day by day, and not to the person', () => {
    const m = noteMail({
      person: 'Zuhaib Mir',
      personFirst: 'Zuhaib',
      manager: 'Ravindra Poojari',
      managerFirst: 'Ravindra',
      sender: 'Abdulla Sheikh',
      topics: ['activity', 'timings'],
      message: 'His idle time has been climbing; please check in with him this week.',
      summary: before,
      followUpOn: day(25),
      siteUrl: 'https://cloudpunch.aptask.com/',
    });
    expect(m.subject).toBe('Please keep an eye on Zuhaib Mir');
    expect(m.text).toContain('Hi Ravindra,');
    expect(m.text).toContain(
      "Abdulla Sheikh has asked you to keep an eye on Zuhaib Mir's activity level, start and finish times.",
    );
    expect(m.text).toContain('His idle time has been climbing');
    expect(m.text).toContain('- On time: 1 of 4 shift days (2 late, 1 missed)');
    expect(m.text).toContain('- Idle: 4h 00m (17% of worked time)');
    expect(m.text).toContain(
      'Thu 1 Oct   09:10–18:05 (late 40 min), 8h 00m worked, idle 2h 00m, 2 long break(s)',
    );
    expect(m.text).toContain('Sun 4 Oct   missed (no clock-in)');
    expect(m.text).toContain('https://cloudpunch.aptask.com/app/');
    expect(m.text).toContain("Zuhaib doesn't get it.");
  });

  it('the follow-up email: each topic before and after, and the verdict', () => {
    const after = summaryOf([row(day(15), 'worked'), row(day(16), 'worked')], day(15), day(28));
    const m = followUpMail({
      person: 'Zuhaib Mir',
      manager: 'Ravindra Poojari',
      senderFirst: 'Abdulla',
      sentOn: day(14),
      seenOn: day(15),
      result: compare(['timings'], before, after),
      siteUrl: 'https://cloudpunch.aptask.com',
    });
    expect(m.subject).toBe('Follow-up on Zuhaib Mir: Improved');
    expect(m.text).toContain('Ravindra Poojari marked it seen on Thu 15 Oct.');
    expect(m.text).toContain('- Start and finish times: 25% on time -> 100% on time (better)');
  });
});

// ---------------------------------------------------------------------
// Routes and the follow-up job
// ---------------------------------------------------------------------

const TENANT_ID = '12345678-1234-1234-1234-123456789012';
const CLIENT_ID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'k1';
let signer: KeyLike;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signer = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = KID;
  pub.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [pub] });
});

describe('Tell manager routes (ADR-0055 §1–4, §7)', () => {
  let db: InMemoryDb;
  let outbox: ShiftMail[];
  const ids: Record<string, { emp: string; oid: string; user: string }> = {};

  beforeEach(() => {
    db = new InMemoryDb();
    outbox = [];
    for (const [name, manager] of [
      ['Ravindra', null],
      ['Zuhaib', 'Ravindra'],
      ['Mona', null],
      ['Solo', null],
      ['Abdulla', null],
    ] as const) {
      const emp = randomUUID();
      const oid = randomUUID();
      const user = randomUUID();
      ids[name] = { emp, oid, user };
      db.seedEmployee({
        id: emp,
        source: 'local_admin',
        greythrEmployeeId: null,
        employeeNumber: null,
        givenName: name,
        familyName: 'Test',
        displayName: `${name} Test`,
        workEmail: `${name.toLowerCase()}@aptask.com`,
        status: 'active',
        reportingManagerId: manager ? (ids[manager]?.emp ?? null) : null,
      });
      db.seedUser(
        {
          id: user,
          entraObjectId: oid,
          workEmail: `${name.toLowerCase()}@aptask.com`,
          displayName: `${name} Test`,
          isServiceAccount: false,
          breakGlass: false,
          employeeId: emp,
        },
        oid,
      );
    }
  });

  async function call(
    as: string,
    roles: string[],
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    mail = true,
  ) {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      aud: CLIENT_ID,
      tid: TENANT_ID,
      oid: ids[as]!.oid,
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
    await app.register(managerNoteRoutes, {
      db,
      send: mail
        ? async (m) => {
            outbox.push(m);
          }
        : null,
      siteUrl: 'https://cloudpunch.aptask.com',
    });
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
  }

  const zuhaibNotes = () => `/v1/admin/people/${ids['Zuhaib']!.emp}/manager-notes`;
  const NOTE = {
    topics: ['timings', 'activity'],
    message: 'Please keep an eye on his start times and idle time.',
  };

  it('HR sees the manager and the 14 days, then sends: to the manager only, sender copied, recorded', async () => {
    const before = await call('Abdulla', [AppRole.HR], 'GET', zuhaibNotes());
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      name: 'Zuhaib Test',
      manager: { id: ids['Ravindra']!.emp, name: 'Ravindra Test' },
      blocked: null,
      follow_up_days: 14,
      notes: [],
    });
    expect((before.json() as { summary: NoteSummary }).summary.days).toHaveLength(14);

    const res = await call('Abdulla', [AppRole.Administrator], 'POST', zuhaibNotes(), NOTE);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: 'Zuhaib Test',
      manager_name: 'Ravindra Test',
      sent_by: 'Abdulla Test',
      // Topics in a fixed order.
      topics: ['activity', 'timings'],
      seen_at: null,
      follow_up: null,
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      to: ['ravindra@aptask.com'],
      cc: ['abdulla@aptask.com'],
      subject: 'Please keep an eye on Zuhaib Test',
    });
    expect(outbox[0]?.text).toContain('Please keep an eye on his start times and idle time.');
    expect(outbox.flatMap((m) => [...m.to, ...m.cc])).not.toContain('zuhaib@aptask.com');
    // In the person's change history (HR, Administrators, Auditors).
    expect(db.auditRows.map((r) => [r.action, r.entityId])).toEqual([
      ['manager_note_sent', ids['Zuhaib']!.emp],
    ]);
    const list = await call('Abdulla', [AppRole.HR], 'GET', zuhaibNotes());
    expect((list.json() as { notes: unknown[] }).notes).toHaveLength(1);
  });

  it('only HR and Administrators send; checks who it is about and who it goes to', async () => {
    expect((await call('Mona', [AppRole.Manager], 'POST', zuhaibNotes(), NOTE)).statusCode).toBe(
      403,
    );
    expect((await call('Zuhaib', [AppRole.Employee], 'GET', zuhaibNotes())).statusCode).toBe(403);
    const solo = `/v1/admin/people/${ids['Solo']!.emp}/manager-notes`;
    expect((await call('Abdulla', [AppRole.HR], 'GET', solo)).json()).toMatchObject({
      manager: null,
      blocked: 'no_manager',
    });
    const none = await call('Abdulla', [AppRole.HR], 'POST', solo, NOTE);
    expect([none.statusCode, (none.json() as { code: string }).code]).toEqual([409, 'no_manager']);
    // The manager can't send it to themselves.
    const own = await call('Ravindra', [AppRole.HR], 'POST', zuhaibNotes(), NOTE);
    expect([own.statusCode, (own.json() as { code: string }).code]).toEqual([409, 'own_manager']);
    const short = await call('Abdulla', [AppRole.HR], 'POST', zuhaibNotes(), {
      topics: [],
      message: 'Too short',
    });
    expect(short.statusCode).toBe(400);
    const noMail = await call('Abdulla', [AppRole.HR], 'POST', zuhaibNotes(), NOTE, false);
    expect(noMail.statusCode).toBe(503);
    expect(db.managerNoteRows).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it('the manager sees it in Team and marks it seen; nobody else can, and the person never sees it', async () => {
    const sent = await call('Abdulla', [AppRole.HR], 'POST', zuhaibNotes(), NOTE);
    const id = (sent.json() as { id: string }).id;
    const mine = await call('Ravindra', [AppRole.Manager], 'GET', '/v1/team/manager-notes');
    expect((mine.json() as { notes: { id: string; name: string }[] }).notes).toMatchObject([
      { id, name: 'Zuhaib Test' },
    ]);
    for (const who of ['Zuhaib', 'Mona'] as const) {
      const r = await call(who, [AppRole.Manager], 'GET', '/v1/team/manager-notes');
      expect((r.json() as { notes: unknown[] }).notes).toEqual([]);
      const seen = await call(who, [AppRole.Manager], 'POST', `/v1/team/manager-notes/${id}/seen`);
      expect(seen.statusCode).toBe(404);
    }
    const seen = await call(
      'Ravindra',
      [AppRole.Manager],
      'POST',
      `/v1/team/manager-notes/${id}/seen`,
    );
    expect(seen.json()).toMatchObject({ changed: true });
    const again = await call(
      'Ravindra',
      [AppRole.Manager],
      'POST',
      `/v1/team/manager-notes/${id}/seen`,
    );
    expect(again.json()).toMatchObject({ changed: false });
    expect(db.auditRows.map((r) => r.action)).toEqual(['manager_note_sent', 'manager_note_seen']);
  });

  it('follow-up after 14 days: emailed once to the sender, manager copied', async () => {
    const before = summaryOf([], day(1), day(14));
    const note = await db.managerNotes.create({
      employeeId: ids['Zuhaib']!.emp,
      managerId: ids['Ravindra']!.emp,
      sentBy: ids['Abdulla']!.user,
      topics: ['timings'],
      message: 'Please keep an eye on his start times.',
      summary: before,
      sentAt: new Date('2026-10-15T05:00:00Z'),
      followUpOn: '2026-10-29',
      correlationId: randomUUID(),
    });
    const send = async (m: ShiftMail) => {
      outbox.push(m);
    };
    const at = new Date('2026-10-29T03:00:00Z');
    expect(await db.managerNotes.due('2026-10-28')).toHaveLength(0);
    expect(await db.managerNotes.due('2026-10-29')).toHaveLength(1);
    expect(await followUpNote(db, note, send, 'https://x', at)).toBe(true);
    expect(await followUpNote(db, note, send, 'https://x', at)).toBe(false);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      to: ['abdulla@aptask.com'],
      cc: ['ravindra@aptask.com'],
      subject: 'Follow-up on Zuhaib Test: No change',
    });
    expect(outbox[0]?.text).toContain("Ravindra Test hasn't marked it seen in CloudPunch.");
    expect(db.managerNoteRows[0]?.followUp).toMatchObject({ verdict: 'no_change' });
    expect(db.auditRows.map((r) => r.action)).toEqual([
      'manager_note_sent',
      'manager_note_followed_up',
    ]);
    expect(await db.managerNotes.due('2026-10-30')).toHaveLength(0);
  });

  it('a failed send leaves it due for the next run', async () => {
    const note = await db.managerNotes.create({
      employeeId: ids['Zuhaib']!.emp,
      managerId: ids['Ravindra']!.emp,
      sentBy: ids['Abdulla']!.user,
      topics: ['missed'],
      message: 'Please keep an eye on missed days.',
      summary: summaryOf([], day(1), day(14)),
      sentAt: new Date('2026-10-15T05:00:00Z'),
      followUpOn: '2026-10-29',
      correlationId: randomUUID(),
    });
    await expect(
      followUpNote(
        db,
        note,
        () => Promise.reject(new Error('smtp down')),
        'https://x',
        new Date('2026-10-29T03:00:00Z'),
      ),
    ).rejects.toThrow('smtp down');
    expect(await db.managerNotes.due('2026-10-29')).toHaveLength(1);
  });

  it('the job runs from 08:15 India time, once a day', async () => {
    let now = new Date('2026-10-29T02:00:00Z'); // 07:30 India
    const job = new ManagerNotesJob({
      db,
      log: { info: () => undefined, warn: () => undefined } as never,
      send: async (m) => {
        outbox.push(m);
      },
      siteUrl: 'https://x',
      now: () => now,
    });
    expect(await job.runOnce()).toBeNull();
    now = new Date('2026-10-29T03:00:00Z'); // 08:30 India
    expect(await job.runOnce()).toBe(0);
    expect(await job.runOnce()).toBeNull();
  });
});
