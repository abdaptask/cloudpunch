import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ShiftMail } from '../alerts/mail.js';
import { InMemoryDb } from '../db/in-memory.js';
import type { Employee } from '../db/index.js';
import { wallToUtc } from '../shifts/model.js';
import { dayRows, problemsFirst } from './day.js';
import { DayReportJob } from './job.js';
import { dayMailText, duration } from './mail.js';
import { dayMailHtml } from './mailHtml.js';

const MIN = 60_000;
const IST = 330;
const DATE = '2026-10-12';
const log = pino({ level: 'silent' });

let db: InMemoryDb;
let clock: Date;
let outbox: ShiftMail[];
let failNext: boolean;

const nilesh = randomUUID();
const roshni = randomUUID();
const farheen = randomUUID();
const admin = randomUUID();
const oids: Record<string, string> = {};

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

const ist = (date: string, hhmm: string) => wallToUtc(date, hhmm, 'Asia/Kolkata');

/** A 09:00–18:00 India shift, every day. */
async function shift(id: string) {
  await db.shifts.assign({
    employeeId: id,
    days: [1, 2, 3, 4, 5, 6, 7],
    start: '09:00',
    end: '18:00',
    tzIana: 'Asia/Kolkata',
    effectiveFrom: '2026-01-01',
    reason: null,
    assignedByUserId: 'test',
    correlationId: randomUUID(),
    at: clock,
  });
}

/** Clocked in at `from`, out at `to` (or still in), with these events between. */
async function worked(
  id: string,
  from: Date,
  to: Date | null,
  between: [string, Date, Record<string, unknown>][] = [],
) {
  const session = await db.timeSessions.open({
    employeeId: id,
    deviceId: randomUUID(),
    openedAt: from,
  });
  const events: [string, Date, Record<string, unknown>][] = [
    ['USER_CLOCK_IN', from, {}],
    ...between,
    ...(to ? ([['USER_CLOCK_OUT', to, {}]] as [string, Date, Record<string, unknown>][]) : []),
  ];
  for (const [i, [eventType, clientTs, payload]] of events.entries()) {
    await db.timeEvents.insertOne({
      sessionId: session.id,
      employeeId: id,
      monotonicNs: 0,
      tzIana: 'Asia/Kolkata',
      utcOffsetMinutes: IST,
      deviceId: session.deviceId,
      appVersion: '0.1.35',
      origin: 'user',
      offlineCaptured: false,
      integritySignature: new Uint8Array(64),
      correlationId: randomUUID(),
      parentEventUlid: null,
      eventUlid: randomUUID(),
      eventType,
      sequenceNumber: i + 1,
      clientTs,
      payload,
    });
  }
  if (to) await db.timeSessions.close(session.id, to, 'user_clock_out');
}

async function settings(reports: Record<string, unknown>) {
  await db.policies.put(
    {
      scope: 'global',
      scopeId: null,
      reason: null,
      actorUserId: randomUUID(),
      correlationId: randomUUID(),
      at: clock,
    },
    { reports },
  );
}

