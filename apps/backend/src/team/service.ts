import { Capability } from '@cloudpunch/shared';
import type { DbRepositories, Employee } from '../db/index.js';
import { MAX_GAP_MS, totals, type DaySegment, type WorkingDay } from '../days/build.js';
import { daysAround, rulesFor } from '../days/service.js';
import { effectivePolicyFor } from '../policy/service.js';
import { activeWindow, shiftDate, type ShiftWindow } from '../shifts/model.js';
import { alertSettings } from '../alerts/settings.js';

/**
 * Manager and HR team views (ADR-0025). Pure helpers plus the reads
 * behind `/v1/team`. Who may see whom is decided here, server-side, on
 * every request (CLAUDE.md invariant 5).
 */

/** Whose days the caller may see (ADR-0025 §2). */
export type TeamScope = { kind: 'all' } | { kind: 'reports'; managerId: string } | { kind: 'none' };

/**
 * HR (team timeline + employee read) sees everyone; a Manager sees
 * direct reports; anyone else, no one. Both roles: the wider scope.
 */
export function scopeFor(
  capabilities: ReadonlySet<string>,
  callerEmployeeId: string | null,
): TeamScope {
  if (!capabilities.has(Capability.TeamTimelineRead)) return { kind: 'none' };
  if (capabilities.has(Capability.HrEmployeeRead)) return { kind: 'all' };
  return callerEmployeeId ? { kind: 'reports', managerId: callerEmployeeId } : { kind: 'none' };
}

export function inScope(scope: TeamScope, subject: Employee): boolean {
  if (subject.status !== 'active') return false;
  if (scope.kind === 'all') return true;
  if (scope.kind === 'reports') return subject.reportingManagerId === scope.managerId;
  return false;
}

/** The people the caller may see, by name. */
export async function peopleIn(db: DbRepositories, scope: TeamScope): Promise<Employee[]> {
  if (scope.kind === 'all') return db.employees.listActive();
  if (scope.kind === 'reports') return db.employees.listReports(scope.managerId);
  return [];
}

export const nameOf = (e: Employee): string =>
  e.displayName ?? `${e.givenName} ${e.familyName}`.trim();

export type LiveStatus =
  | 'clocked_out'
  | 'working'
  | 'on_call'
  | 'on_break'
  | 'away'
  | 'prompt'
  | 'idle'
  /** In their shift, not clocked in since it started (ADR-0031 §2); `since` = shift start. */
  | 'shift_not_started'
  /** Said "Not working today" for the shift they're in (ADR-0031 §2). */
  | 'not_working'
  /** Their shift today falls on a company holiday (ADR-0037 §2); see `holiday`. */
  | 'holiday';

export interface PersonNow {
  employee_id: string;
  name: string;
  status: LiveStatus;
  /** The segment kind now (`personal_break`, `away_meeting`, …); null when clocked out. */
  kind: string | null;
  /** ISO time the current status began; for clocked out, the last clock-out today. */
  since: string | null;
  /** On a planned break: when they said they'd be back. */
  back_by: string | null;
  /** Worked time in the current working day, ms. */
  worked_ms: number;
  /** The holiday's name, when `status` is `holiday` (ADR-0037 §2). */
  holiday?: string;
  /**
   * Missed starts and "not working" days in the last `days` days
   * (ADR-0037 §4), when there are any; `regular` at or over the
   * threshold. Counted from when the shift emails were switched on.
   */
  starts?: { missed: number; not_working: number; days: number; regular: boolean };
}

function statusOf(kind: string): LiveStatus {
  if (kind === 'working') return 'working';
  if (kind.startsWith('call_')) return 'on_call';
  if (kind.endsWith('_break')) return 'on_break';
  if (kind.startsWith('away_')) return 'away';
  if (kind === 'prompt') return 'prompt';
  return 'idle';
}

/**
 * Pure: someone's status now from their latest working day. A day that
 * ended more than 6 hours ago isn't "today" (ADR-0016 §1).
 */
export function statusFrom(
  employee: Employee,
  day: WorkingDay | undefined,
  now: Date,
  workedMs: number,
): PersonNow {
  const base: PersonNow = {
    employee_id: employee.id,
    name: nameOf(employee),
    status: 'clocked_out',
    kind: null,
    since: null,
    back_by: null,
    worked_ms: 0,
  };
  const last = day?.sessions.at(-1);
  if (!day || !last) return base;
  if (!last.open) {
    if (now.getTime() - last.end.getTime() > MAX_GAP_MS) return base;
    return { ...base, since: last.end.toISOString(), worked_ms: workedMs };
  }
  const seg: DaySegment | undefined = last.segments.at(-1);
  if (!seg) return { ...base, status: 'working', kind: 'working', worked_ms: workedMs };
  return {
    ...base,
    status: statusOf(seg.kind),
    kind: seg.kind,
    since: seg.startedAt.toISOString(),
    back_by:
      seg.plannedMinutes !== undefined
        ? new Date(seg.startedAt.getTime() + seg.plannedMinutes * 60_000).toISOString()
        : null,
    worked_ms: workedMs,
  };
}

