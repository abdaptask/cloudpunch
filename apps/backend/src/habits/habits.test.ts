import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ShiftMail } from '../alerts/mail.js';
import { InMemoryDb } from '../db/in-memory.js';
import type { Employee } from '../db/index.js';
import { shiftDate, wallToUtc } from '../shifts/model.js';
import { dueOn, HabitsJob, type HabitsWindow } from './job.js';
import { habitsReport, minutesOn } from './load.js';
import { habitsMailHtml, habitsMailText } from './mail.js';
import { companyHabits, hhmm, personHabits, typical, type HabitDay } from './model.js';

const IST = 'Asia/Kolkata';
const log = pino({ level: 'silent' });

/** A worked day on a 09:00–18:00 shift; minutes from midnight. */
function day(date: string, over: Partial<HabitDay> = {}): HabitDay {
  const inMin = over.inMin ?? 9 * 60;
  return {
    date,
    weekday: (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7,
    status: 'worked',
    inMin,
    outMin: 18 * 60,
    shiftStartMin: 9 * 60,
    shiftEndMin: 18 * 60,
    minutesLate: Math.max(0, inMin - 9 * 60),
    stillIn: false,
    workedMs: 9 * 3_600_000,
    shiftMs: 9 * 3_600_000,
    sessions: 1,
    fromSignIn: false,
    autoOut: null,
    ...over,
  };
}

/** Weekdays from 2026-10-15 (a Thursday) on. */
function weekdays(n: number, from = '2026-10-15'): string[] {
  const out: string[] = [];
  for (let d = from; out.length < n; d = shiftDate(d, 1)) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
  }
  return out;
}

const who = { employee_id: 'e1', name: 'Eela Test', tz: IST };

describe('habits model (ADR-0051 §2)', () => {
  it('typical times: the middle one and the middle half', () => {
    expect(typical([540, 545, 550, 555, 600])).toEqual({
      median: 550,
      low: 545,
      high: 555,
      spread: 10,
      n: 5,
    });
    expect(typical([])).toBeNull();
    expect(hhmm(545)).toBe('09:05');
    expect(hhmm(1440 + 30)).toBe('00:30 (+1)');
  });

  it('a steady person is labelled with their usual hours', () => {
    const p = personHabits(
      who,
      weekdays(8).map((d, i) => day(d, { inMin: 540 + (i % 3) * 5 })),
    );
    expect(p.flags[0]).toBe('steady');
    expect(p.label).toBe('Steady 09:05–18:00');
    expect(p.on_time_rate).toBe(1);
    expect(p.days_worked).toBe(8);
  });

  it('few days: not enough to say', () => {
    const p = personHabits(
      who,
      weekdays(2).map((d) => day(d)),
    );
    expect(p.flags).toEqual(['few_days']);
    expect(p.label).toBe('Not enough days yet (2 days)');
  });

  it('often late, later on Mondays, leaves clocked in, locks without clocking out', () => {
    const days = weekdays(10).map((d) => {
      const monday = new Date(`${d}T12:00:00Z`).getUTCDay() === 1;
      return day(d, monday ? { inMin: 11 * 60, status: 'late', minutesLate: 120 } : {});
    });
    // Two more late days, two left clocked in, two locked out.
    days[0] = { ...days[0]!, inMin: 600, status: 'late', minutesLate: 60 };
    days[1] = { ...days[1]!, inMin: 610, status: 'late', minutesLate: 70 };
    days[2] = { ...days[2]!, stillIn: true, outMin: null };
    days[3] = { ...days[3]!, autoOut: 'idle_cap', outMin: null };
    days[4] = { ...days[4]!, autoOut: 'locked_after_shift', outMin: null };
    days[5] = { ...days[5]!, autoOut: 'locked_after_shift', outMin: null };
    const p = personHabits(who, days);
    expect(p.flags).toEqual(
      expect.arrayContaining([
        'often_late',
        'late_on_weekday',
        'leaves_clocked_in',
        'locks_without_clocking_out',
      ]),
    );
    expect(p.label).toBe('Often late');
    expect(p.notes).toContain('Starts later on Mondays (around 11:00)');
    expect(p.left_clocked_in).toBe(2);
    expect(p.locked_outs).toBe(2);
    // Clock-outs CloudPunch made aren't anyone's habit.
    expect(p.end?.n).toBe(6);
  });

  it('missed clock-ins, early leavers, split and long days, starts from sign-in', () => {
    const days = weekdays(10).map((d, i) =>
      day(d, {
        fromSignIn: true,
        outMin: i < 3 ? 16 * 60 : 18 * 60,
        sessions: i >= 3 && i < 7 ? 2 : 1,
        workedMs: i >= 7 ? 11 * 3_600_000 : 9 * 3_600_000,
      }),
    );
    days.push(
      day('2026-10-29', { status: 'not_clocked_in', inMin: null, outMin: null }),
      day('2026-10-30', { status: 'not_clocked_in', inMin: null, outMin: null }),
    );
    const p = personHabits(who, days);
    expect(p.missed_starts).toBe(2);
    expect(p.early_leaves).toBe(3);
    expect(p.split_days).toBe(4);
    expect(p.long_days).toBe(3);
    expect(p.flags).toEqual(
      expect.arrayContaining([
        'missed_starts',
        'leaves_early',
        'split_days',
        'long_days',
        'starts_from_sign_in',
      ]),
    );
    expect(p.label).toBe('No clock-in on 2 shift days');
  });

  it('irregular start times; the sign-in note never becomes the label', () => {
    const starts = [480, 540, 600, 660, 720, 480, 540, 600, 660, 720];
    const p = personHabits(
      who,
      weekdays(10).map((d, i) =>
        day(d, { inMin: starts[i] ?? 540, minutesLate: 0, status: 'worked', fromSignIn: true }),
      ),
    );
    expect(p.flags).toContain('irregular_start');
    expect(p.label).toBe('Irregular start times');
  });

  it('the company: week by week, hours, and who changed since their first week', () => {
    const early = weekdays(15).map((d) => day(d, { inMin: d < '2026-10-22' ? 540 : 600 }));
    const steady = weekdays(15).map((d) => day(d));
    const daysOf = new Map([
      ['a', early],
      ['b', steady],
    ]);
    const people = [
      personHabits({ employee_id: 'a', name: 'Amit', tz: IST }, early),
      personHabits({ employee_id: 'b', name: 'Bina', tz: IST }, steady),
    ];
    const c = companyHabits(people, daysOf, '2026-10-15');
    expect(c.people).toBe(2);
    expect(c.days_worked).toBe(30);
    expect(c.weeks.map((w) => w.week_start)).toEqual([
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
      '2026-11-02',
    ]);
    expect(c.start_hours[9]).toBeGreaterThan(0);
    expect(c.end_hours[18]).toBe(30);
    expect(c.changed).toEqual([
      expect.objectContaining({ name: 'Amit', start_shift: 60, first_start: 540, last_start: 600 }),
    ]);
  });
});

