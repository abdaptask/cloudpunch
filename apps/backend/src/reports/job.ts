import type { FastifyBaseLogger } from 'fastify';
import type { DbRepositories, Employee } from '../db/index.js';
import { clockIn as clockAt, type ShiftMail } from '../alerts/mail.js';
import { effectivePolicyForScope } from '../policy/service.js';
import { dateIn, shiftDate } from '../shifts/model.js';
import { dayRows, INDIA_TZ, type DayRow } from './day.js';
import { dayMailText } from './mail.js';
import { dayMailHtml } from './mailHtml.js';

/**
 * ADR-0040 §2: the day-end summary. Once the clock in India passes
 * `reports.day_email_at` (08:00 by default), each manager gets their
 * direct reports' day before and each Administrator everyone's; someone
 * who is both gets only the Administrator one. Off unless
 * `reports.day_emails` is on (global settings only).
 *
 * Each email is claimed in `report_sent` and sent in one transaction,
 * so it goes once even with retries or two servers (invariant 4). A
 * failed send is logged and tried again on the next check.
 */

export const CHECK_EVERY_MS = 60_000;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export interface ReportSettings {
  dayEmails: boolean;
  /** HH:MM, India time. */
  dayEmailAt: string;
}

export async function reportSettings(db: DbRepositories): Promise<ReportSettings> {
  const { policy } = await effectivePolicyForScope(db, 'global', null);
  const r = (policy['reports'] ?? {}) as Record<string, unknown>;
  const at = r['day_email_at'];
  return {
    dayEmails: r['day_emails'] === true,
    dayEmailAt: typeof at === 'string' && HHMM.test(at) ? at : '08:00',
  };
}

export interface DayReportJobOptions {
  db: DbRepositories;
  log: FastifyBaseLogger;
  send: (m: ShiftMail) => Promise<void>;
  siteUrl: string;
  now?: () => Date;
}

export class DayReportJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** The India date whose emails all went out. */
  private done: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly opts: DayReportJobOptions) {
    this.now = opts.now ?? (() => new Date());
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
    } catch (err) {
      this.opts.log.warn({ err }, 'day reports: check failed');
    } finally {
      this.running = false;
    }
  }

  /** One check. Returns the addresses it sent to. */
  async runOnce(): Promise<string[]> {
    const { db, log } = this.opts;
    const now = this.now();
    const today = dateIn(now.getTime(), INDIA_TZ);
    if (this.done === today) return [];
    const s = await reportSettings(db);
    if (!s.dayEmails || clockAt(INDIA_TZ, now) < s.dayEmailAt) return [];
    const date = shiftDate(today, -1);

    const people = await db.employees.listActive();
    const rows = await dayRows(db, people, date, now);
    const lists = await recipients(db, people, rows);

    const sent: string[] = [];
    let failed = false;
    for (const [address, list] of lists) {
      // Nobody on shift and nothing worked (a weekend): no email.
      if (list.rows.every((r) => r.status === 'off')) continue;
      const { text } = dayMailText({
        date,
        rows: list.rows,
        who: list.who,
        siteUrl: this.opts.siteUrl,
      });
      // The interactive report: the console for Administrators, Team for managers.
      const site = this.opts.siteUrl.replace(/\/$/, '');
      const reportUrl =
        list.who === 'Everyone'
          ? `${site}/app/admin/?section=reports&date=${date}`
          : `${site}/app/?view=day-summary&date=${date}`;
      const { subject, html } = dayMailHtml({ date, rows: list.rows, who: list.who, reportUrl });
      try {
        const claimed = await db.reports.claimAndSend(
          { report: 'day', date, recipient: address, people: list.rows.length, at: now },
          () => this.opts.send({ to: [address], cc: [], subject, text, html }),
        );
        if (claimed) sent.push(address);
      } catch (err) {
        failed = true;
        log.warn({ err }, 'day reports: send failed; will retry');
      }
    }
    if (!failed) this.done = today;
    if (sent.length > 0) log.info({ date, recipients: sent.length }, 'day reports: sent');
    return sent;
  }
}

/**
 * Who gets which rows (ADR-0040 §2): Administrators (the roles they were
 * last seen with, ADR-0037) everyone; each active manager with an email
 * their direct reports, unless they're an Administrator too.
 */
export async function recipients(
  db: DbRepositories,
  people: readonly Employee[],
  rows: readonly DayRow[],
): Promise<Map<string, { who: string; rows: DayRow[] }>> {
  const out = new Map<string, { who: string; rows: DayRow[] }>();
  const admins = new Set(
    (await db.roles.holders(['Administrator'])).map((h) => h.email.toLowerCase()),
  );
  for (const address of admins) out.set(address, { who: 'Everyone', rows: [...rows] });
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const r of rows) {
    const manager = r.manager_id ? byId.get(r.manager_id) : undefined;
    const address = manager?.workEmail?.toLowerCase();
    if (!address || admins.has(address)) continue;
    const list = out.get(address) ?? { who: 'Your team', rows: [] };
    list.rows.push(r);
    out.set(address, list);
  }
  return out;
}
