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

/** One failed request, as much as the server knows about it. */
export interface Failure {
  /** `POST /v1/events`. */
  route: string;
  /** The error's message, when one was thrown. */
  error: string | null;
  /** The signed-in account (usually the work email). */
  account: string | null;
  /** The computer, when the request named one. */
  deviceId: string | null;
}

/** The person and computer behind a device id, for the alert's wording. */
export interface DeviceInfo {
  name: string | null;
  os: string;
  appVersion: string;
}

export interface OpsMonitorOptions {
  log: FastifyBaseLogger;
  /** Email Administrators; null when the mailbox isn't set up. */
  email: ((a: OpsAlert) => Promise<void>) | null;
  /** Post to the alerts channel; null when no webhook is set. */
  teams: ((p: TeamsPost) => Promise<void>) | null;
  siteUrl: string;
  /** Who and what a device id is; without it alerts name the account only. */
  device?: (id: string) => Promise<DeviceInfo | null>;
  now?: () => number;
}

export class OpsMonitor {
  private readonly refused: { at: number; n: number }[] = [];
  private readonly errors: (Failure & { at: number })[] = [];
  /** Device id -> seconds its clock was last seen ahead. */
  private readonly ahead = new Map<string, number>();
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
          'See Console → Reports → Trends → Adoption and health for which computers and why (a wrong clock, a signed-out computer, …).',
        ],
      });
    }
  }

  /** A computer's clock was seen `seconds` ahead (for the alert's wording). */
  clockAhead(deviceId: string, seconds: number): void {
    this.ahead.set(deviceId, seconds);
  }

  /** A `5xx` answer, with what's known about it. */
  serverError(f: Partial<Failure> = {}): void {
    const now = this.now();
    this.errors.push({
      at: now,
      route: f.route ?? 'unknown request',
      error: f.error ?? null,
      account: f.account ?? null,
      deviceId: f.deviceId ?? null,
    });
    trim(this.errors, now, (x) => x.at);
    if (this.errors.length >= SERVER_ERRORS && this.quietOver('errors', now)) {
      // Claim the hour now, so the next failures don't build it again.
      this.lastAlert.set('errors', now);
      const failures = [...this.errors];
      void this.describe(failures).then(
        (a) => this.send(a, true),
        (err: unknown) => this.opts.log.warn({ err }, 'ops: alert not built'),
      );
    }
  }

  /**
   * The server-error alert in plain words: what failed, for whom, why
   * (for causes we know) and what to do, grouped by cause.
   */
  async describe(failures: readonly (Failure & { at: number })[]): Promise<OpsAlert> {
    const groups = new Map<string, (Failure & { at: number })[]>();
    for (const f of failures) {
      const key = `${causeOf(f.error).key}|${f.route}`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    const devices = new Map<string, DeviceInfo | null>();
    for (const f of failures) {
      if (f.deviceId && !devices.has(f.deviceId) && this.opts.device) {
        devices.set(f.deviceId, await this.opts.device(f.deviceId).catch(() => null));
      }
    }
    const nameOf = (f: Failure): string => {
      const d = f.deviceId ? devices.get(f.deviceId) : null;
      return d?.name ?? f.account ?? 'someone not signed in';
    };
    const whoOf = (f: Failure): string => {
      const d = f.deviceId ? devices.get(f.deviceId) : null;
      return d ? `${nameOf(f)} (${osName(d.os)}, CloudPunch ${d.appVersion})` : nameOf(f);
    };
    const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
    const lines: string[] = [
      `${failures.length} requests failed in the last 15 minutes, for ${
        sorted.length === 1 ? 'one reason' : `${sorted.length} reasons`
      }.`,
    ];
    for (const g of sorted) {
      const first = g[0] as Failure & { at: number };
      const last = g[g.length - 1] as Failure & { at: number };
      const cause = causeOf(first.error);
      const who = [...new Set(g.map(whoOf))];
      const secs = g.map((f) => (f.deviceId ? this.ahead.get(f.deviceId) : undefined));
      const aheadBy = secs.find((x) => x !== undefined);
      const more = who.length > 5 ? ` and ${who.length - 5} more` : '';
      lines.push(
        [
          `${cause.title}: ${g.length} times, ${clock(first.at)}–${clock(last.at)} India time.`,
          `Request: ${first.route}`,
          `Who: ${who.slice(0, 5).join('; ')}${more}`,
          `Why: ${cause.why}${
            cause.key === 'clock_ahead' && aheadBy !== undefined
              ? ` This computer's clock is about ${duration(aheadBy)} fast, so each event goes through on a retry about that long later.`
              : ''
          }`,
          `What to do: ${cause.todo}`,
          ...(cause.key === 'other' && first.error ? [`Error: ${first.error.slice(0, 300)}`] : []),
        ].join('\n'),
      );
    }
    lines.push('Server log, for the details: journalctl -u cloudpunch-api --since "-15 min"');
    const only = sorted.length === 1 ? sorted[0] : undefined;
    const onlyCause = only?.[0] ? causeOf(only[0].error) : null;
    const people = only ? [...new Set(only.map(nameOf))] : [];
    const title =
      onlyCause?.key === 'clock_ahead' && people.length === 1
        ? `${people[0]}'s computer clock is ahead: uploads are waiting`
        : onlyCause && onlyCause.key !== 'other'
          ? onlyCause.title
          : 'The API is answering with errors';
    return { title, lines };
  }

  private quietOver(kind: string, now: number): boolean {
    const last = this.lastAlert.get(kind);
    return last === undefined || now - last >= QUIET_MS;
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

interface Cause {
  key: 'clock_ahead' | 'database_down' | 'timeout' | 'other';
  title: string;
  why: string;
  todo: string;
}

/** Plain words for the failures we know (ADR-0043 §2). */
export function causeOf(error: string | null): Cause {
  const e = error ?? '';
  if (e.includes('time_event_check')) {
    return {
      key: 'clock_ahead',
      title: "A computer's clock is ahead of real time",
      why: 'Its events are dated in the future, so the server refuses them (a future time cannot be trusted). Nothing is lost: the app keeps them and retries.',
      todo: 'Ask the person to turn on automatic date and time (Windows: Settings → Time & language → Date & time → Set time automatically; Mac: System Settings → General → Date & Time), then reopen CloudPunch. Check their day afterwards and correct it if the times are shifted.',
    };
  }
  if (/ECONNREFUSED|terminating connection|Connection terminated|too many clients/i.test(e)) {
    return {
      key: 'database_down',
      title: "The server can't reach its database",
      why: 'PostgreSQL is down, restarting or out of connections.',
      todo: 'On the server: systemctl status postgresql, then systemctl restart cloudpunch-api once the database is back.',
    };
  }
  if (/timeout|timed out/i.test(e)) {
    return {
      key: 'timeout',
      title: 'Requests are timing out',
      why: 'The server or its database is too slow to answer.',
      todo: 'Check the server load (uptime, free -m) and the log for slow queries.',
    };
  }
  return {
    key: 'other',
    title: 'Requests are failing',
    why: error
      ? 'An unexpected error (below).'
      : 'The server answered with an error but logged no message.',
    todo: 'Forward this email to the developer; the server log has the full error.',
  };
}

const CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
});
const clock = (ms: number): string => CLOCK.format(new Date(ms));
const duration = (s: number): string =>
  s < 90
    ? `${s} seconds`
    : s < 5400
      ? `${Math.round(s / 60)} minutes`
      : `${Math.round(s / 3600)} hours`;
const osName = (os: string): string => (os === 'macos' ? 'Mac' : os === 'windows' ? 'Windows' : os);

const errorText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 300);
