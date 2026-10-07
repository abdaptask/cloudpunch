import type { CorrectionWithDecisions, DbRepositories } from '../db/index.js';
import {
  buildSession,
  isoWithOffset,
  localDate,
  totals,
  workingDays,
  type BuiltSession,
  type DayTotals,
  type WorkingDay,
} from './build.js';
import { effectivePolicyFor } from '../policy/service.js';
import { applyCorrections, correctionStatus, type CorrectionStatus } from './corrections.js';
import { breakRules, DEFAULT_BREAK_RULES, type BreakRules } from './pay.js';

/** ADR-0016 §4: today and the previous 30 days. */
export const LOOKBACK_DAYS = 30;

const DAY_MS = 86_400_000;

export interface DaySessionView {
  session_id: string;
  device_id: string;
  tz_iana: string;
  clock_in: string;
  clock_out: string | null;
  /** `corrected` for a session made only of an approved correction. */
  close_reason: string | null;
  reconstructed: boolean;
  open: boolean;
  /** Made only of an approved correction (ADR-0030 §4); no device recorded it. */
  corrected?: true;
  /** Started from the Windows sign-in time (ADR-0018 §4). */
  started_from_sign_in: boolean;
  segments: {
    kind: string;
    started_at: string;
    ended_at: string;
    /** Idle stretches: the person's account, if they gave one. */
    explanation?: { explanation: string; note: string | null };
    /** Breaks: the "Back in?" answer (ADR-0023 §2), extensions included. */
    planned_minutes?: number;
    /** Minutes added with "5 / 10 more min" (ADR-0031 §3). */
    extended_minutes?: number;
    /** A presence check's prompt or idle (ADR-0024). */
    presence_check?: 'continuous' | 'periodic';
    /** An Away that ended on its own (ADR-0027). */
    ended_by?: 'input' | 'call';
    /** This stretch is an approved correction's (ADR-0030 §4). */
    correction_id?: string;
  }[];
}

/** A correction touching the day, whatever its status (ADR-0030 §4: nothing hidden). */
export interface DayCorrectionView {
  id: string;
  from: string;
  to: string;
  kind: string;
  reason: string;
  status: CorrectionStatus;
  requested_by: string;
  requested_at: string;
  decisions: { decision: string; by: string; at: string; note: string | null }[];
}

export interface DayView {
  date: string;
  sessions: DaySessionView[];
  totals: DayTotals;
  corrections: DayCorrectionView[];
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
 * edge (other zones, the 6-hour chaining) is complete. Approved time
 * corrections are laid over them first (ADR-0030 §4), so every total
 * and status that starts here counts them.
 */
export async function daysAround(
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
  const corrections = await db.corrections.listForEmployee(employeeId, from, to);
  return workingDays(applyCorrections(built, corrections));
}

/**
 * The employee's break pay rules: their policy as it stands now
 * (ADR-0023 §3; policy history isn't kept, see the ADR's note).
 */
export async function rulesFor(db: DbRepositories, employeeId: string): Promise<BreakRules> {
  const employee = await db.employees.findById(employeeId);
  if (!employee) return DEFAULT_BREAK_RULES;
  return breakRules((await effectivePolicyFor(db, employee)).policy);
}

function sessionView(s: BuiltSession): DaySessionView {
  const lastOffset = s.segments.at(-1)?.offsetMinutes ?? s.offsetMinutes;
  return {
    session_id: s.session.id,
    device_id: s.session.deviceId,
    tz_iana: s.tzIana,
    clock_in: isoWithOffset(s.clockIn, s.offsetMinutes),
    clock_out: s.open ? null : isoWithOffset(s.end, lastOffset),
    close_reason: s.corrected ? 'corrected' : s.session.closedReason,
    reconstructed: s.session.reconstructed,
    open: s.open,
    ...(s.corrected ? { corrected: true as const } : {}),
    started_from_sign_in: s.startedFromSignIn,
    segments: s.segments.map((g) => ({
      kind: g.kind,
      started_at: isoWithOffset(g.startedAt, g.offsetMinutes),
      ended_at: isoWithOffset(g.endedAt, g.offsetMinutes),
      ...(g.explanation ? { explanation: g.explanation } : {}),
      ...(g.plannedMinutes !== undefined ? { planned_minutes: g.plannedMinutes } : {}),
      ...(g.extendedMinutes ? { extended_minutes: g.extendedMinutes } : {}),
      ...(g.presenceCheck ? { presence_check: g.presenceCheck } : {}),
      ...(g.endedBy ? { ended_by: g.endedBy } : {}),
      ...(g.correctionId ? { correction_id: g.correctionId } : {}),
    })),
  };
}

/** A user's display name, for who asked and who decided. */
async function nameOf(db: DbRepositories, userId: string, cache: Map<string, string>) {
  const known = cache.get(userId);
  if (known !== undefined) return known;
  const name = (await db.users.findById(userId))?.displayName ?? 'Someone';
  cache.set(userId, name);
  return name;
}

export async function correctionView(
  db: DbRepositories,
  c: CorrectionWithDecisions,
  names: Map<string, string>,
): Promise<DayCorrectionView> {
  const decisions = [];
  for (const d of c.decisions) {
    decisions.push({
      decision: d.decision,
      by: await nameOf(db, d.decidedByUserId, names),
      at: d.decidedAt.toISOString(),
      note: d.note,
    });
  }
  return {
    id: c.id,
    from: isoWithOffset(c.fromAt, c.utcOffsetMinutes),
    to: isoWithOffset(c.toAt, c.utcOffsetMinutes),
    kind: c.kind,
    reason: c.reason,
    status: correctionStatus(c),
    requested_by: await nameOf(db, c.requestedByUserId, names),
    requested_at: c.requestedAt.toISOString(),
    decisions,
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
  // Corrections dated this day, or touching one of its sessions.
  const nearby = await db.corrections.listForEmployee(
    employeeId,
    new Date(utcMidnight(date) - DAY_MS),
    new Date(utcMidnight(date) + 2 * DAY_MS),
  );
  const span = day
    ? [
        day.sessions[0]?.clockIn.getTime() ?? 0,
        Math.max(...day.sessions.map((s) => s.end.getTime())),
      ]
    : null;
  const names = new Map<string, string>();
  const corrections: DayCorrectionView[] = [];
  for (const c of nearby) {
    const dated = localDate(c.fromAt, c.utcOffsetMinutes) === date;
    const touches =
      span !== null && c.fromAt.getTime() < (span[1] ?? 0) && c.toAt.getTime() > (span[0] ?? 0);
    if (dated || touches) corrections.push(await correctionView(db, c, names));
  }
  return {
    date,
    sessions: day ? day.sessions.map(sessionView) : [],
    totals: totals(day ?? null, await rulesFor(db, employeeId)),
    corrections,
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
  const rules = await rulesFor(db, employeeId);
  return days
    .filter((d) => d.date >= from && d.date <= to)
    .map((d) => ({ date: d.date, sessions: d.sessions.length, ...totals(d, rules) }));
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
