import type { DbRepositories, Employee } from '../db/index.js';
import { localDate, totals, type WorkingDay } from '../days/build.js';
import { correctionStatus } from '../days/corrections.js';
import { daysAround, rulesFor } from '../days/service.js';
import type { BreakRules } from '../days/pay.js';
import { alertSettings } from '../alerts/settings.js';
import { firstClockInFor } from '../alerts/rules.js';
import { officeDays } from '../office/model.js';
import { shiftDate, windowOn, type ShiftWindow } from '../shifts/model.js';
import { shiftHistory } from '../shifts/resolve.js';
import { nameOf } from '../team/service.js';

/**
 * ADR-0040 §1: one person's day, for the day-end email, Reports → Day
 * summary and (later) the overview. Built from the same working days
 * Team shows, plus what the shift says. Totals and statuses only.
 */

export type DayStatus =
  | 'worked'
  /** Clocked in more than the missed clock-in grace after the shift start. */
  | 'late'
  /** A shift day with no clock-in touching the shift. */
  | 'not_clocked_in'
  /** Said "Not working today" (ADR-0031 §2). */
  | 'not_working'
  | 'holiday'
  /** In the office (ADR-0039): not tracked. */
  | 'in_office'
  /** No shift that day and nothing worked. */
  | 'off';

export interface DayRow {
  employee_id: string;
  name: string;
  manager_id: string | null;
  date: string;
  status: DayStatus;
  /** The holiday's name, when there is one. */
  holiday?: string;
  /** The shift that day, if any. */
  shift: { start: string; end: string } | null;
  /** The zone times are shown in: the shift's, else the first clock-in's, else India. */
  tz: string;
  clock_in: string | null;
  /** The last clock-out; null while still clocked in or not worked. */
  clock_out: string | null;
  still_in: boolean;
  /** Minutes after the shift start of the first clock-in touching the shift. */
  minutes_late: number | null;
  /** Work, calls and Away (ADR-0016 totals). */
  worked_ms: number;
  shift_ms: number;
  idle_ms: number;
  breaks_ms: number;
  /** Breaks longer than their limit (ADR-0023). */
  breaks_over_limit: number;
  away_ms: number;
  /** Corrections dated this day still waiting for a decision (ADR-0030). */
  corrections_waiting: number;
  /**
   * The day as a timeline, for the visual report: work (incl. calls and
   * Away), breaks and idle (incl. the prompt), adjacent runs merged.
   * Kinds only, never what anyone was doing (invariant 1).
   */
  segments: DaySpan[];
}

export type SpanKind = 'work' | 'break' | 'idle';

export interface DaySpan {
  kind: SpanKind;
  from: string;
  to: string;
}

const spanKind = (kind: string): SpanKind =>
  kind.endsWith('_break') ? 'break' : kind === 'idle' || kind === 'prompt' ? 'idle' : 'work';

/** Pure: a working day's segments as merged spans of the three kinds. */
export function spansOf(day: WorkingDay | undefined): DaySpan[] {
  const out: { kind: SpanKind; from: Date; to: Date }[] = [];
  for (const s of day?.sessions ?? []) {
    for (const g of s.segments) {
      if (g.endedAt <= g.startedAt) continue;
      const kind = spanKind(g.kind);
      const last = out.at(-1);
      if (last && last.kind === kind && last.to.getTime() === g.startedAt.getTime()) {
        last.to = g.endedAt;
      } else {
        out.push({ kind, from: g.startedAt, to: g.endedAt });
      }
    }
  }
  return out.map((x) => ({ kind: x.kind, from: x.from.toISOString(), to: x.to.toISOString() }));
}

export const INDIA_TZ = 'Asia/Kolkata';

export interface DayInput {
  employee: Employee;
  date: string;
  window: ShiftWindow | null;
  holiday: string | null;
  inOffice: boolean;
  saidNotWorking: boolean;
  /** Working days around the date (a day either side is enough). */
  days: readonly WorkingDay[];
  rules: BreakRules;
  graceMinutes: number;
  correctionsWaiting: number;
}

const overlaps = (d: WorkingDay, w: ShiftWindow): boolean =>
  d.sessions.some((s) => s.clockIn < w.end && s.end > w.start);

