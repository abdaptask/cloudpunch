import type { FastifyBaseLogger } from 'fastify';
import type { DbRepositories, DeviceConnection } from '../db/index.js';
import type { ShiftMail } from '../alerts/mail.js';
import { effectivePolicyForScope } from '../policy/service.js';
import { nameOf } from '../team/service.js';
import { NOT_A_COUNTRY, placeOf } from './places.js';

/** How far back a place counts as known (ADR-0041 §2; connections are kept this long). */
export const KNOWN_DAYS = 30;
/** How long the setting is cached. */
const SETTING_TTL_MS = 60_000;
/** The zone the email's time is written in. */
const MAIL_TZ = 'Asia/Kolkata';

export interface NewPlaceOptions {
  db: DbRepositories;
  log: FastifyBaseLogger;
  send: (m: ShiftMail) => Promise<void>;
  siteUrl: string;
  now?: () => Date;
}

const key = (c: Pick<DeviceConnection, 'city' | 'country'>): string =>
  `${(c.city ?? '').trim().toLowerCase()}|${(c.country ?? '').trim().toLowerCase()}`;

/**
 * Pure (ADR-0041 §2): `row` is a new place when it has a city and
 * country, the person connected before in the window, and none of those
 * earlier connections was from the same city and country.
 */
export function isNewPlace(row: DeviceConnection, earlier: readonly DeviceConnection[]): boolean {
  if (!row.city?.trim() || !row.country?.trim() || NOT_A_COUNTRY.has(row.country)) return false;
  const before = earlier.filter((c) => c.id !== row.id);
  if (before.length === 0) return false;
  return !before.some((c) => key(c) === key(row));
}

/** The email (ADR-0041 §4): the place, provider and time; no address or device. */
export function newPlaceMail(input: {
  name: string;
  row: DeviceConnection;
  earlier: readonly DeviceConnection[];
  siteUrl: string;
}): { subject: string; text: string } {
  const { name, row } = input;
  // From parts, so every Node's ICU writes it the same: "Tue 13 Oct, 14:30".
  const part = (t: Intl.DateTimeFormatPartTypes): string =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: MAIL_TZ,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(row.firstSeenAt)
      .find((p) => p.type === t)?.value ?? '';
  const when = `${part('weekday')} ${part('day')} ${part('month')}, ${part('hour')}:${part('minute')}`;
  const places = [...new Set(input.earlier.filter((c) => c.id !== row.id).map(placeOf))];
  return {
    subject: `${name} is connecting from a new place`,
    text: [
      `${name} is connecting to CloudPunch from ${placeOf(row)}${row.provider ? ` (${row.provider})` : ''}, first seen ${when} India time.`,
      '',
      places.length > 0
        ? `In the last ${KNOWN_DAYS} days they connected from: ${places.join('; ')}.`
        : '',
      '',
      `The place comes from the internet connection and is approximate (no GPS). See their connections in CloudPunch: ${input.siteUrl.replace(/\/$/, '')}/app/admin/`,
      '',
      'Sent once per new place. Turn these emails off in Rules → Connection location.',
    ]
      .filter((l, i, a) => l !== '' || a[i - 1] !== '')
      .join('\n'),
  };
}

/**
 * ADR-0041: called when a computer is seen on a new network. If it is a
 * city or country the person hasn't used in 30 days, email their
 * manager (Administrators copied; Administrators alone with no
 * manager), once per person, place and day. Never throws.
 */
export class NewPlaceAlerts {
  private setting: { on: boolean; until: number } | null = null;
  private readonly now: () => Date;

  constructor(private readonly opts: NewPlaceOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  async check(row: DeviceConnection): Promise<boolean> {
    const { db, log } = this.opts;
    try {
      if (!(await this.enabled())) return false;
      const since = new Date(this.now().getTime() - KNOWN_DAYS * 86_400_000);
      const earlier = await db.connections.listForEmployee(row.employeeId, since);
      if (!isNewPlace(row, earlier)) return false;
      const person = await db.employees.findById(row.employeeId);
      if (!person || person.status !== 'active') return false;
      const manager = person.reportingManagerId
        ? await db.employees.findById(person.reportingManagerId)
        : null;
      const admins = (await db.roles.holders(['Administrator'])).map((h) => h.email);
      const to = manager?.workEmail ? [manager.workEmail] : admins;
      const lower = new Set(to.map((a) => a.toLowerCase()));
      const cc = manager?.workEmail
        ? [...new Set(admins.filter((a) => !lower.has(a.toLowerCase())))]
        : [];
      if (to.length === 0) {
        log.warn({ employeeId: row.employeeId }, 'new place: nobody to tell');
        return false;
      }
      const { subject, text } = newPlaceMail({
        name: nameOf(person),
        row,
        earlier,
        siteUrl: this.opts.siteUrl,
      });
      const [city, country] = key(row).split('|') as [string, string];
      const sent = await db.locationAlerts.claimAndSend(
        {
          employeeId: row.employeeId,
          city,
          country,
          sentOn: this.now().toISOString().slice(0, 10),
          at: this.now(),
        },
        () => this.opts.send({ to, cc, subject, text }),
      );
      if (sent) log.info({ employeeId: row.employeeId }, 'new place: email sent (ADR-0041)');
      return sent;
    } catch (err) {
      log.warn({ err, employeeId: row.employeeId }, 'new place: not sent');
      return false;
    }
  }

  private async enabled(): Promise<boolean> {
    const t = this.now().getTime();
    if (this.setting && t < this.setting.until) return this.setting.on;
    const { policy } = await effectivePolicyForScope(this.opts.db, 'global', null);
    const alerts = policy['alerts'] as { location_emails?: unknown } | undefined;
    const on = alerts?.location_emails === true;
    this.setting = { on, until: t + SETTING_TTL_MS };
    return on;
  }
}