describe('local minutes', () => {
  it('counts from local midnight of the date, past 24 h after midnight', () => {
    expect(minutesOn(IST, '2026-10-15', wallToUtc('2026-10-15', '09:05', IST))).toBe(545);
    expect(minutesOn(IST, '2026-10-15', wallToUtc('2026-10-16', '00:30', IST))).toBe(1470);
    expect(
      minutesOn(
        'America/New_York',
        '2026-10-15',
        wallToUtc('2026-10-15', '08:00', 'America/New_York'),
      ),
    ).toBe(480);
  });
});

describe('when the emails go (ADR-0051 §3)', () => {
  const w: HabitsWindow = { from: '2026-10-15', to: '2026-11-13', finalOn: '2026-11-14' };
  it('Mondays in the window, then the final report on its day', () => {
    expect(dueOn('2026-10-15', w)).toBeNull();
    expect(dueOn('2026-10-16', w)).toBeNull(); // a Friday
    expect(dueOn('2026-10-19', w)).toEqual({ kind: 'weekly', to: '2026-10-18', week: 1 });
    expect(dueOn('2026-10-26', w)).toEqual({ kind: 'weekly', to: '2026-10-25', week: 2 });
    expect(dueOn('2026-11-09', w)).toEqual({ kind: 'weekly', to: '2026-11-08', week: 4 });
    expect(dueOn('2026-11-14', w)).toEqual({ kind: 'final', to: '2026-11-13' });
    expect(dueOn('2026-11-20', w)).toEqual({ kind: 'final', to: '2026-11-13' });
  });
});