function job(): DayReportJob {
  return new DayReportJob({
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

beforeEach(async () => {
  db = new InMemoryDb();
  clock = ist('2026-10-13', '07:59');
  outbox = [];
  failNext = false;
  const people: [string, string, string | null][] = [
    [nilesh, 'Nilesh', null],
    [roshni, 'Roshni', nilesh],
    [farheen, 'Farheen', null],
    [admin, 'Abdulla', null],
  ];
  for (const [id, name, m] of people) {
    db.seedEmployee(person(id, name, m));
    const oid = randomUUID();
    oids[id] = oid;
    db.seedUser(
      {
        id: randomUUID(),
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
  await db.roles.note(oids[admin] ?? '', ['Employee', 'Administrator'], 'token', clock);
  await shift(roshni);
  await shift(farheen);
  // Roshni: in 40 min late, a 20-minute personal break, out at 18:00.
  await worked(roshni, ist(DATE, '09:40'), ist(DATE, '18:00'), [
    ['USER_START_BREAK', ist(DATE, '13:00'), { break_kind: 'personal' }],
    ['USER_END_BREAK', ist(DATE, '13:20'), {}],
  ]);
});

describe('day rows (ADR-0040 §1)', () => {
  it('late, not clocked in and off, with hours against the shift', async () => {
    const rows = await dayRows(db, await db.employees.listActive(), DATE, clock);
    const by = (id: string) => rows.find((r) => r.employee_id === id);
    expect(by(roshni)).toMatchObject({
      status: 'late',
      minutes_late: 40,
      clock_in: ist(DATE, '09:40').toISOString(),
      clock_out: ist(DATE, '18:00').toISOString(),
      still_in: false,
      worked_ms: (8 * 60 + 20 - 20) * MIN,
      breaks_ms: 20 * MIN,
      shift_ms: 9 * 60 * MIN,
      tz: 'Asia/Kolkata',
      manager_id: nilesh,
    });
    expect(by(farheen)).toMatchObject({ status: 'not_clocked_in', clock_in: null, worked_ms: 0 });
    expect(by(nilesh)).toMatchObject({ status: 'off', shift: null });
    expect(problemsFirst(rows).map((r) => r.status)).toEqual([
      'not_clocked_in',
      'late',
      'off',
      'off',
    ]);
  });

  it('on time within the grace; holiday, in office and "not working" when nothing was worked', async () => {
    await worked(farheen, ist(DATE, '09:10'), null);
    let rows = await dayRows(db, [person(farheen, 'Farheen', null)], DATE, clock);
    expect(rows[0]).toMatchObject({
      status: 'worked',
      minutes_late: 10,
      still_in: true,
      clock_out: null,
    });

    await db.shifts.declareNotWorking({
      employeeId: nilesh,
      shiftDate: DATE,
      declaredByUserId: 'x',
      correlationId: randomUUID(),
      at: clock,
    });
    await shift(nilesh);
    rows = await dayRows(db, [person(nilesh, 'Nilesh', null)], DATE, clock);
    expect(rows[0]?.status).toBe('not_working');

    await db.office.setDay({
      employeeId: nilesh,
      date: DATE,
      inOffice: true,
      reason: null,
      setByUserId: 'x',
      correlationId: randomUUID(),
      at: clock,
    });
    rows = await dayRows(db, [person(nilesh, 'Nilesh', null)], DATE, clock);
    expect(rows[0]?.status).toBe('in_office');

    await db.holidays.record({
      date: DATE,
      name: 'Dussehra',
      cancelled: false,
      addedByUserId: 'x',
      correlationId: randomUUID(),
      at: clock,
    });
    rows = await dayRows(db, [person(nilesh, 'Nilesh', null)], DATE, clock);
    expect(rows[0]).toMatchObject({ status: 'holiday', holiday: 'Dussehra' });
  });
});

describe('day-end email text (ADR-0040 §2)', () => {
  it('a header with the counts, problems first, times in the shift zone', async () => {
    const rows = await dayRows(db, await db.employees.listActive(), DATE, clock);
    const { subject, text } = dayMailText({
      date: DATE,
      rows,
      who: 'Everyone',
      siteUrl: 'https://cloudpunch.aptask.com/',
    });
    expect(subject).toBe('Day summary, Monday 12 Oct: 1 late, 1 not clocked in');
    const lines = text.split('\n');
    expect(lines[0]).toBe('Everyone, Monday 12 Oct · 1 late · 1 not clocked in');
    expect(lines[2]).toBe('- Farheen Test: not clocked in (shift 09:00 GMT+5:30)');
    expect(lines[3]).toBe(
      '- Roshni Test: in 09:40 (40 min late), out 18:00, 8h 00m of 9h 00m worked',
    );
    expect(text).toContain('2 off (no shift, nothing worked).');
    expect(text).toContain('https://cloudpunch.aptask.com/app/');
    expect(duration(45 * MIN)).toBe('45m');
  });
});

describe('DayReportJob (ADR-0040 §2)', () => {
  it('off by default; at 08:00 India time managers get their team, Administrators everyone; once', async () => {
    clock = ist('2026-10-13', '08:00');
    expect(await job().runOnce()).toEqual([]);

    await settings({ day_emails: true });
    clock = ist('2026-10-13', '07:59');
    expect(await job().runOnce()).toEqual([]);

    clock = ist('2026-10-13', '08:00');
    const j = job();
    expect((await j.runOnce()).sort()).toEqual(['abdulla@aptask.com', 'nilesh@aptask.com']);
    const toNilesh = outbox.find((m) => m.to[0] === 'nilesh@aptask.com');
    expect(toNilesh?.text).toContain('Roshni Test');
    expect(toNilesh?.text).not.toContain('Farheen');
    const toAdmin = outbox.find((m) => m.to[0] === 'abdulla@aptask.com');
    expect(toAdmin?.text).toContain('Farheen Test: not clocked in');
    // Again, and from a second server: once only.
    expect(await j.runOnce()).toEqual([]);
    expect(await job().runOnce()).toEqual([]);
    expect(outbox).toHaveLength(2);
    expect(db.reportSentRows.map((r) => r.date)).toEqual([DATE, DATE]);
  });

  it('a manager who is an Administrator gets one email; a failed send is tried again', async () => {
    await settings({ day_emails: true, day_email_at: '09:30' });
    await db.roles.note(oids[nilesh] ?? '', ['Manager', 'Administrator'], 'token', clock);
    clock = ist('2026-10-13', '09:00');
    expect(await job().runOnce()).toEqual([]);
    clock = ist('2026-10-13', '09:30');
    failNext = true;
    const j = job();
    expect(await j.runOnce()).toHaveLength(1);
    expect(await j.runOnce()).toHaveLength(1);
    expect(outbox.map((m) => m.subject)).toEqual([
      'Day summary, Monday 12 Oct: 1/2 clocked in · 1 late · 1 not clocked in',
      'Day summary, Monday 12 Oct: 1/2 clocked in · 1 late · 1 not clocked in',
    ]);
    expect(outbox.every((m) => m.text.startsWith('Everyone'))).toBe(true);
  });
});

describe('day-end email as HTML (owner, 2026-10-14)', () => {
  it('headline tiles, what needs attention, everyone with a bar, and the interactive link', async () => {
    const rows = await dayRows(db, await db.employees.listActive(), DATE, clock);
    const odd = { ...rows[0]!, name: 'Ann <script>', status: 'not_clocked_in' as const };
    const { subject, html } = dayMailHtml({
      date: DATE,
      rows: [...rows, odd],
      who: 'Everyone',
      reportUrl: 'https://cloudpunch.aptask.com/app/admin/?section=reports&date=2026-10-12',
    });
    expect(subject).toBe('Day summary, Monday 12 Oct: 1/3 clocked in · 1 late · 2 not clocked in');
    expect(html).toContain('Open the interactive report');
    expect(html).toContain(
      'href="https://cloudpunch.aptask.com/app/admin/?section=reports&amp;date=2026-10-12"',
    );
    expect(html).toContain('Needs attention');
    expect(html).toContain('Ann &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<strong style="color:#0b0b0b">Roshni Test</strong> +40m');
    expect(html).toContain('Everyone who worked');
    expect(html).toMatch(/Roshni Test.*09:40–18:00/s);
  });

  it('sends the HTML, linking managers to Team', async () => {
    await settings({ day_emails: true });
    clock = ist('2026-10-13', '08:00');
    await job().runOnce();
    const toNilesh = outbox.find((m) => m.to[0] === 'nilesh@aptask.com');
    expect(toNilesh?.html).toContain('/app/?view=day-summary&amp;date=2026-10-12');
    const toAdmin = outbox.find((m) => m.to[0] === 'abdulla@aptask.com');
    expect(toAdmin?.html).toContain('/app/admin/?section=reports&amp;date=2026-10-12');
  });
});

describe('day spans for the timeline (owner, 2026-10-14)', () => {
  it('work, breaks and idle, adjacent runs merged', async () => {
    const rows = await dayRows(db, await db.employees.listActive(), DATE, clock);
    const r = rows.find((x) => x.employee_id === roshni);
    expect(r?.segments).toEqual([
      {
        kind: 'work',
        from: ist(DATE, '09:40').toISOString(),
        to: ist(DATE, '13:00').toISOString(),
      },
      {
        kind: 'break',
        from: ist(DATE, '13:00').toISOString(),
        to: ist(DATE, '13:20').toISOString(),
      },
      {
        kind: 'work',
        from: ist(DATE, '13:20').toISOString(),
        to: ist(DATE, '18:00').toISOString(),
      },
    ]);
    expect(rows.find((x) => x.employee_id === farheen)?.segments).toEqual([]);
  });
});