/**
 * Pure: a clocked-out person in their shift (ADR-0031 §2). If nothing
 * they worked touches the shift yet, they haven't started it, or said
 * they aren't working, or it's a holiday (ADR-0037 §2); otherwise
 * "clocked out" stands.
 */
export function withShift(
  p: PersonNow,
  window: ShiftWindow | null,
  days: readonly WorkingDay[],
  saidNotWorking: boolean,
  holiday: string | null = null,
): PersonNow {
  if (p.status !== 'clocked_out' || !window) return p;
  const started = days.some((d) =>
    d.sessions.some((s) => s.clockIn < window.end && s.end > window.start),
  );
  if (started) return p;
  if (holiday !== null) return { ...p, status: 'holiday', holiday };
  return {
    ...p,
    status: saidNotWorking ? 'not_working' : 'shift_not_started',
    since: window.start.toISOString(),
  };
}

/** Team today: each person's status now (ADR-0025 §3), with their shift (ADR-0031). */
export async function teamNow(
  db: DbRepositories,
  people: readonly Employee[],
  now: Date,
): Promise<PersonNow[]> {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const shiftRows = await db.shifts.history(people.map((p) => p.id));
  // Shift dates are within a day of the UTC date, whatever the zone.
  const holidays = new Map(
    (await db.holidays.between(yesterday, shiftDate(today, 1))).map((h) => [h.date, h.name]),
  );
  const out: PersonNow[] = [];
  for (const e of people) {
    const days = await daysAround(db, e.id, yesterday, today, now);
    const day = days.at(-1);
    const p = statusFrom(e, day, now, day ? totals(day).worked_ms : 0);
    const window = activeWindow(
      shiftRows.filter((r) => r.employeeId === e.id),
      now,
    );
    const said = window ? (await db.shifts.notWorking([e.id], [window.date])).size > 0 : false;
    out.push(withShift(p, window, days, said, window ? (holidays.get(window.date) ?? null) : null));
  }
  return withStarts(db, out, today);
}

/** ADR-0037 §4: each person's missed starts and "not working" days. */
async function withStarts(
  db: DbRepositories,
  people: PersonNow[],
  today: string,
): Promise<PersonNow[]> {
  const s = await alertSettings(db);
  const counts = await db.shiftAlerts.countsSince(shiftDate(today, -s.regularDays));
  return people.map((p) => {
    const c = counts.get(p.employee_id);
    if (!c || (c.missed === 0 && c.notWorking === 0)) return p;
    return {
      ...p,
      starts: {
        missed: c.missed,
        not_working: c.notWorking,
        days: s.regularDays,
        regular: c.missed >= s.regularCount,
      },
    };
  });
}

export type ExceptionKind =
  | 'long_idle'
  | 'break_over_planned'
  | 'break_over_limit'
  | 'long_shift'
  | 'auto_clock_out'
  | 'reconstructed'
  | 'presence_check'
  | 'long_away';

export interface TeamException {
  employee_id: string;
  name: string;
  /** The working day it belongs to. */
  date: string;
  kind: ExceptionKind;
  at: string;
  /** Length in minutes (idle, break, shift), when it has one. */
  minutes: number | null;
  /** Break: planned or limit minutes it went over; idle: null. */
  over_minutes: number | null;
  /** Segment kind for breaks and idle (`personal_break`, `idle`). */
  segment: string | null;
  /** Idle: the person's own account (ADR-0018 §2). */
  explanation: { explanation: string; note: string | null } | null;
  /** Presence check (ADR-0024): the pattern, and whether it was answered in time. */
  pattern?: 'continuous' | 'periodic';
  answered?: boolean;
  /** Long Away (ADR-0027): how it ended, if on its own. */
  ended_by?: 'input' | 'call';
}

/** Idle this long or longer is an exception (ADR-0025 §3). */
export const LONG_IDLE_MIN = 15;

const mins = (ms: number): number => Math.round(ms / 60_000);

/**
 * Pure: one person's exceptions in `days`. `limits` are the break
 * reminder limits by segment kind; `longShiftHours` from the policy.
 */
