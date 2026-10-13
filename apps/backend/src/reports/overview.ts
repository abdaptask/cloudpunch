import type { DbRepositories, Employee } from '../db/index.js';
import { isoWeekday, shiftDate } from '../shifts/model.js';
import { nameOf } from '../team/service.js';
import { rangeRows, type DayRow } from './day.js';

/**
 * ADR-0040 §3: the overall report for a range. Pure sums over the day
 * rows (§1), plus adoption and health. Totals only (§5).
 */

/** Days that had a shift to keep: not a holiday, office day or "not working". */
const SHIFT_DAY = new Set(['worked', 'late', 'not_clocked_in']);
const WORKED = new Set(['worked', 'late']);

export interface PersonTotals {
  employee_id: string;
  name: string;
  /** 1. Hours and attendance. */
  days_worked: number;
  shift_days: number;
  /** Shift days with a clock-in, of `shift_days`. */
  shift_days_worked: number;
  /** shift_days_worked ÷ shift_days; null without shift days. */
  attendance: number | null;
  worked_ms: number;
  scheduled_ms: number;
  /** 2. Lateness and missed starts. */
  late_starts: number;
  avg_minutes_late: number | null;
  missed_starts: number;
  /** 3. Idle, breaks and Away. */
  idle_ms: number;
  /** idle ÷ (worked + idle); null when nothing was tracked. */
  idle_share: number | null;
  breaks_ms: number;
  /** Break time per day worked. */
  break_ms_per_day: number | null;
  breaks_over_limit: number;
  away_ms: number;
}

export interface WeekTotals {
  /** The Monday it starts. */
  week: string;
  shift_days: number;
  shift_days_worked: number;
  late_starts: number;
  missed_starts: number;
  worked_ms: number;
  idle_ms: number;
}

export interface Health {
  active_people: number;
  /** Active people with a computer signed in to CloudPunch. */
  with_app: number;
  /** Active people who clocked in at least once in the range. */
  clocked_in: number;
  /** Active people with shift days in the range and no clock-in at all. */
  never_clocked_in: { employee_id: string; name: string }[];
  /** Computers seen in the last 30 days, by app version, newest first. */
  versions: { version: string; computers: number }[];
  newest_version: string | null;
  computers_behind: number;
  corrections_waiting: number;
}

