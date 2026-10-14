import type { FastifyBaseLogger } from 'fastify';
import type { DbRepositories, Employee, Insight } from '../db/index.js';
import { clockIn as clockAt } from '../alerts/mail.js';
import { INDIA_TZ, rangeRows, type DayRow } from '../reports/day.js';
import { dateIn, shiftDate } from '../shifts/model.js';
import { findingsOf, stripOf, WINDOW_DAYS, type Finding, type InsightKind } from './rules.js';

/**
 * ADR-0047 §1–2: once a day (from 08:15 India time, after the day-end
 * summary), look at each active person's last 14 days and keep their
 * findings up to date:
 *
 * - a pattern that holds and has no live finding: open one;
 * - a live one whose evidence changed: update it;
 * - nudged, follow-up day reached: improved → resolved, else back to
 *   open, marked "no change after nudge";
 * - open (never nudged) and the pattern is gone: resolved.
 *
 * Every step is an insight_event by CloudPunch (no actor). Idempotent:
 * running twice the same day changes nothing the second time.
 */

export const RUN_AT = '08:15';
export const FOLLOW_UP_DAYS = 14;
const CHECK_EVERY_MS = 60_000;

export interface Evidence {
  /** The window looked at. */
  from: string;
  to: string;
  count: number;
  dates: string[];
  strip: ReturnType<typeof stripOf>;
}

export const evidenceOf = (
  f: Finding,
  rows: readonly DayRow[],
  from: string,
  to: string,
): Evidence => ({
  from,
  to,
  count: f.count,
  dates: f.dates,
  strip: stripOf(rows),
});

const sameEvidence = (a: unknown, b: Evidence): boolean => {
  const e = a as Partial<Evidence> | null;
  return !!e && e.count === b.count && JSON.stringify(e.dates) === JSON.stringify(b.dates);
};

/** Bring one person's findings up to date. Returns what changed, for the log. */
export async function refreshPerson(
  db: DbRepositories,
  person: Employee,
  rows: readonly DayRow[],
  live: readonly Insight[],
  window: { from: string; to: string },
  today: string,
  at: Date,
): Promise<string[]> {
  const changed: string[] = [];
  const found = new Map(findingsOf(rows).map((f) => [f.kind, f]));
  const system = { actorUserId: null, at } as const;

  for (const ins of live) {
    const f = found.get(ins.kind as InsightKind);
    if (ins.status === 'nudged') {
      if (!ins.followUpOn || ins.followUpOn > today) {
        if (f && !sameEvidence(ins.evidence, evidenceOf(f, rows, window.from, window.to))) {
          await db.insights.change(
            ins.id,
            { evidence: evidenceOf(f, rows, window.from, window.to) },
            { ...system, action: 'updated', note: null, detail: { count: f.count } },
          );
        }
        continue;
      }
      // Follow-up day: did the nudge help?
      if (f) {
        await db.insights.change(
          ins.id,
          {
            status: 'open',
            noChange: true,
            followUpOn: null,
            evidence: evidenceOf(f, rows, window.from, window.to),
          },
          {
            ...system,
            action: 'reopened',
            note: 'No change since the nudge',
            detail: { count: f.count },
          },
        );
        changed.push(`${ins.kind} reopened`);
      } else {
        await db.insights.change(
          ins.id,
          { status: 'resolved', followUpOn: null },
          { ...system, action: 'resolved', note: 'Improved since the nudge', detail: null },
        );
        changed.push(`${ins.kind} resolved`);
      }
      continue;
    }
    // Open.
    if (!f) {
      await db.insights.change(
        ins.id,
        { status: 'resolved' },
        { ...system, action: 'resolved', note: 'No longer seen in the last 14 days', detail: null },
      );
      changed.push(`${ins.kind} resolved`);
    } else if (!sameEvidence(ins.evidence, evidenceOf(f, rows, window.from, window.to))) {
      await db.insights.change(
        ins.id,
        { evidence: evidenceOf(f, rows, window.from, window.to), severity: f.severity },
        { ...system, action: 'updated', note: null, detail: { count: f.count } },
      );
    }
  }

  const liveKinds = new Set(live.map((i) => i.kind));
  for (const f of found.values()) {
    if (liveKinds.has(f.kind)) continue;
    await db.insights.open(
      {
        employeeId: person.id,
        kind: f.kind,
        severity: f.severity,
        evidence: evidenceOf(f, rows, window.from, window.to),
      },
      { ...system, action: 'opened', note: null, detail: { count: f.count } },
    );
    changed.push(`${f.kind} opened`);
  }
  return changed;
}

/** Everyone's findings for the 14 days ending `to` (yesterday). */
export async function refreshAll(db: DbRepositories, now: Date): Promise<number> {
  const today = dateIn(now.getTime(), INDIA_TZ);
  const to = shiftDate(today, -1);
  const from = shiftDate(to, -(WINDOW_DAYS - 1));
  const people = await db.employees.listActive();
  const rows = await rangeRows(db, people, from, to, now);
  const live = await db.insights.list(['open', 'nudged']);
  let n = 0;
  for (const p of people) {
    n += (
      await refreshPerson(
        db,
        p,
        rows.filter((r) => r.employee_id === p.id),
        live.filter((i) => i.employeeId === p.id),
        { from, to },
        today,
        now,
      )
    ).length;
  }
  return n;
}

export interface InsightsJobOptions {
  db: DbRepositories;
  log: FastifyBaseLogger;
  now?: () => Date;
}

export class InsightsJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private done: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly opts: InsightsJobOptions) {
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
      this.opts.log.warn({ err }, 'insights: refresh failed');
    } finally {
      this.running = false;
    }
  }

  /** Once a day from 08:15 India time; returns how many findings changed. */
  async runOnce(): Promise<number | null> {
    const now = this.now();
    const today = dateIn(now.getTime(), INDIA_TZ);
    if (this.done === today || clockAt(INDIA_TZ, now) < RUN_AT) return null;
    const n = await refreshAll(this.opts.db, now);
    this.done = today;
    this.opts.log.info({ changed: n }, 'insights: refreshed');
    return n;
  }
}
