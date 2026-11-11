import type { FastifyBaseLogger } from 'fastify';
import { clockIn as clockAt, type ShiftMail } from '../alerts/mail.js';
import type { DbRepositories, ManagerNote } from '../db/index.js';
import { INDIA_TZ, rangeRows } from '../reports/day.js';
import { dateIn, shiftDate } from '../shifts/model.js';
import { nameOf } from '../team/service.js';
import { compare, followUpMail, NOTE_DAYS, summaryOf, type NoteSummary } from './summary.js';

/**
 * ADR-0055 §5: each morning from 08:15 India time (after the day rows
 * are complete), follow up the notes that are 14 days old: compare the
 * 14 days after each note with the 14 days before, and email whoever
 * sent it, the manager copied. Each goes once (invariant 4).
 */

export const RUN_AT = '08:15';
const CHECK_EVERY_MS = 60_000;

/** Follow up one note; false when it was already done (or can't be). */
export async function followUpNote(
  db: DbRepositories,
  note: ManagerNote,
  send: (m: ShiftMail) => Promise<void>,
  siteUrl: string,
  now: Date,
): Promise<boolean> {
  const person = await db.employees.findById(note.employeeId);
  const manager = await db.employees.findById(note.managerId);
  const sender = await db.users.findById(note.sentBy);
  if (!person || !manager || !sender?.workEmail) return false;
  const sentOn = dateIn(note.sentAt.getTime(), INDIA_TZ);
  const from = sentOn;
  const to = shiftDate(sentOn, NOTE_DAYS - 1);
  const after = summaryOf(await rangeRows(db, [person], from, to, now), from, to);
  const result = compare(note.topics, note.summary as NoteSummary, after);
  const mail = followUpMail({
    person: nameOf(person),
    manager: nameOf(manager),
    senderFirst: sender.displayName.split(' ')[0] || sender.displayName,
    sentOn,
    seenOn: note.seenAt ? dateIn(note.seenAt.getTime(), INDIA_TZ) : null,
    result,
    siteUrl,
  });
  const cc =
    manager.workEmail && manager.workEmail.toLowerCase() !== sender.workEmail.toLowerCase()
      ? [manager.workEmail]
      : [];
  return db.managerNotes.followUp(note.id, result, now, () =>
    send({ to: [sender.workEmail], cc, ...mail }),
  );
}

export interface ManagerNotesJobOptions {
  db: DbRepositories;
  log: FastifyBaseLogger;
  send: (m: ShiftMail) => Promise<void>;
  siteUrl: string;
  now?: () => Date;
}

export class ManagerNotesJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private done: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly opts: ManagerNotesJobOptions) {
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
      this.opts.log.warn({ err }, 'manager notes: follow-up failed');
    } finally {
      this.running = false;
    }
  }

  /** Once a day from 08:15 India time; returns how many follow-ups went. */
  async runOnce(): Promise<number | null> {
    const now = this.now();
    const today = dateIn(now.getTime(), INDIA_TZ);
    if (this.done === today || clockAt(INDIA_TZ, now) < RUN_AT) return null;
    let sent = 0;
    let failed = 0;
    for (const note of await this.opts.db.managerNotes.due(today)) {
      try {
        if (await followUpNote(this.opts.db, note, this.opts.send, this.opts.siteUrl, now)) sent++;
      } catch (err) {
        failed++;
        this.opts.log.warn({ err, note: note.id }, 'manager notes: one follow-up failed');
      }
    }
    // A follow-up that failed stays due, so tomorrow's run tries it again.
    this.done = today;
    if (sent > 0 || failed > 0) this.opts.log.info({ sent, failed }, 'manager notes: followed up');
    return sent;
  }
}