export interface Overview {
  from: string;
  to: string;
  totals: Omit<PersonTotals, 'employee_id' | 'name'> & { people: number };
  people: PersonTotals[];
  weeks: WeekTotals[];
  health: Health;
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

type Sums = Omit<PersonTotals, 'employee_id' | 'name'>;

function sum(rows: readonly DayRow[]): Sums {
  let lateMinutes = 0;
  const s = {
    days_worked: 0,
    shift_days: 0,
    shift_days_worked: 0,
    worked_ms: 0,
    scheduled_ms: 0,
    late_starts: 0,
    missed_starts: 0,
    idle_ms: 0,
    breaks_ms: 0,
    breaks_over_limit: 0,
    away_ms: 0,
  };
  for (const r of rows) {
    const worked = WORKED.has(r.status);
    if (worked) s.days_worked++;
    if (SHIFT_DAY.has(r.status) && r.shift) {
      s.shift_days++;
      s.scheduled_ms += r.shift_ms;
      if (worked) s.shift_days_worked++;
    }
    if (r.status === 'late') {
      s.late_starts++;
      lateMinutes += r.minutes_late ?? 0;
    }
    if (r.status === 'not_clocked_in') s.missed_starts++;
    s.worked_ms += r.worked_ms;
    s.idle_ms += r.idle_ms;
    s.breaks_ms += r.breaks_ms;
    s.breaks_over_limit += r.breaks_over_limit;
    s.away_ms += r.away_ms;
  }
  return {
    ...s,
    attendance: ratio(s.shift_days_worked, s.shift_days),
    avg_minutes_late: s.late_starts > 0 ? Math.round(lateMinutes / s.late_starts) : null,
    idle_share: ratio(s.idle_ms, s.worked_ms + s.idle_ms),
    break_ms_per_day: s.days_worked > 0 ? Math.round(s.breaks_ms / s.days_worked) : null,
  };
}

/** The Monday of `date`'s week. */
export const weekOf = (date: string): string => shiftDate(date, 1 - isoWeekday(date));

/** Pure: per person, in total, and week by week. */
export function summarise(rows: readonly DayRow[]): Pick<Overview, 'totals' | 'people' | 'weeks'> {
  const byPerson = new Map<string, DayRow[]>();
  const byWeek = new Map<string, DayRow[]>();
  for (const r of rows) {
    byPerson.set(r.employee_id, [...(byPerson.get(r.employee_id) ?? []), r]);
    const w = weekOf(r.date);
    byWeek.set(w, [...(byWeek.get(w) ?? []), r]);
  }
  const people = [...byPerson.values()]
    .map((list) => ({
      employee_id: list[0]?.employee_id ?? '',
      name: list[0]?.name ?? '',
      ...sum(list),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const weeks = [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, list]) => {
      const s = sum(list);
      return {
        week,
        shift_days: s.shift_days,
        shift_days_worked: s.shift_days_worked,
        late_starts: s.late_starts,
        missed_starts: s.missed_starts,
        worked_ms: s.worked_ms,
        idle_ms: s.idle_ms,
      };
    });
  return { totals: { people: people.length, ...sum(rows) }, people, weeks };
}

/** "0.1.9" before "0.1.10". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const SEEN_DAYS = 30;

/** Adoption and health (ADR-0040 §3.4). */
export async function health(
  db: DbRepositories,
  people: readonly Employee[],
  totals: readonly PersonTotals[],
  now: Date,
): Promise<Health> {
  const devices = (await db.devices.listWithOwners()).filter((d) => d.revokedAt === null);
  const emails = new Set(devices.map((d) => d.ownerWorkEmail.toLowerCase()));
  const recent = devices.filter(
    (d) => d.lastSeenAt && now.getTime() - d.lastSeenAt.getTime() <= SEEN_DAYS * 86_400_000,
  );
  const counts = new Map<string, number>();
  for (const d of recent) counts.set(d.appVersion, (counts.get(d.appVersion) ?? 0) + 1);
  const versions = [...counts.entries()]
    .map(([version, computers]) => ({ version, computers }))
    .sort((a, b) => compareVersions(b.version, a.version));
  const newest = versions[0]?.version ?? null;
  const byId = new Map(totals.map((t) => [t.employee_id, t]));
  return {
    active_people: people.length,
    with_app: people.filter((p) => p.workEmail && emails.has(p.workEmail.toLowerCase())).length,
    clocked_in: people.filter((p) => (byId.get(p.id)?.days_worked ?? 0) > 0).length,
    never_clocked_in: people
      .filter((p) => {
        const t = byId.get(p.id);
        return t !== undefined && t.shift_days > 0 && t.days_worked === 0;
      })
      .map((p) => ({ employee_id: p.id, name: nameOf(p) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    versions,
    newest_version: newest,
    computers_behind: newest
      ? recent.filter((d) => compareVersions(d.appVersion, newest) < 0).length
      : 0,
    corrections_waiting: (await db.corrections.listOpen()).length,
  };
}

/** The whole overview for active people, `from` to `to`. */
export async function overview(
  db: DbRepositories,
  from: string,
  to: string,
  now: Date,
): Promise<Overview> {
  const people = await db.employees.listActive();
  const s = summarise(await rangeRows(db, people, from, to, now));
  return { from, to, ...s, health: await health(db, people, s.people, now) };
}

// CSV (ADR-0040 §3): one row per person, the columns of one section.

const h = (ms: number): string => (ms / 3_600_000).toFixed(2);
const pct = (x: number | null): string => (x === null ? '' : (x * 100).toFixed(1));
const n = (x: number | null): string => (x === null ? '' : String(x));

export const CSV_SECTIONS = {
  hours: [
    ['Days worked', (p: PersonTotals) => String(p.days_worked)],
    ['Shift days', (p: PersonTotals) => String(p.shift_days)],
    ['Shift days worked', (p: PersonTotals) => String(p.shift_days_worked)],
    ['Attendance %', (p: PersonTotals) => pct(p.attendance)],
    ['Hours worked', (p: PersonTotals) => h(p.worked_ms)],
    ['Hours scheduled', (p: PersonTotals) => h(p.scheduled_ms)],
  ],
  lateness: [
    ['Late starts', (p: PersonTotals) => String(p.late_starts)],
    ['Average minutes late', (p: PersonTotals) => n(p.avg_minutes_late)],
    ['Missed starts', (p: PersonTotals) => String(p.missed_starts)],
  ],
  activity: [
    ['Idle hours', (p: PersonTotals) => h(p.idle_ms)],
    ['Idle %', (p: PersonTotals) => pct(p.idle_share)],
    [
      'Break minutes per day',
      (p: PersonTotals) =>
        p.break_ms_per_day === null ? '' : String(Math.round(p.break_ms_per_day / 60_000)),
    ],
    ['Breaks over limit', (p: PersonTotals) => String(p.breaks_over_limit)],
    ['Away hours', (p: PersonTotals) => h(p.away_ms)],
  ],
} as const satisfies Record<string, readonly (readonly [string, (p: PersonTotals) => string])[]>;

export type CsvSection = keyof typeof CSV_SECTIONS;

/** A cell as CSV: quoted when needed; a leading =+-@ can't start a formula. */
function cell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function overviewCsv(people: readonly PersonTotals[], section: CsvSection): string {
  const cols = CSV_SECTIONS[section];
  const lines = [
    ['Person', ...cols.map(([label]) => label)],
    ...people.map((p) => [p.name, ...cols.map(([, value]) => value(p))]),
  ];
  return `${lines.map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`;
}