export function exceptionsIn(
  employee: Employee,
  days: readonly WorkingDay[],
  limits: Readonly<Record<string, number | null>>,
  longShiftHours: number,
  rules: Parameters<typeof totals>[1],
  longAwayMinutes = 60,
): TeamException[] {
  const out: TeamException[] = [];
  const base = { employee_id: employee.id, name: nameOf(employee) };
  for (const day of days) {
    for (const s of day.sessions) {
      if (
        s.session.closedReason === 'idle_cap' ||
        s.session.closedReason === 'idle_auto_clock_out'
      ) {
        out.push({
          ...base,
          date: day.date,
          kind: 'auto_clock_out',
          at: s.end.toISOString(),
          minutes: null,
          over_minutes: null,
          segment: null,
          explanation: null,
        });
      }
      if (s.session.reconstructed) {
        out.push({
          ...base,
          date: day.date,
          kind: 'reconstructed',
          at: s.clockIn.toISOString(),
          minutes: null,
          over_minutes: null,
          segment: null,
          explanation: null,
        });
      }
      for (const [i, g] of s.segments.entries()) {
        const len = mins(g.endedAt.getTime() - g.startedAt.getTime());
        const at = g.startedAt.toISOString();
        // A check shows as its prompt if answered; unanswered, its idle
        // (dated from when the pattern began) replaces the prompt.
        if (g.presenceCheck && (g.kind === 'prompt' || g.kind === 'idle')) {
          const answered = g.kind === 'prompt';
          if (!(answered && s.segments[i + 1]?.presenceCheck)) {
            out.push({
              ...base,
              date: day.date,
              kind: 'presence_check',
              at,
              minutes: answered ? null : len,
              over_minutes: null,
              segment: g.kind,
              explanation: answered ? null : (g.explanation ?? null),
              pattern: g.presenceCheck,
              answered,
            });
          }
        }
        if (g.kind.startsWith('away_') && len >= longAwayMinutes) {
          out.push({
            ...base,
            date: day.date,
            kind: 'long_away',
            at,
            minutes: len,
            over_minutes: null,
            segment: g.kind,
            explanation: null,
            ...(g.endedBy ? { ended_by: g.endedBy } : {}),
          });
        }
        if (g.kind === 'idle' && len >= LONG_IDLE_MIN) {
          out.push({
            ...base,
            date: day.date,
            kind: 'long_idle',
            at,
            minutes: len,
            over_minutes: null,
            segment: g.kind,
            explanation: g.explanation ?? null,
          });
        }
        if (!g.kind.endsWith('_break')) continue;
        if (g.plannedMinutes !== undefined && len > g.plannedMinutes) {
          out.push({
            ...base,
            date: day.date,
            kind: 'break_over_planned',
            at,
            minutes: len,
            over_minutes: len - g.plannedMinutes,
            segment: g.kind,
            explanation: null,
          });
        }
        const limit = limits[g.kind];
        if (limit !== undefined && limit !== null && len > limit) {
          out.push({
            ...base,
            date: day.date,
            kind: 'break_over_limit',
            at,
            minutes: len,
            over_minutes: len - limit,
            segment: g.kind,
            explanation: null,
          });
        }
      }
    }
    const worked = totals(day, rules).worked_ms;
    if (worked > longShiftHours * 3_600_000) {
      const first = day.sessions[0];
      out.push({
        ...base,
        date: day.date,
        kind: 'long_shift',
        at: (first?.clockIn ?? new Date(0)).toISOString(),
        minutes: mins(worked),
        over_minutes: mins(worked - longShiftHours * 3_600_000),
        segment: null,
        explanation: null,
      });
    }
  }
  return out;
}

/** Exceptions for `people` over [from, to] (ADR-0025 §3), newest first. */
export async function teamExceptions(
  db: DbRepositories,
  people: readonly Employee[],
  from: string,
  to: string,
  now: Date,
): Promise<TeamException[]> {
  const out: TeamException[] = [];
  for (const e of people) {
    const days = (await daysAround(db, e.id, from, to, now)).filter(
      (d) => d.date >= from && d.date <= to,
    );
    const rules = await rulesFor(db, e.id);
    const limits = Object.fromEntries(Object.entries(rules).map(([k, r]) => [k, r.maxMinutes]));
    const policy = (await effectivePolicyFor(db, e)).policy;
    const reminders = (policy['reminders'] ?? {}) as Record<string, unknown>;
    const longShift =
      typeof reminders['long_shift_hours'] === 'number' ? reminders['long_shift_hours'] : 9;
    const away = (policy['away'] ?? {}) as Record<string, unknown>;
    const longAway =
      typeof away['check_after_minutes'] === 'number' ? away['check_after_minutes'] : 60;
    out.push(...exceptionsIn(e, days, limits, longShift, rules, longAway));
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
