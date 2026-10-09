import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryDb } from '../db/in-memory.js';
import type { Employee } from '../db/index.js';
import { activeWindow, wallToUtc } from '../shifts/model.js';
import { teamNow } from '../team/service.js';
import { ShiftAlertJob } from './job.js';
import { clockIn, shiftMailText, zoneName, type ShiftMail } from './mail.js';
import { dueAlerts, firstClockInFor } from './rules.js';

const MIN = 60_000;
const log = pino({ level: 'silent' });

let db: InMemoryDb;
let clock: Date;
let outbox: ShiftMail[];
let failNext: boolean;

const roshni = randomUUID();
const farheen = randomUUID();
const nilesh = randomUUID();
const admin = randomUUID();

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

function job(): ShiftAlertJob {
  return new ShiftAlertJob({
    db,
    log,
    siteUrl: 'https://cloudpunch.aptask.com',
    now: () => clock,
    send: async (m) => {
      if (failNext) {
        failNext = false;
        throw new Error('Graph down');
      }
      outbox.push(m);
    },
  });
}

async function setting(on: boolean, grace?: number) {
  await db.policies.put(
    {
      scope: 'global',
      scopeId: null,
      reason: null,
      actorUserId: randomUUID(),
      correlationId: randomUUID(),
      at: clock,
    },
    { alerts: { shift_emails: on, ...(grace ? { missed_clock_in_minutes: grace } : {}) } },
  );
}

/** A weekday 08:00–17:00 New York shift for `id`. */
async function shift(id: string) {
  await db.shifts.assign({
    employeeId: id,
    days: [1, 2, 3, 4, 5, 6, 7],
    start: '08:00',
    end: '17:00',
    tzIana: 'America/New_York',
    effectiveFrom: '2026-01-01',
    reason: null,
    assignedByUserId: 'test',
    correlationId: randomUUID(),
    at: clock,
  });
}

/** A clock-in for `id` at `at`, still open. */
async function clockInAt(id: string, at: Date) {
  const session = await db.timeSessions.open({
    employeeId: id,
    deviceId: randomUUID(),
    openedAt: at,
  });
  await db.timeEvents.insertOne({
    sessionId: session.id,
    employeeId: id,
    monotonicNs: 0,
    tzIana: 'America/New_York',
    utcOffsetMinutes: -240,
    deviceId: session.deviceId,
    appVersion: '0.1.25',
    origin: 'user',
    offlineCaptured: false,
    integritySignature: new Uint8Array(64),
    correlationId: randomUUID(),
    parentEventUlid: null,
    eventUlid: randomUUID(),
    eventType: 'USER_CLOCK_IN',
    sequenceNumber: 1,
    clientTs: at,
    payload: {},
  });
}

// Fri 9 Oct 2026, 08:00 EDT.
const START = wallToUtc('2026-10-09', '08:00', 'America/New_York');
const at = (minutes: number) => new Date(START.getTime() + minutes * MIN);

beforeEach(async () => {
  db = new InMemoryDb();
  clock = at(0);
  outbox = [];
  failNext = false;
  db.seedEmployee(person(nilesh, 'Nilesh', null));
  db.seedEmployee(person(roshni, 'Roshni', nilesh));
  db.seedEmployee(person(farheen, 'Farheen', null));
  db.seedEmployee(person(admin, 'Abdulla', null));
  // The Administrator's sign-in, as the role hook would note it.
  const adminOid = randomUUID();
  db.seedUser(
    {
      id: randomUUID(),
      entraObjectId: adminOid,
      workEmail: 'abdulla@aptask.com',
      displayName: 'Abdulla Test',
      isServiceAccount: false,
      breakGlass: false,
      employeeId: admin,
    },
    adminOid,
  );
  await db.roles.note(adminOid, ['Employee', 'Administrator'], 'token', clock);
  await shift(roshni);
  await shift(farheen);
});