describe('the habits job and report (ADR-0051)', () => {
  let db: InMemoryDb;
  let clock: Date;
  let outbox: ShiftMail[];
  const roshni = randomUUID();
  const admin = randomUUID();
  const adminOid = randomUUID();

  function person(id: string, name: string): Employee {
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
      reportingManagerId: null,
    };
  }

  async function worked(id: string, date: string, from: string, to: string | null, payload = {}) {
    const start = wallToUtc(date, from, IST);
    const end = to ? wallToUtc(date, to, IST) : null;
    const session = await db.timeSessions.open({
      employeeId: id,
      deviceId: randomUUID(),
      openedAt: start,
    });
    const events: [string, Date, Record<string, unknown>][] = [
      ['USER_CLOCK_IN', start, {}],
      ...(end
        ? ([['USER_CLOCK_OUT', end, payload]] as [string, Date, Record<string, unknown>][])
        : []),
    ];
    for (const [i, [eventType, clientTs, p]] of events.entries()) {
      await db.timeEvents.insertOne({
        sessionId: session.id,
        employeeId: id,
        monotonicNs: 0,
        tzIana: IST,
        utcOffsetMinutes: 330,
        deviceId: session.deviceId,
        appVersion: '0.1.46',
        origin: 'user',
        offlineCaptured: false,
        integritySignature: new Uint8Array(64),
        correlationId: randomUUID(),
        parentEventUlid: null,
        eventUlid: randomUUID(),
        eventType,
        sequenceNumber: i + 1,
        clientTs,
        payload: p,
      });
    }
    if (end) await db.timeSessions.close(session.id, end, 'user_clock_out');
  }

  function job(window?: HabitsWindow): HabitsJob {
    return new HabitsJob({
      db,
      log,
      siteUrl: 'https://cloudpunch.aptask.com',
      now: () => clock,
      send: async (m) => {
        outbox.push(m);
      },
      ...(window ? { window } : {}),
    });
  }

  beforeEach(async () => {
    db = new InMemoryDb();
    outbox = [];
    clock = wallToUtc('2026-10-19', '08:29', IST);
    db.seedEmployee(person(roshni, 'Roshni'));
    db.seedEmployee(person(admin, 'Abdulla'));
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
    await db.shifts.assign({
      employeeId: roshni,
      days: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '18:00',
      tzIana: IST,
      effectiveFrom: '2026-01-01',
      reason: null,
      assignedByUserId: 'test',
      correlationId: randomUUID(),
      at: clock,
    });
    await worked(roshni, '2026-10-15', '09:02', '18:01');
    await worked(roshni, '2026-10-16', '09:31', '18:00');
    await worked(roshni, '2026-10-17', '09:00', '17:40', { reason: 'locked_after_shift' });
  });

  it('builds the report from the time records', async () => {
    const r = await habitsReport(
      db,
      await db.employees.listActive(),
      '2026-10-15',
      '2026-10-18',
      clock,
    );
    const p = r.people.find((x) => x.employee_id === roshni);
    expect(p).toMatchObject({ days_worked: 3, late_days: 1, locked_outs: 1, missed_starts: 0 });
    expect(p?.start?.median).toBe(542);
    // The locked-out day's clock-out isn't counted as a habit.
    expect(p?.end?.n).toBe(2);
    expect(r.company.days_worked).toBe(3);
  });

  it('sends "Habits so far" on Monday from 08:30 to Administrators, once', async () => {
    expect(await job().runOnce()).toEqual([]);
    clock = wallToUtc('2026-10-19', '08:31', IST);
    expect(await job().runOnce()).toEqual(['abdulla@aptask.com']);
    expect(outbox[0]?.subject).toBe('CloudPunch: Habits so far (week 1 of ~4)');
    expect(outbox[0]?.html).toContain('Roshni Test');
    expect(outbox[0]?.text).toContain('section=reports&tab=habits');
    // A second check, or a restarted server, sends nothing more.
    expect(await job().runOnce()).toEqual([]);
    expect(db.reportSentRows.filter((r) => r.report === 'habits')).toHaveLength(1);
    // Not on a Tuesday.
    clock = wallToUtc('2026-10-20', '09:00', IST);
    expect(await job().runOnce()).toEqual([]);
  });

  it('the final report on its day, then never again', async () => {
    clock = wallToUtc('2026-11-14', '08:45', IST);
    expect(await job().runOnce()).toEqual(['abdulla@aptask.com']);
    expect(outbox[0]?.subject).toBe('CloudPunch: 30-day habits report');
    clock = wallToUtc('2026-11-16', '08:45', IST); // a later Monday
    expect(await job().runOnce()).toEqual([]);
    expect(outbox).toHaveLength(1);
  });

  it('the email reads well with nothing to flag', async () => {
    const r = await habitsReport(
      db,
      await db.employees.listActive(),
      '2026-10-15',
      '2026-10-18',
      clock,
    );
    const input = {
      report: r,
      title: 'Habits so far (week 1 of ~4)',
      final: false,
      reportUrl: 'x',
    };
    expect(habitsMailText(input).text).toContain('Abdulla Test: Not enough days yet (0 days)');
    expect(habitsMailText(input).text).toMatch(/Roshni Test: .*in 09:/);
    expect(habitsMailHtml(input).html).toContain("Nobody's start or finish moved");
  });
});
