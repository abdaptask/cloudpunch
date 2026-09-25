import type { DbRepositories } from '../db/index.js';
import {
  buildSession,
  isoWithOffset,
  totals,
  workingDays,
  type BuiltSession,
  type DayTotals,
  type WorkingDay,
} from './build.js';

/** ADR-0016 §4: today and the previous 30 days. */
export const LOOKBACK_DAYS = 30;

const DAY_MS = 86_400_000;

export interface DaySessionView {
  session_id: string;
  device_id: string;
  tz_iana: string;
  clock_in: string;
  clock_out: string | null;
  close_reason: string | null;
  reconstructed: boolean;
  open: boolean;
  segments: { kind: string; started_at: string; ended_at: string }[];
}

export interface DayView {
  date: string;
  sessions: DaySessionView[];
  totals: DayTotals;
}

export interface DaySummary extends DayTotals {
  date: string;
  sessions: number;
}

/** Midnight UTC of a `YYYY-MM-DD`. */
function utcMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * Working days touching [firstDate, lastDate]. Sessions are loaded with
 * two days' margin on each side, so a day that starts or ends near the
 * edge (other zones, the 6-hour chaining) is complete.
 */
async function daysAround(
  db: DbRepositories,
  employeeId: string,
  firstDate: string,
  lastDate: string,
  now: Date,
): Promise<WorkingDay[]> {
  const from = new Date(utcMidnight(firstDate) - 2 * DAY_MS);
  const to = new Date(utcMidnight(lastDate) + 3 * DAY_MS);
  const sessions = await db.timeSessions.findByEmployeeOpenedBetween(employeeId, from, to);
  const built: BuiltSession[] = [];
  for (const s of sessions) {
    const events = await db.timeEvents.findBySessionOrderedBySequence(s.id);
    const b = buildSession(s, events, now);
    if (b) built.push(b);
  }
  return workingDays(built);
}

function sessionView(s: BuiltSession): DaySessionView {
  const lastOffset = s.segments.at(-1)?.offsetMinutes ?? s.offsetMinutes;
  return {
    session_id: s.session.id,
    device_id: s.session.deviceId,
    tz_iana: s.tzIana,
    clock_in: isoWithOffset(s.clockIn, s.offsetMinutes),
    clock_out: s.open ? null : isoWithOffset(s.end, lastOffset),
    close_reason: s.session.closedReason,
    reconstructed: s.session.reconstructed,
    open: s.open,
    segments: s.segments.map((g) => ({
      kind: g.kind,
      started_at: isoWithOffset(g.startedAt, g.offsetMinutes),
      ended_at: isoWithOffset(g.endedAt, g.offsetMinutes),
    })),
  };
}

/** `GET /v1/me/days/{date}`: the working day dated `date`. */
export async function dayView(
  db: DbRepositories,
  employeeId: string,
  date: string,
  now: Date,
): Promise<DayView> {
  const day = (await daysAround(db, employeeId, date, date, now)).find((d) => d.date === date);
  return {
    date,
    sessions: day ? day.sessions.map(sessionView) : [],
    totals: totals(day ?? null),
  };
}

/** `GET /v1/me/days?from&to`: totals for each working day in range. */
export async function daySummaries(
  db: DbRepositories,
  employeeId: string,
  from: string,
  to: string,
  now: Date,
): Promise<DaySummary[]> {
  const days = await daysAround(db, employeeId, from, to, now);
  return days
    .filter((d) => d.date >= from && d.date <= to)
    .map((d) => ({ date: d.date, sessions: d.sessions.length, ...totals(d) }));
}

/**
 * Whether `date` is a real `YYYY-MM-DD` inside the look-back. Zones run
 * from UTC-12 to UTC+14, so "today" is allowed one day either side of
 * the UTC date.
 */
export function inLookback(date: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const t = utcMidnight(date);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) return false;
  const today = utcMidnight(now.toISOString().slice(0, 10));
  return t >= today - (LOOKBACK_DAYS + 1) * DAY_MS && t <= today + DAY_MS;
}

/** Days from `from` to `to`, inclusive. */
export function spanDays(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS) + 1;
}