describe('due alerts (ADR-0037 §3)', () => {
  it('missed after the grace, then late once they clock in; never on a holiday', async () => {
    await shift(nilesh);
    const rows = await db.shifts.history([roshni]);
    const window = activeWindow(rows, at(20));
    if (!window) throw new Error('no window');
    const base = {
      window,
      holiday: false,
      saidNotWorking: false,
      firstClockIn: null,
      sent: new Set<never>(),
    };
    expect(dueAlerts(base, at(14), 15)).toEqual([]);
    expect(dueAlerts(base, at(15), 15)).toEqual(['missed']);
    expect(dueAlerts({ ...base, holiday: true }, at(15), 15)).toEqual([]);
    expect(dueAlerts({ ...base, saidNotWorking: true }, at(15), 15)).toEqual(['not_working']);
    expect(
      dueAlerts({ ...base, firstClockIn: at(40), sent: new Set(['missed'] as const) }, at(41), 15),
    ).toEqual(['late_clock_in']);
    // On time: nothing, ever.
    expect(dueAlerts({ ...base, firstClockIn: at(5) }, at(60), 15)).toEqual([]);
    expect(
      firstClockInFor(window, [
        { clockIn: at(-600), end: at(-500) },
        { clockIn: at(40), end: at(90) },
        { clockIn: at(30), end: at(35) },
      ]),
    ).toEqual(at(30));
  });

  it('writes the times in the shift zone', () => {
    expect(clockIn('America/New_York', START)).toBe('08:00');
    expect(zoneName('America/New_York', START)).toBe('EDT');
    const missed = shiftMailText({
      kind: 'missed',
      name: 'Roshni Test',
      start: START,
      tz: 'America/New_York',
      graceMinutes: 15,
      siteUrl: 'https://cloudpunch.aptask.com/',
    });
    expect(missed.subject).toBe('Not clocked in: Roshni Test, shift 08:00 EDT');
    expect(missed.text).toContain('started at 08:00 EDT on Fri 9 Oct');
    expect(missed.text).toContain('by 08:15');
    expect(missed.text).toContain('https://cloudpunch.aptask.com/app/');
    const late = shiftMailText({
      kind: 'late_clock_in',
      name: 'Roshni Test',
      start: START,
      tz: 'America/New_York',
      clockIn: at(40),
      graceMinutes: 15,
      siteUrl: 'https://cloudpunch.aptask.com',
    });
    expect(late.subject).toBe('Clocked in late: Roshni Test, 08:40 (shift 08:00 EDT)');
    expect(late.text).toContain('40 min after');
  });
});

describe('the job (ADR-0037 §3)', () => {
  it('does nothing while switched off', async () => {
    clock = at(20);
    expect(await job().runOnce()).toEqual([]);
    await setting(false);
    expect(await job().runOnce()).toEqual([]);
    expect(outbox).toEqual([]);
  });

  it('missed: to the person with the manager copied, or the Administrators with no manager; once', async () => {
    await setting(true);
    const j = job();
    clock = at(14);
    expect(await j.runOnce()).toEqual([]);
    clock = at(15);
    expect((await j.runOnce()).sort()).toEqual([`${farheen}:missed`, `${roshni}:missed`].sort());
    const toRoshni = outbox.find((m) => m.to.includes('roshni@aptask.com'));
    expect(toRoshni?.cc).toEqual(['nilesh@aptask.com']);
    expect(toRoshni?.subject).toBe('Not clocked in: Roshni Test, shift 08:00 EDT');
    const toFarheen = outbox.find((m) => m.to.includes('farheen@aptask.com'));
    expect(toFarheen?.cc).toEqual(['abdulla@aptask.com']);

    clock = at(16);
    expect(await j.runOnce()).toEqual([]);
    // Another server (a fresh job) doesn't send it again either.
    expect(await job().runOnce()).toEqual([]);
    expect(outbox).toHaveLength(2);
    expect(db.shiftAlertRows.map((r) => r.kind)).toEqual(['missed', 'missed']);
  });

  it('late: after a missed email, the clock-in is reported once', async () => {
    await setting(true);
    const j = job();
    clock = at(15);
    await j.runOnce();
    await clockInAt(roshni, at(40));
    clock = at(41);
    expect(await j.runOnce()).toEqual([`${roshni}:late_clock_in`]);
    expect(outbox.at(-1)?.subject).toBe('Clocked in late: Roshni Test, 08:40 (shift 08:00 EDT)');
    clock = at(50);
    expect(await j.runOnce()).toEqual([]);
  });

  it('on time, on a holiday, or with the grace not over: no email', async () => {
    await setting(true, 30);
    await clockInAt(roshni, at(2));
    await db.holidays.record({
      date: '2026-10-09',
      name: 'Test holiday',
      cancelled: true,
      addedByUserId: 'test',
      correlationId: randomUUID(),
      at: clock,
    });
    clock = at(20);
    expect(await job().runOnce()).toEqual([]);
    clock = at(30);
    expect(await job().runOnce()).toEqual([`${farheen}:missed`]);

    await db.holidays.record({
      date: '2026-10-09',
      name: 'Diwali',
      cancelled: false,
      addedByUserId: 'test',
      correlationId: randomUUID(),
      at: new Date(clock.getTime() + 1),
    });
    db.shiftAlertRows.length = 0;
    outbox = [];
    expect(await job().runOnce()).toEqual([]);
  });

  it('"Not working today" tells the manager; a failed send is tried again', async () => {
    await setting(true);
    await db.shifts.declareNotWorking({
      employeeId: roshni,
      shiftDate: '2026-10-09',
      declaredByUserId: 'test',
      correlationId: randomUUID(),
      at: clock,
    });
    clock = at(5);
    failNext = true;
    const j = job();
    expect(await j.runOnce()).toEqual([]);
    expect(db.shiftAlertRows).toEqual([]);
    expect(await j.runOnce()).toEqual([`${roshni}:not_working`]);
    expect(outbox[0]?.subject).toBe('Not working today: Roshni Test (shift 08:00 EDT)');
    expect(outbox[0]?.cc).toEqual(['nilesh@aptask.com']);
    // Never a missed clock-in for them.
    clock = at(30);
    expect(await j.runOnce()).toEqual([`${farheen}:missed`]);
  });
});

