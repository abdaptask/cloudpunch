import type { FastifyBaseLogger } from 'fastify';
import type { DbRepositories } from '../db/index.js';
import { clockIn as clockAt, type ShiftMail } from '../alerts/mail.js';
import { spanDays } from '../days/service.js';
import type { OpsMonitor } from '../ops/monitor.js';
import { INDIA_TZ } from '../reports/day.js';
import { dateIn, shiftDate } from '../shifts/model.js';
import { habitsReport, HABITS_FINAL_ON, HABITS_FROM, HABITS_TO } from './load.js';
import { habitsMailHtml, habitsMailText } from './mail.js';

/**
 * ADR-0051 §3: the habits inspector's emails to Administrators. Every
 * Monday from 08:30 India time during the window, "Habits so far", and
 * on the final day the 30-day report; then it stops. Each email is
 * claimed in `report_sent` and sent in one transaction, so it goes
 * once even with retries, restarts or two servers (invariant 4).
 */

export const SEND_AT = '08:30';
const CHECK_EVERY_MS = 60_000;
const JOB = 'Habits report';

export interface HabitsWindow {
  from: string;
  to: string;
  finalOn: string;
}

export const DEFAULT_WINDOW: HabitsWindow = {
  from: HABITS_FROM,
  to: HABITS_TO,
  finalOn: HABITS_FINAL_ON,
};

/** Pure: which email is due on `today` (India date), if any. */
export function dueOn(
  today: string,
  w: HabitsWindow,
): { kind: 'weekly'; to: string; week: number } | { kind: 'final'; to: string } | null {
  if (today >= w.finalOn) return { kind: 'final', to: w.to };
  const yesterday = shiftDate(today, -1);
  if (yesterday < w.from) return null;
  const monday = new Date(`${today}T12:00:00Z`).getUTCDay() === 1;
  if (!monday) return null;
  const days = spanDays(w.from, yesterday);
  return { kind: 'weekly', to: yesterday, week: Math.ceil(days / 7) };
}

export interface HabitsJobOptions {
  db: DbRepositories;
  log: FastifyBaseLogger;
  send: (m: ShiftMail) => Promise<void>;
  siteUrl: string;
  window?: HabitsWindow;
  now?: () => Date;
  monitor?: OpsMonitor | undefined;
}

export class HabitsJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** The India date whose emails all went out. */
  private done: string | null = null;
  private readonly now: () => Date;
  private readonly window: HabitsWindow;

  constructor(private readonly opts: HabitsJobOptions) {
    this.now = opts.now ?? (() => new Date());
    this.window = opts.window ?? DEFAULT_WINDOW;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
    this.timer.unref();
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
      this.opts.monitor?.jobOk(JOB);
    } catch (err) {
      this.opts.log.warn({ err }, 'habits: check failed');
      this.opts.monitor?.jobFailed(JOB, err);
    } finally {
      this.running = false;
    }
  }

  /** One check. Returns the addresses it sent to. */
  async runOnce(): Promise<string[]> {
    const { db, log } = this.opts;
    const now = this.now();
    const today = dateIn(now.getTime(), INDIA_TZ);
    if (this.done === today || clockAt(INDIA_TZ, now) < SEND_AT) return [];
    const due = dueOn(today, this.window);
    if (!due) {
      this.done = today;
      return [];
    }
    // The final report is claimed on its own date, so later days find it sent.
    const claimDate = due.kind === 'final' ? this.window.finalOn : today;
    const admins = [
      ...new Set((await db.roles.holders(['Administrator'])).map((h) => h.email.toLowerCase())),
    ];
    if (admins.length === 0) {
      this.done = today;
      return [];
    }
    const people = await db.employees.listActive();
    const report = await habitsReport(db, people, this.window.from, due.to, now);
    const title =
      due.kind === 'final' ? '30-day habits report' : `Habits so far (week ${due.week} of ~4)`;
    const reportUrl = `${this.opts.siteUrl.replace(/\/$/, '')}/app/admin/?section=reports&tab=habits`;
    const input = { report, title, final: due.kind === 'final', reportUrl };
    const { text } = habitsMailText(input);
    const { subject, html } = habitsMailHtml(input);

    const sent: string[] = [];
    let failed = false;
    for (const address of admins) {
      try {
        const claimed = await db.reports.claimAndSend(
          {
            report: 'habits',
            date: claimDate,
            recipient: address,
            people: report.people.length,
            at: now,
          },
          () => this.opts.send({ to: [address], cc: [], subject, text, html }),
        );
        if (claimed) sent.push(address);
      } catch (err) {
        failed = true;
        log.warn({ err }, 'habits: send failed; will retry');
      }
    }
    if (!failed) this.done = today;
    if (sent.length > 0) log.info({ kind: due.kind, recipients: sent.length }, 'habits: sent');
    return sent;
  }
}
