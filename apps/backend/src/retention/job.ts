import type { FastifyBaseLogger } from 'fastify';
import { clockIn as clockAt } from '../alerts/mail.js';
import type { DbRepositories, RetentionKind } from '../db/index.js';
import { dateIn } from '../shifts/model.js';
import { RETENTION_KINDS, retentionSettings } from './settings.js';

/**
 * ADR-0044 §3: the nightly clean-up. Checks hourly; once a day after
 * 02:00 India time, and only while `retention.enabled` is on, asks the
 * database's purge function to remove each kind past its period. Each
 * real run writes its own audit_log row (in the database function). A
 * failure is logged and tried again the next day.
 */

export const CHECK_EVERY_MS = 3_600_000;
const TZ = 'Asia/Kolkata';
const RUN_AFTER = '02:00';

export interface RetentionJobOptions {
  db: DbRepositories;
  log: FastifyBaseLogger;
  now?: () => Date;
}

export class RetentionJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** The India date of the last full run. */
  private done: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly opts: RetentionJobOptions) {
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
      this.opts.log.warn({ err }, 'retention: check failed');
    } finally {
      this.running = false;
    }
  }

  /** One check. Returns the rows removed per kind (empty when it didn't run). */
  async runOnce(): Promise<Partial<Record<RetentionKind, number>>> {
    const { db, log } = this.opts;
    const now = this.now();
    const today = dateIn(now.getTime(), TZ);
    if (this.done === today || clockAt(TZ, now) < RUN_AFTER) return {};
    const s = await retentionSettings(db);
    if (!s.enabled) return {};
    const removed: Partial<Record<RetentionKind, number>> = {};
    for (const kind of RETENTION_KINDS) {
      try {
        removed[kind] = await db.retention.purge(kind, s.days[kind], false);
      } catch (err) {
        log.warn({ err, kind }, 'retention: purge failed; will try tomorrow');
      }
    }
    this.done = today;
    log.info({ removed }, 'retention: nightly clean-up done');
    return removed;
  }
}
