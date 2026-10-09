import type { FastifyBaseLogger } from 'fastify';
import type { DbRepositories, Employee, ShiftAlertKind } from '../db/index.js';
import { daysAround } from '../days/service.js';
import { activeWindow, dateIn, isoWeekday, shiftDate, type ShiftWindow } from '../shifts/model.js';
import { nameOf } from '../team/service.js';
import { clockIn as clockAt, shiftMailText, weeklyMailText, type ShiftMail } from './mail.js';
import { dueAlerts, firstClockInFor, needsClockIn } from './rules.js';
import { alertSettings, type AlertSettings } from './settings.js';

/**
 * ADR-0037 §3: once a minute, send the shift-start emails that are due.
 * The API's first background job; it starts and stops with the server.
 *
 * - Off unless the global `alerts.shift_emails` setting is on.
 * - Each email is claimed in `shift_alert` and sent in one transaction,
 *   so it goes once even with retries or two servers (invariant 4).
 * - To the person, with their manager copied; with no manager, the
 *   Administrators and HR (the roles they were last seen with).
 * - A failed send is logged and tried again on the next check.
 */

export const CHECK_EVERY_MS = 60_000;
/** The Monday email (ADR-0037 §4): from 09:00 in this zone. */
const WEEKLY_TZ = 'America/New_York';
const WEEKLY_AT = '09:00';
/** Who hears about people with no manager (the owner's answer 5). */
const NO_MANAGER_ROLES = ['Administrator', 'HR'];

export interface ShiftAlertJobOptions {
  db: DbRepositories;
  log: FastifyBaseLogger;
  send: (m: ShiftMail) => Promise<void>;
  siteUrl: string;
  now?: () => Date;
}