/** Pure: the row for one person and date. */
export function dayRow(i: DayInput): DayRow {
  const w = i.window;
  // The working day that touches the shift; without one, the day dated `date`.
  const day =
    (w ? i.days.find((d) => overlaps(d, w)) : undefined) ?? i.days.find((d) => d.date === i.date);
  const t = totals(day ?? null, i.rules);
  let away = 0;
  let over = 0;
  for (const s of day?.sessions ?? []) {
    for (const g of s.segments) {
      const ms = g.endedAt.getTime() - g.startedAt.getTime();
      if (g.kind.startsWith('away_')) away += ms;
      const limit = i.rules[g.kind]?.maxMinutes;
      if (g.kind.endsWith('_break') && limit != null && Math.round(ms / 60_000) > limit) over++;
    }
  }
  const first = day?.sessions[0];
  const last = day?.sessions.at(-1);
  const inShift = w && day ? firstClockInFor(w, day.sessions) : null;
  const late =
    w && inShift ? Math.max(0, Math.round((inShift.getTime() - w.start.getTime()) / 60_000)) : null;

  let status: DayStatus;
  if (day) status = late !== null && late > i.graceMinutes ? 'late' : 'worked';
  else if (!w) status = 'off';
  else if (i.holiday !== null) status = 'holiday';
  else if (i.inOffice) status = 'in_office';
  else if (i.saidNotWorking) status = 'not_working';
  else status = 'not_clocked_in';

  return {
    employee_id: i.employee.id,
    name: nameOf(i.employee),
    manager_id: i.employee.reportingManagerId ?? null,
    date: i.date,
    status,
    ...(i.holiday !== null ? { holiday: i.holiday } : {}),
    shift: w ? { start: w.start.toISOString(), end: w.end.toISOString() } : null,
    tz: w?.shift.tzIana ?? first?.tzIana ?? INDIA_TZ,
    clock_in: first ? first.clockIn.toISOString() : null,
    clock_out: last && !last.open ? last.end.toISOString() : null,
    still_in: last?.open ?? false,
    minutes_late: late,
    worked_ms: t.worked_ms,
    shift_ms: w ? w.end.getTime() - w.start.getTime() : 0,
    idle_ms: t.idle_ms,
    breaks_ms: t.breaks_ms,
    breaks_over_limit: over,
    away_ms: away,
    corrections_waiting: i.correctionsWaiting,
    segments: spansOf(day),
  };
}

/** Rows for `people` on `date` (their shift date), in name order. */
export async function dayRows(
  db: DbRepositories,
  people: readonly Employee[],
  date: string,
  now: Date,
): Promise<DayRow[]> {
  return (await rangeRows(db, people, date, date, now)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/** Every date from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = shiftDate(d, 1)) out.push(d);
  return out;
}

/**
 * Rows for `people` on each date from `from` to `to` (ADR-0040 §3):
 * each person's days, rules and corrections are loaded once for the
 * whole range. By person, then date.
 */
export async function rangeRows(
  db: DbRepositories,
  people: readonly Employee[],
  from: string,
  to: string,
  now: Date,
): Promise<DayRow[]> {
  const ids = people.map((p) => p.id);
  const dates = datesBetween(from, to);
  if (ids.length === 0 || dates.length === 0) return [];
  const [history, holidays, notWorking, office, settings] = await Promise.all([
    shiftHistory(db, ids),
    db.holidays.between(from, to),
    db.shifts.notWorking(ids, dates),
    officeDays(db, ids, dates),
    alertSettings(db),
  ]);
  const holidayOn = new Map(holidays.map((h) => [h.date, h.name]));
  const loadFrom = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000);
  const loadTo = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86_400_000);
  const out: DayRow[] = [];
  for (const employee of people) {
    const rows = history.filter((r) => r.employeeId === employee.id);
    const days = await daysAround(db, employee.id, shiftDate(from, -1), shiftDate(to, 1), now);
    const rules = await rulesFor(db, employee.id);
    const waiting = (await db.corrections.listForEmployee(employee.id, loadFrom, loadTo)).filter(
      (c) => ['requested', 'endorsed'].includes(correctionStatus(c)),
    );
    for (const date of dates) {
      const key = `${employee.id}:${date}`;
      out.push(
        dayRow({
          employee,
          date,
          window: windowOn(rows, date),
          holiday: holidayOn.get(date) ?? null,
          inOffice: office.has(key),
          saidNotWorking: notWorking.has(key),
          days,
          rules,
          graceMinutes: settings.graceMinutes,
          correctionsWaiting: waiting.filter(
            (c) => localDate(c.fromAt, c.utcOffsetMinutes) === date,
          ).length,
        }),
      );
    }
  }
  return out;
}

/** Problems first: not clocked in, late, then the rest; by name within each. */
const ORDER: readonly DayStatus[] = [
  'not_clocked_in',
  'late',
  'not_working',
  'worked',
  'in_office',
  'holiday',
  'off',
];

export function problemsFirst(rows: readonly DayRow[]): DayRow[] {
  return [...rows].sort(
    (a, b) =>
      ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
      Number(b.corrections_waiting > 0) - Number(a.corrections_waiting > 0) ||
      a.name.localeCompare(b.name),
  );
}

/** How many of each status. */
export function countsOf(rows: readonly DayRow[]): Record<DayStatus, number> {
  const out: Record<DayStatus, number> = {
    worked: 0,
    late: 0,
    not_clocked_in: 0,
    not_working: 0,
    holiday: 0,
    in_office: 0,
    off: 0,
  };
  for (const r of rows) out[r.status]++;
  return out;
}
