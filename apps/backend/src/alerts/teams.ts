import type { FastifyBaseLogger } from 'fastify';
import type { DbRepositories, Employee, ShiftAlertKind } from '../db/index.js';
import { correctionStatus } from '../days/corrections.js';
import type { TeamsPost } from '../ops/teams.js';
import { dateIn } from '../shifts/model.js';
import { nameOf } from '../team/service.js';
import { clockIn as clockAt, shiftMailText } from './mail.js';
import { alertSettings } from './settings.js';

/**
 * Notices in a Teams channel (ADR-0043 §3), alongside the emails:
 *
 * - each shift-start email (ADR-0037 §3), posted after it's claimed, so
 *   once;
 * - corrections waiting, once a day from 10:00 India time, grouped by
 *   who has to act; claimed in `report_sent` so once a day (invariant 4).
 *
 * Only while `alerts.teams_posts` is on. Names, times and counts only
 * (invariant 1). A post that fails is logged; nothing else stops.
 */

const INDIA_TZ = 'Asia/Kolkata';
export const DIGEST_AT = '10:00';

export interface TeamsNoticesOptions {
  db: DbRepositories;
  log: FastifyBaseLogger;
  post: (p: TeamsPost) => Promise<void>;
  siteUrl: string;
}

export interface ShiftNotice {
  kind: ShiftAlertKind;
  person: Employee;
  start: Date;
  tz: string;
  clockIn: Date | null;
  graceMinutes: number;
}

export class TeamsNotices {
  /** The India date whose digest went (or had nothing to say). */
  private digestDone: string | null = null;

  constructor(private readonly opts: TeamsNoticesOptions) {}

  private async on(): Promise<boolean> {
    return (await alertSettings(this.opts.db)).teamsPosts;
  }

  private link(): { title: string; url: string } {
    return { title: 'Open Team', url: `${this.opts.siteUrl.replace(/\/$/, '')}/app/` };
  }

  /** The shift-start email as a post. Returns whether it was posted. */
  async shiftAlert(n: ShiftNotice): Promise<boolean> {
    try {
      if (!(await this.on())) return false;
      const { subject, text } = shiftMailText({
        kind: n.kind,
        name: nameOf(n.person),
        start: n.start,
        tz: n.tz,
        clockIn: n.clockIn,
        graceMinutes: n.graceMinutes,
        siteUrl: this.opts.siteUrl,
      });
      // The email's first paragraph says it all; the link is the button.
      const first = text.split('\n\n')[0] ?? text;
      await this.opts.post({
        title: subject,
        lines: [first],
        attention: n.kind === 'missed',
        link: this.link(),
      });
      return true;
    } catch (err) {
      this.opts.log.warn({ err, kind: n.kind }, 'teams: shift notice not posted');
      return false;
    }
  }

  /**
   * From 10:00 India time, once a day: the corrections waiting, by who
   * has to act. Returns whether a post went out.
   */
  async correctionsDigest(now: Date): Promise<boolean> {
    const { db, log } = this.opts;
    const today = dateIn(now.getTime(), INDIA_TZ);
    if (this.digestDone === today || clockAt(INDIA_TZ, now) < DIGEST_AT) return false;
    try {
      if (!(await this.on())) return false;
      const lines = await this.waiting();
      if (lines.length === 0) {
        this.digestDone = today;
        return false;
      }
      const total = lines.reduce((s, l) => s + l.count, 0);
      const posted = await db.reports.claimAndSend(
        { report: 'teams_corrections', date: today, recipient: 'teams', people: total, at: now },
        () =>
          this.opts.post({
            title: `Corrections waiting: ${total}`,
            lines: ['Time corrections asked for and not decided yet, by who has to act.'],
            facts: lines.map((l) => ({ title: l.who, value: l.text })),
            link: this.link(),
          }),
      );
      this.digestDone = today;
      return posted;
    } catch (err) {
      log.warn({ err }, 'teams: corrections digest not posted; will retry');
      return false;
    }
  }

  /** "Nilesh Darekar (to endorse)" → "Roshni Sahani 2, Amit Bisht 1". */
  private async waiting(): Promise<{ who: string; text: string; count: number }[]> {
    const { db } = this.opts;
    const open = (await db.corrections.listOpen()).filter((c) =>
      ['requested', 'endorsed'].includes(correctionStatus(c)),
    );
    const people = new Map<string, Employee | null>();
    const person = async (id: string): Promise<Employee | null> => {
      if (!people.has(id)) people.set(id, await db.employees.findById(id));
      return people.get(id) ?? null;
    };
    // Who acts -> whose corrections -> how many.
    const groups = new Map<string, Map<string, number>>();
    for (const c of open) {
      const subject = await person(c.employeeId);
      const manager =
        subject?.reportingManagerId && correctionStatus(c) === 'requested'
          ? await person(subject.reportingManagerId)
          : null;
      const who = manager ? `${nameOf(manager)} (to endorse)` : 'Administrators (to approve)';
      const name = subject ? nameOf(subject) : 'Someone no longer listed';
      const g = groups.get(who) ?? new Map<string, number>();
      g.set(name, (g.get(name) ?? 0) + 1);
      groups.set(who, g);
    }
    return [...groups.entries()]
      .sort(([a], [b]) =>
        a.startsWith('Administrators')
          ? 1
          : b.startsWith('Administrators')
            ? -1
            : a.localeCompare(b),
      )
      .map(([who, g]) => ({
        who,
        text: [...g.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, n]) => `${name} ${n}`)
          .join(', '),
        count: [...g.values()].reduce((s, n) => s + n, 0),
      }));
  }
}
