import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryDb } from '../db/in-memory.js';
import { ConnectionRecorder, SETTING_TTL_MS, TOUCH_EVERY_MS } from './recorder.js';

const log = pino({ level: 'silent' });
const employeeId = randomUUID();
const deviceId = randomUUID();
const viaCloudflare = (ip: string) => ({
  ip,
  headers: { 'cf-ray': 'x', 'cf-ipcity': 'Pune', 'cf-region': 'Maharashtra', 'cf-ipcountry': 'IN' },
});

let db: InMemoryDb;
let clock: Date;
const now = () => clock;
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

async function turnOn(on = true) {
  await db.policies.put(
    {
      scope: 'global',
      scopeId: null,
      reason: null,
      actorUserId: randomUUID(),
      correlationId: randomUUID(),
      at: clock,
    },
    { connections: { record: on } },
  );
}

beforeEach(() => {
  db = new InMemoryDb();
  clock = new Date('2026-10-01T09:00:00Z');
});

describe('ConnectionRecorder', () => {
  it('records nothing while connections.record is off (the default)', async () => {
    const r = new ConnectionRecorder({ db, log, now });
    await r.record(viaCloudflare('58.84.61.202'), employeeId, deviceId);
    expect(db.connectionRows).toHaveLength(0);
  });

  it('writes one row per network, touching it at most every 15 minutes', async () => {
    await turnOn();
    const r = new ConnectionRecorder({ db, log, now });
    await r.record(viaCloudflare('58.84.61.202'), employeeId, deviceId);
    expect(db.connectionRows).toEqual([
      expect.objectContaining({
        employeeId,
        deviceId,
        ip: '58.84.61.202',
        city: 'Pune',
        region: 'Maharashtra',
        country: 'IN',
        asn: null,
        provider: null,
        firstSeenAt: clock,
        lastSeenAt: clock,
      }),
    ]);
    const first = clock;

    later(TOUCH_EVERY_MS - 1);
    await r.record(viaCloudflare('58.84.61.202'), employeeId, deviceId);
    expect(db.connectionRows[0]?.lastSeenAt).toEqual(first);

    later(1);
    await r.record(viaCloudflare('58.84.61.202'), employeeId, deviceId);
    expect(db.connectionRows).toHaveLength(1);
    expect(db.connectionRows[0]?.lastSeenAt).toEqual(clock);
  });

  it('adds a row when the network changes', async () => {
    await turnOn();
    const r = new ConnectionRecorder({ db, log, now });
    await r.record(viaCloudflare('58.84.61.202'), employeeId, deviceId);
    later(60_000);
    await r.record(viaCloudflare('202.71.156.179'), employeeId, deviceId);
    expect(db.connectionRows.map((c) => c.ip)).toEqual(['58.84.61.202', '202.71.156.179']);
  });

  it('keeps one row while an IPv6 address changes within its /64', async () => {
    await turnOn();
    const r = new ConnectionRecorder({ db, log, now });
    await r.record(viaCloudflare('2402:e280:3e8f:1d7:4db:8a24:7d9e:5c4'), employeeId, deviceId);
    later(TOUCH_EVERY_MS);
    await r.record(viaCloudflare('2402:e280:3e8f:1d7::99'), employeeId, deviceId);
    expect(db.connectionRows).toHaveLength(1);
    expect(db.connectionRows[0]?.ip).toBe('2402:e280:3e8f:1d7:4db:8a24:7d9e:5c4');
  });

  it("carries on with the device's latest row after a restart", async () => {
    await turnOn();
    await new ConnectionRecorder({ db, log, now }).record(
      viaCloudflare('58.84.61.202'),
      employeeId,
      deviceId,
    );
    later(TOUCH_EVERY_MS);
    await new ConnectionRecorder({ db, log, now }).record(
      viaCloudflare('58.84.61.202'),
      employeeId,
      deviceId,
    );
    expect(db.connectionRows).toHaveLength(1);
    expect(db.connectionRows[0]?.lastSeenAt).toEqual(clock);
  });

  it('writes one row when two requests from a new network arrive together', async () => {
    await turnOn();
    const r = new ConnectionRecorder({ db, log, now });
    await Promise.all([
      r.record(viaCloudflare('58.84.61.202'), employeeId, deviceId),
      r.record(viaCloudflare('58.84.61.202'), employeeId, deviceId),
    ]);
    expect(db.connectionRows).toHaveLength(1);
  });

  it('notices the setting going off within a minute', async () => {
    await turnOn();
    const r = new ConnectionRecorder({ db, log, now });
    await r.record(viaCloudflare('58.84.61.202'), employeeId, deviceId);
    await turnOn(false);
    later(SETTING_TTL_MS);
    await r.record(viaCloudflare('202.71.156.179'), employeeId, deviceId);
    expect(db.connectionRows).toHaveLength(1);
  });

  it('never fails the request it is recording', async () => {
    await turnOn();
    db.connections.insert = () => Promise.reject(new Error('database is down'));
    const r = new ConnectionRecorder({ db, log, now });
    await expect(
      r.record(viaCloudflare('58.84.61.202'), employeeId, deviceId),
    ).resolves.toBeUndefined();
  });
});
