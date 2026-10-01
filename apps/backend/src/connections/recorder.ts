import type { FastifyBaseLogger } from 'fastify';
import type { DbRepositories } from '../db/index.js';
import { effectivePolicyForScope } from '../policy/service.js';
import {
  connectionFromRequest,
  hasLocationHeaders,
  networkKey,
  type RequestLike,
} from './network.js';

/** `last_seen_at` moves on at most this often for the same network (ADR-0029 §2). */
export const TOUCH_EVERY_MS = 15 * 60 * 1000;
/** How long the `connections.record` setting is cached. */
export const SETTING_TTL_MS = 60 * 1000;

interface Current {
  key: string;
  rowId: string;
  touchedAt: number;
}

export interface ConnectionRecorderOptions {
  db: DbRepositories;
  log: FastifyBaseLogger;
  now?: () => Date;
}

/**
 * ADR-0029 §2: on each request a desktop device makes, keep one
 * `device_connection` row per network. Same network: `last_seen_at`
 * moves on at most every 15 minutes. New network: a new row. The
 * device's current network is kept in memory, so most requests write
 * nothing.
 *
 * Off unless the global `connections.record` setting is on (§7).
 * Never fails the request it's recording: errors are logged.
 */
export class ConnectionRecorder {
  private readonly current = new Map<string, Current>();
  /** One write at a time per device, so two requests can't both insert. */
  private readonly queue = new Map<string, Promise<void>>();
  private setting: { on: boolean; until: number } | null = null;
  private headersLogged = false;
  private readonly now: () => Date;

  constructor(private readonly opts: ConnectionRecorderOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  async record(req: RequestLike, employeeId: string, deviceId: string): Promise<void> {
    try {
      if (!(await this.enabled())) return;
      this.logHeadersOnce(req);
      const prior = this.queue.get(deviceId) ?? Promise.resolve();
      const next = prior.then(() => this.write(req, employeeId, deviceId));
      this.queue.set(deviceId, next);
      await next.finally(() => {
        if (this.queue.get(deviceId) === next) this.queue.delete(deviceId);
      });
    } catch (err) {
      this.opts.log.warn({ err, deviceId }, 'connections: could not record');
    }
  }

  private async write(req: RequestLike, employeeId: string, deviceId: string): Promise<void> {
    const seen = connectionFromRequest(req);
    const key = networkKey(seen.ip);
    const at = this.now();

    let cur = this.current.get(deviceId);
    if (!cur) {
      // After a restart: carry on with the device's latest row.
      const latest = await this.opts.db.connections.latestForDevice(deviceId);
      if (latest && latest.employeeId === employeeId && networkKey(latest.ip) === key) {
        cur = { key, rowId: latest.id, touchedAt: latest.lastSeenAt.getTime() };
        this.current.set(deviceId, cur);
      }
    }

    if (cur && cur.key === key) {
      if (at.getTime() - cur.touchedAt < TOUCH_EVERY_MS) return;
      await this.opts.db.connections.touch(cur.rowId, at);
      cur.touchedAt = at.getTime();
      return;
    }

    const row = await this.opts.db.connections.insert({
      employeeId,
      deviceId,
      ...seen,
      asn: null,
      provider: null,
      firstSeenAt: at,
      lastSeenAt: at,
    });
    this.current.set(deviceId, { key, rowId: row.id, touchedAt: at.getTime() });
  }

  private async enabled(): Promise<boolean> {
    const t = this.now().getTime();
    if (this.setting && t < this.setting.until) return this.setting.on;
    // Global only (ADR-0029 §7): the owner turns it on for everyone.
    const { policy } = await effectivePolicyForScope(this.opts.db, 'global', null);
    const section = policy['connections'] as { record?: unknown } | undefined;
    const on = section?.record === true;
    this.setting = { on, until: t + SETTING_TTL_MS };
    return on;
  }

  /** ADR-0029 amendment: say once whether Cloudflare's location headers arrive (not their values). */
  private logHeadersOnce(req: RequestLike): void {
    if (this.headersLogged || !req.headers['cf-ray']) return;
    this.headersLogged = true;
    this.opts.log.info(
      { cfLocationHeaders: hasLocationHeaders(req) },
      'connections: Cloudflare location headers',
    );
  }
}