describe('regular late starters (ADR-0037 §4)', () => {
  /** Record `n` missed starts for `id` on the days before Monday 12 Oct. */
  async function missed(id: string, n: number, kind: 'missed' | 'not_working' = 'missed') {
    for (let i = 1; i <= n; i += 1) {
      await db.shiftAlerts.claimAndSend(
        {
          employeeId: id,
          shiftDate: `2026-10-0${i}`,
          kind,
          sentTo: [],
          at: clock,
        },
        async () => {},
      );
    }
  }
  const monday = (h: number, m = 0) =>
    wallToUtc(
      '2026-10-12',
      `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      'America/New_York',
    );

  it('Monday from 09:00 ET: managers get their reports, Administrators and HR everyone; once', async () => {
    await setting(true);
    await missed(roshni, 3);
    await missed(roshni, 1, 'not_working');
    await missed(farheen, 2);
    const j = job();
    clock = monday(8, 59);
    expect((await j.runOnce()).filter((x) => x.startsWith('weekly:'))).toEqual([]);
    clock = monday(9, 0);
    // Shift emails for 08:00 shifts are due as well; look at the Monday ones.
    const weekly = (await j.runOnce()).filter((x) => x.startsWith('weekly:')).sort();
    expect(weekly).toEqual(['weekly:abdulla@aptask.com', 'weekly:nilesh@aptask.com']);
    const toNilesh = outbox.find((m) => m.to.includes('nilesh@aptask.com'));
    expect(toNilesh?.subject).toBe('Regular late starters: 1 person');
    // Today's 08:00 start, missed at 08:15, counts too.
    expect(toNilesh?.text).toContain('- Roshni Test: 4 missed starts, 1 "not working today"');
    expect(toNilesh?.text).not.toContain('Farheen');
    clock = monday(10, 0);
    expect((await j.runOnce()).filter((x) => x.startsWith('weekly:'))).toEqual([]);
    expect((await job().runOnce()).filter((x) => x.startsWith('weekly:'))).toEqual([]);
  });

  it('nobody over the line: no Monday email; a failed one is tried again', async () => {
    await setting(true);
    await missed(farheen, 2);
    clock = monday(9, 30);
    expect((await job().runOnce()).filter((x) => x.startsWith('weekly:'))).toEqual([]);
    await missed(roshni, 3);
    failNext = true;
    const j = job();
    // The first send fails (it may be a shift email or the Monday one);
    // the next check sends whatever is left.
    await j.runOnce();
    clock = monday(9, 31);
    await j.runOnce();
    expect(db.weeklyReportRows.sort()).toEqual([
      '2026-10-12:abdulla@aptask.com',
      '2026-10-12:nilesh@aptask.com',
    ]);
  });

  it('Team shows the counts, and who is over the line', async () => {
    await setting(true);
    await missed(roshni, 3);
    await missed(farheen, 1, 'not_working');
    const [r, f, n] = await teamNow(
      db,
      [
        person(roshni, 'Roshni', nilesh),
        person(farheen, 'Farheen', null),
        person(nilesh, 'Nilesh', null),
      ],
      monday(12, 0),
    );
    expect(r?.starts).toEqual({ missed: 3, not_working: 0, days: 30, regular: true });
    expect(f?.starts).toEqual({ missed: 0, not_working: 1, days: 30, regular: false });
    expect(n?.starts).toBeUndefined();
  });
});
