import type { FastifyBaseLogger } from 'fastify';
import type { TeamsPost } from './teams.js';

/**
 * The API watching itself (ADR-0043 §2): refused uploads and server
 * errors over 15 minutes, and background jobs failing in a row. Alerts
 * go to Administrators by email and to the Teams channel, each kind at
 * most once an hour. Counts are in memory only; nothing is stored.
 * Never throws: an alert that can't be sent is logged.
 */

export const WINDOW_MS = 15 * 60_000;
export const QUIET_MS = 60 * 60_000;
export const REFUSED_EVENTS = 50;
export const SERVER_ERRORS = 20;
export const JOB_FAILURES = 3;

export interface OpsAlert {
  title: string;
  lines: string[];
}

export interface OpsMonitorOptions {
  log: FastifyBaseLogger;
  /** Email Administrators; null when the mailbox isn't set up. */
  email: ((a: OpsAlert) => Promise<void>) | null;
  /** Post to the alerts channel; null when no webhook is set. */
  teams: ((p: TeamsPost) => Promise<void>) | null;
  siteUrl: string;
  now?: () => number;
}

export class OpsMonitor {
  private readonly refused: { at: number; n: number }[] = [];
  private readonly errors: number[] = [];
  private readonly lastAlert = new Map<string, number>();
  /** Job name -> failures in a row. */
  private readonly jobFails = new Map<string, number>();
  /** Jobs an alert went out for, to say when they work again. */
  private readonly jobAlerted = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly opts: OpsMonitorOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** `n` events the server refused (ADR-0040 §3.4). */
  refusedUpload(n: number): void {
    const now = this.now();
    this.refused.push({ at: now, n });
    trim(this.refused, now, (x) => x.at);
    const total = this.refused.reduce((s, x) => s + x.n, 0);
    if (total >= REFUSED_EVENTS) {
      void this.alert('uploads', {
        title: 'Uploads are being refused',
        lines: [
          `${total} events were refused in the last 15 minutes.`,
          'See Reports → Overview → Adoption and health for which computers and why (a wrong clock, a signed-out computer, …).',
        ],
      });
    }
  }

  /** A `5xx` answer. */
  serverError(): void {
    const now = this.now();
    this.errors.push(now);
    trim(this.errors, now, (x) => x);
    if (this.errors.length >= SERVER_ERRORS) {
      void this.alert('errors', {
        title: 'The API is answering with errors',
        lines: [
          `${this.errors.length} requests failed with a server error in the last 15 minutes.`,
          'Check the log: journalctl -u cloudpunch-api --since "-15 min"',
        ],
      });
    }
  }

  /** A background job's check failed. */
  jobFailed(job: string, err: unknown): void {
    const n = (this.jobFails.get(job) ?? 0) + 1;
    this.jobFails.set(job, n);
    if (n < JOB_FAILURES) return;
    this.jobAlerted.add(job);
    void this.alert(`job:${job}`, {
      title: `${job} keeps failing`,
      lines: [
        `It failed ${n} times in a row. Last error: ${errorText(err)}`,
        'Check the log: journalctl -u cloudpunch-api --since "-30 min"',
      ],
    });
  }

  /** A background job's check worked. */
  jobOk(job: string): void {
    this.jobFails.delete(job);
    if (!this.jobAlerted.delete(job)) return;
    void this.send({ title: `${job} works again`, lines: ['Its last check succeeded.'] }, false);
  }

  /** At most once an hour per kind. */
  private async alert(kind: string, a: OpsAlert): Promise<void> {
    const now = this.now();
    const last = this.lastAlert.get(kind);
    if (last !== undefined && now - last < QUIET_MS) return;
    this.lastAlert.set(kind, now);
    await this.send(a, true);
  }

  private async send(a: OpsAlert, attention: boolean): Promise<void> {
    const { log, email, teams, siteUrl } = this.opts;
    log.warn({ alert: a.title }, 'ops: alert');
    const jobs: Promise<void>[] = [];
    if (email) jobs.push(email(a));
    if (teams) {
      jobs.push(
        teams({
          title: a.title,
          lines: a.lines,
          attention,
          link: { title: 'Open CloudPunch', url: `${siteUrl.replace(/\/$/, '')}/app/admin/` },
        }),
      );
    }
    for (const r of await Promise.allSettled(jobs)) {
      if (r.status === 'rejected') log.warn({ err: r.reason as unknown }, 'ops: alert not sent');
    }
  }
}

function trim<T>(list: T[], now: number, at: (x: T) => number): void {
  while (list.length > 0 && now - at(list[0] as T) > WINDOW_MS) list.shift();
}

const errorText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 300);
