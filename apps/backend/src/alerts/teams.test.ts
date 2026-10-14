import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryDb } from '../db/in-memory.js';
import type { Employee } from '../db/index.js';
import type { TeamsPost } from '../ops/teams.js';
import { wallToUtc } from '../shifts/model.js';
import { TeamsNotices } from './teams.js';

const log = pino({ level: 'silent' });
const nilesh = randomUUID();
const roshni = randomUUID();
const amit = randomUUID();
const farheen = randomUUID();

let db: InMemoryDb;
let posts: TeamsPost[];
let failPost: boolean;

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

const notices = () =>
  new TeamsNotices({
    db,
    log,
    siteUrl: 'https://cloudpunch.aptask.com',
    post: async (p) => {
      if (failPost) throw new Error('webhook down');
      posts.push(p);
    },
  });

async function teamsPosts(on: boolean) {
  await db.policies.put(
    {
      scope: 'global',
      scopeId: null,
      reason: null,
      actorUserId: randomUUID(),
      correlationId: randomUUID(),
      at: new Date(),
    },
    { alerts: { shift_emails: true, teams_posts: on } },
  );
}

async function correction(employeeId: string, endorse: boolean) {
  const from = new Date(Date.now() - 3 * 86_400_000);
  await db.corrections.request({
    employeeId,
    fromAt: from,
    toAt: new Date(from.getTime() + 3_600_000),
    tzIana: 'Asia/Kolkata',
    utcOffsetMinutes: 330,
    kind: 'working',
    reason: 'forgot',
    requestedByUserId: randomUUID(),
    endorse,
    correlationId: randomUUID(),
    at: new Date(),
  });
}

beforeEach(() => {
  db = new InMemoryDb();
  posts = [];
  failPost = false;
  db.seedEmployee(person(nilesh, 'Nilesh', null));
  db.seedEmployee(person(roshni, 'Roshni', nilesh));
  db.seedEmployee(person(amit, 'Amit', nilesh));
  db.seedEmployee(person(farheen, 'Farheen', null));
});

describe('shift-start notices in Teams (ADR-0043 §3)', () => {
  it('only while alerts.teams_posts is on; the email’s words, no notes', async () => {
    const n = {
      kind: 'missed' as const,
      person: person(roshni, 'Roshni', nilesh),
      start: wallToUtc('2026-10-14', '09:00', 'Asia/Kolkata'),
      tz: 'Asia/Kolkata',
      clockIn: null,
      graceMinutes: 15,
    };
    expect(await notices().shiftAlert(n)).toBe(false);
    await teamsPosts(true);
    expect(await notices().shiftAlert(n)).toBe(true);
    expect(posts[0]).toMatchObject({
      title: 'Not clocked in: Roshni Test, shift 09:00 GMT+5:30',
      attention: true,
      link: { url: 'https://cloudpunch.aptask.com/app/' },
    });
    expect(posts[0]?.lines[0]).toContain("Roshni Test hasn't clocked in.");
    failPost = true;
    expect(await notices().shiftAlert(n)).toBe(false);
  });
});

describe('corrections waiting in Teams (ADR-0043 §3)', () => {
  const ist = (hhmm: string) => wallToUtc('2026-10-14', hhmm, 'Asia/Kolkata');

  it('from 10:00 India time, once a day, by who has to act', async () => {
    await teamsPosts(true);
    await correction(roshni, false);
    await correction(roshni, false);
    await correction(amit, true);
    await correction(farheen, false);
    const t = notices();
    expect(await t.correctionsDigest(ist('09:59'))).toBe(false);
    expect(await t.correctionsDigest(ist('10:00'))).toBe(true);
    expect(posts).toEqual([
      expect.objectContaining({
        title: 'Corrections waiting: 4',
        facts: [
          { title: 'Nilesh Test (to endorse)', value: 'Roshni Test 2' },
          { title: 'Administrators (to approve)', value: 'Amit Test 1, Farheen Test 1' },
        ],
      }),
    ]);
    // Again, and from a second server: once a day.
    expect(await t.correctionsDigest(ist('10:05'))).toBe(false);
    expect(await notices().correctionsDigest(ist('10:05'))).toBe(false);
    expect(posts).toHaveLength(1);
  });

  it('nothing waiting or switched off: no post; a failed post is tried again', async () => {
    await teamsPosts(true);
    expect(await notices().correctionsDigest(ist('10:00'))).toBe(false);
    await correction(farheen, false);
    await teamsPosts(false);
    expect(await notices().correctionsDigest(ist('10:00'))).toBe(false);
    await teamsPosts(true);
    failPost = true;
    const t = notices();
    expect(await t.correctionsDigest(ist('10:00'))).toBe(false);
    failPost = false;
    expect(await t.correctionsDigest(ist('10:01'))).toBe(true);
    expect(posts).toHaveLength(1);
  });
});
