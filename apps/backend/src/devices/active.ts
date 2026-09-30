import type { DbRepositories, DeviceOs, TimeSession } from '../db/index.js';

/**
 * One machine at a time (ADR-0028): which machine someone is working
 * on. "Working" means clocked in, i.e. an open session (§1).
 */

export interface ActiveDevice {
  session: TimeSession;
  deviceId: string;
  os: DeviceOs;
  enrolledAt: Date;
  openedAt: Date;
}

/** The employee's open session and the device it is on, if any. */
export async function activeDeviceOf(
  db: DbRepositories,
  employeeId: string,
): Promise<ActiveDevice | null> {
  const session = await db.timeSessions.findOpenByEmployeeId(employeeId);
  if (!session) return null;
  const device = await db.devices.findById(session.deviceId);
  if (!device) return null; // unreachable: time_session.device_id is a foreign key
  return {
    session,
    deviceId: device.id,
    os: device.os,
    enrolledAt: device.enrolledAt,
    openedAt: session.openedAt,
  };
}

/**
 * When the session last heard from its machine: its latest event's
 * `client_ts`, or `opened_at` if it has none, kept within
 * [opened_at, now]. An admin sign-out closes the session here, so no
 * time is invented (ADR-0028 §4, like ADR-0003 §10).
 */
export async function lastEventAt(
  db: DbRepositories,
  session: TimeSession,
  now: Date,
): Promise<Date> {
  const events = await db.timeEvents.findBySessionOrderedBySequence(session.id);
  const latest = events.reduce<Date>((t, e) => (e.clientTs > t ? e.clientTs : t), session.openedAt);
  if (latest > now) return now < session.openedAt ? session.openedAt : now;
  return latest;
}