export class ShiftAlertJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** `${employeeId}:${date}` -> first clock-in, once known: no need to look again. */
  private readonly clockIns = new Map<string, Date>();
  /** The Monday whose late-starters emails all went out. */
  private weeklyDone: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly opts: ShiftAlertJobOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
    this.timer.unref();
    this.opts.log.info('shift alerts: checking every minute');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.opts.log.warn({ err }, 'shift alerts: check failed');
    } finally {
      this.running = false;
    }
  }

  /** One check. Returns the emails it sent, as `${employeeId}:${kind}`. */
  async runOnce(): Promise<string[]> {
    const { db } = this.opts;
    const settings = await alertSettings(db);
    if (!settings.on) return [];
    const now = this.now();
    const weekly = await this.weekly(now, settings);
    const people = await db.employees.listActive();
    const rows = await db.shifts.history(people.map((p) => p.id));
    const inShift: { person: Employee; window: ShiftWindow }[] = [];
    for (const person of people) {
      const window = activeWindow(
        rows.filter((r) => r.employeeId === person.id),
        now,
      );
      if (window) inShift.push({ person, window });
    }
    if (inShift.length === 0) return weekly;

    const ids = inShift.map((x) => x.person.id);
    const dates = [...new Set(inShift.map((x) => x.window.date))].sort();
    const first = dates[0] ?? '';
    const last = dates.at(-1) ?? '';
    const holidays = new Set((await db.holidays.between(first, last)).map((h) => h.date));
    const notWorking = await db.shifts.notWorking(ids, dates);
    const sent = await db.shiftAlerts.sent(ids, dates);

    const done: string[] = [...weekly];
    for (const { person, window } of inShift) {
      const key = `${person.id}:${window.date}`;
      const mine = new Set(
        (['missed', 'late_clock_in', 'not_working'] as const).filter((k) =>
          sent.has(`${key}:${k}`),
        ),
      );
      const state = {
        window,
        holiday: holidays.has(window.date),
        saidNotWorking: notWorking.has(key),
        sent: mine,
      };
      let firstClockIn = this.clockIns.get(key) ?? null;
      if (!firstClockIn && needsClockIn(state, now, settings.graceMinutes)) {
        const days = await daysAround(db, person.id, shiftDate(window.date, -1), window.date, now);
        firstClockIn = firstClockInFor(
          window,
          days.flatMap((d) => d.sessions),
        );
        if (firstClockIn) this.clockIns.set(key, firstClockIn);
      }
      for (const kind of dueAlerts({ ...state, firstClockIn }, now, settings.graceMinutes)) {
        if (await this.sendOne(person, window, kind, firstClockIn, settings.graceMinutes, now)) {
          done.push(`${person.id}:${kind}`);
        }
      }
    }
    // Keep the memo to shifts still running.
    const running = new Set(inShift.map((x) => `${x.person.id}:${x.window.date}`));
    for (const k of this.clockIns.keys()) {
      if (!running.has(k)) this.clockIns.delete(k);
    }
    return done;
  }

  /**
   * ADR-0037 §4: on Monday from 09:00 ET, each manager gets their direct
   * reports with `regularCount` or more missed starts in the last
   * `regularDays` days; Administrators and HR get everyone. Once per
   * recipient per week (`weekly_report_sent`). Returns `weekly:<address>`.
   */
  private async weekly(now: Date, s: AlertSettings): Promise<string[]> {
    const { db, log } = this.opts;
    const monday = dateIn(now.getTime(), WEEKLY_TZ);
    if (isoWeekday(monday) !== 1 || clockAt(WEEKLY_TZ, now) < WEEKLY_AT) return [];
    if (this.weeklyDone === monday) return [];
    const counts = await db.shiftAlerts.countsSince(shiftDate(monday, -s.regularDays));
    const people = await db.employees.listActive();
    const regular = people
      .filter((p) => (counts.get(p.id)?.missed ?? 0) >= s.regularCount)
      .map((p) => ({
        person: p,
        name: nameOf(p),
        missed: counts.get(p.id)?.missed ?? 0,
        notWorking: counts.get(p.id)?.notWorking ?? 0,
      }))
      .sort((a, b) => b.missed - a.missed || a.name.localeCompare(b.name));

    // Who gets which list: Administrators and HR everyone; managers their reports.
    const lists = new Map<string, typeof regular>();
    if (regular.length > 0) {
      const everyone = (await db.roles.holders(['Administrator', 'HR'])).map((h) =>
        h.email.toLowerCase(),
      );
      for (const address of everyone) lists.set(address, regular);
      const byId = new Map(people.map((p) => [p.id, p]));
      for (const r of regular) {
        const manager = r.person.reportingManagerId
          ? byId.get(r.person.reportingManagerId)
          : undefined;
        const address = manager?.workEmail.toLowerCase();
        if (!address || everyone.includes(address)) continue;
        lists.set(address, [...(lists.get(address) ?? []), r]);
      }
    }

    const sent: string[] = [];
    let failed = false;
    for (const [address, list] of lists) {
      const { subject, text } = weeklyMailText({
        people: list,
        count: s.regularCount,
        days: s.regularDays,
        siteUrl: this.opts.siteUrl,
      });
      try {
        const claimed = await db.weeklyReports.claimAndSend(monday, address, list.length, now, () =>
          this.opts.send({ to: [address], cc: [], subject, text }),
        );
        if (claimed) sent.push(`weekly:${address}`);
      } catch (err) {
        failed = true;
        log.warn({ err }, 'shift alerts: Monday email failed; will retry');
      }
    }
    if (!failed) this.weeklyDone = monday;
    if (sent.length > 0) log.info({ recipients: sent.length }, 'shift alerts: Monday email sent');
    return sent;
  }

  private async sendOne(
    person: Employee,
    window: ShiftWindow,
    kind: ShiftAlertKind,
    clockIn: Date | null,
    graceMinutes: number,
    now: Date,
  ): Promise<boolean> {
    const { db, log } = this.opts;
    const to = person.workEmail ? [person.workEmail] : [];
    const manager = person.reportingManagerId
      ? await db.employees.findById(person.reportingManagerId)
      : null;
    let cc: string[];
    if (manager?.status === 'active' && manager.workEmail) {
      cc = [manager.workEmail];
    } else {
      cc = (await db.roles.holders(NO_MANAGER_ROLES)).map((h) => h.email);
    }
    const lower = new Set(to.map((a) => a.toLowerCase()));
    cc = [...new Set(cc.filter((a) => !lower.has(a.toLowerCase())))];
    if (to.length === 0 && cc.length === 0) {
      log.warn({ employeeId: person.id, kind }, 'shift alerts: nobody to tell');
      return false;
    }
    const { subject, text } = shiftMailText({
      kind,
      name: nameOf(person),
      start: window.start,
      tz: window.shift.tzIana,
      clockIn,
      graceMinutes,
      siteUrl: this.opts.siteUrl,
    });
    const mail: ShiftMail = {
      to: to.length > 0 ? to : cc,
      cc: to.length > 0 ? cc : [],
      subject,
      text,
    };
    try {
      const claimed = await db.shiftAlerts.claimAndSend(
        {
          employeeId: person.id,
          shiftDate: window.date,
          kind,
          sentTo: [...mail.to, ...mail.cc],
          at: now,
        },
        () => this.opts.send(mail),
      );
      if (claimed) log.info({ employeeId: person.id, kind }, 'shift alerts: sent');
      return claimed;
    } catch (err) {
      log.warn({ err, employeeId: person.id, kind }, 'shift alerts: send failed; will retry');
      return false;
    }
  }
}
