import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ShiftMail } from '../alerts/mail.js';
import { InMemoryDb } from '../db/in-memory.js';
import type { DeviceConnection, Employee } from '../db/index.js';
import { isNewPlace, NewPlaceAlerts, newPlaceMail } from './newPlace.js';
import { ConnectionRecorder } from './recorder.js';

const log = pino({ level: 'silent' });
const roshni = randomUUID();
const priya = randomUUID();
const deviceId = randomUUID();

let db: InMemoryDb;
let clock: Date;
let outbox: ShiftMail[];
const now = () => clock;

function person(id: string, name: string, managerId: string | null): Employee {
  return {
    id,
    source: 'local_admin',
    greythrEmployeeId: null,
    employeeNumber: null,
    givenName: name,
    familyName: 'Test',
    displayName: `${name} Test`,
    workEmail: `${name.toLowerCase()}@aptask.com`,
    status: 'active',
    reportingManagerId: managerId,
  };
}

const conn = (over: Partial<DeviceConnection>): DeviceConnection => ({
  id: randomUUID(),
  employeeId: roshni,
  deviceId,
  ip: '1.2.3.4',
  city: 'Pune',
  region: 'Maharashtra',
  country: 'IN',
  asn: null,
  provider: 'Jio',
  firstSeenAt: new Date('2026-10-10T09:00:00Z'),
  lastSeenAt: new Date('2026-10-10T09:00:00Z'),
  ...over,
});

async function settings(alerts: boolean) {
  await db.policies.put(
    {
      scope: 'global',
      scopeId: null,
      reason: null,
      actorUserId: randomUUID(),
      correlationId: randomUUID(),
      at: clock,
    },
    { connections: { record: true }, alerts: { location_emails: alerts } },
  );
}

/** A computer connecting from Cloudflare in `city`. */
const from = (ip: string, city: string, country = 'IN') => ({
  ip,
  headers: { 'cf-ray': 'x', 'cf-ipcity': city, 'cf-region': 'R', 'cf-ipcountry': country },
});

beforeEach(() => {
  db = new InMemoryDb();
  clock = new Date('2026-10-13T09:00:00Z');
  outbox = [];
  db.seedEmployee(person(roshni, 'Roshni', priya));
  db.seedEmployee(person(priya, 'Priya', null));
  // An Administrator, as last seen with their role.
  const adminOid = randomUUID();
  db.seedUser(
    {
      id: randomUUID(),
      entraObjectId: adminOid,
      workEmail: 'owner@aptask.com',
      displayName: 'Owner',
      isServiceAccount: false,
      breakGlass: false,
      employeeId: null,
    },
    adminOid,
  );
  void db.roles.note(adminOid, ['Administrator'], 'people', clock);
});

describe('new place (ADR-0041 §2)', () => {
  it('a city or country not seen in the window; not a first connection; not a new provider', () => {
    const pune = conn({});
    expect(isNewPlace(conn({ city: 'Mumbai' }), [pune])).toBe(true);
    expect(isNewPlace(conn({ city: 'pune ', provider: 'Airtel', ip: '9.9.9.9' }), [pune])).toBe(
      false,
    );
    expect(isNewPlace(conn({ country: 'US', city: 'Pune' }), [pune])).toBe(true);
    expect(isNewPlace(conn({ city: 'Mumbai' }), [])).toBe(false);
    expect(isNewPlace(conn({ city: null }), [pune])).toBe(false);
    expect(isNewPlace(conn({ city: 'Somewhere', country: 'XX' }), [pune])).toBe(false);
  });

  it('the email names the place, provider and earlier places; no address', () => {
    const row = conn({ city: 'Mumbai', ip: '5.6.7.8', firstSeenAt: clock });
    const { subject, text } = newPlaceMail({
      name: 'Roshni Test',
      row,
      earlier: [conn({}), row],
      siteUrl: 'https://cloudpunch.aptask.com',
    });
    expect(subject).toBe('Roshni Test is connecting from a new place');
    expect(text).toContain(
      'from Mumbai, Maharashtra (Jio), first seen Tue 13 Oct, 14:30 India time',
    );
    expect(text).toContain('they connected from: Pune, Maharashtra.');
    expect(text).not.toContain('5.6.7.8');
  });
});

describe('NewPlaceAlerts (ADR-0041)', () => {
  const alerts = () =>
    new NewPlaceAlerts({
      db,
      log,
      now,
      siteUrl: 'https://cloudpunch.aptask.com',
      send: async (m) => {
        outbox.push(m);
      },
    });

  it('a new city: one email to the manager, Administrators copied; once', async () => {
    await settings(true);
    const a = alerts();
    const r = new ConnectionRecorder({ db, log, now, onNewNetwork: (row) => void a.check(row) });
    await r.record(from('1.1.1.1', 'Pune'), roshni, deviceId);
    // First connection ever: no baseline, no email.
    expect(outbox).toHaveLength(0);
    clock = new Date(clock.getTime() + 3_600_000);
    const row = await db.connections.insert({
      employeeId: roshni,
      deviceId,
      ip: '2.2.2.2',
      city: 'Mumbai',
      region: 'Maharashtra',
      country: 'IN',
      asn: null,
      provider: 'Airtel',
      firstSeenAt: clock,
      lastSeenAt: clock,
    });
    expect(await a.check(row)).toBe(true);
    expect(outbox).toEqual([
      expect.objectContaining({
        to: ['priya@aptask.com'],
        cc: ['owner@aptask.com'],
        subject: 'Roshni Test is connecting from a new place',
      }),
    ]);
    // The same place again (another computer, same day): once only.
    expect(await a.check({ ...row, id: randomUUID() })).toBe(false);
    expect(outbox).toHaveLength(1);
  });

  it('off unless switched on; no manager means Administrators only', async () => {
    await settings(false);
    const pune = await db.connections.insert({ ...conn({}), employeeId: priya });
    const mumbai = await db.connections.insert({
      ...conn({ city: 'Mumbai', firstSeenAt: clock, lastSeenAt: clock }),
      employeeId: priya,
    });
    expect(pune.id).not.toBe(mumbai.id);
    expect(await alerts().check(mumbai)).toBe(false);
    await settings(true);
    expect(await alerts().check(mumbai)).toBe(true);
    expect(outbox[0]).toMatchObject({ to: ['owner@aptask.com'], cc: [] });
  });
});
