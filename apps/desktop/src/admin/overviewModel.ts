import type { Overview, OverviewPerson } from '../api.js';
import { shiftDate } from '../dayHistory.js';

/**
 * Reports → Overview (ADR-0040 §3), pure: the ranges offered, numbers
 * in words, and the CSV of a section (the same columns as the server's
 * `overview.csv`).
 */

export type Preset = 'this_week' | 'last_week' | 'this_month' | 'last_month';

export const PRESETS: readonly [Preset, string][] = [
  ['this_week', 'This week'],
  ['last_week', 'Last week'],
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
];

/** ISO weekday of a date: 1 = Monday … 7 = Sunday. */
function weekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The dates a preset covers, with `today` as `YYYY-MM-DD`. */
export function rangeOf(preset: Preset, today: string): { from: string; to: string } {
  const monday = shiftDate(today, 1 - weekday(today));
  const first = `${today.slice(0, 8)}01`;
  switch (preset) {
    case 'this_week':
      return { from: monday, to: today };
    case 'last_week':
      return { from: shiftDate(monday, -7), to: shiftDate(monday, -1) };
    case 'this_month':
      return { from: first, to: today };
    case 'last_month': {
      const end = shiftDate(first, -1);
      return { from: `${end.slice(0, 8)}01`, to: end };
    }
  }
}

/** The longest range the server gives (§3: up to 3 months). */
export const MAX_DAYS = 93;

export function rangeIssue(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
    return 'Pick both dates';
  if (from > to) return 'The start is after the end';
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return days > MAX_DAYS ? `At most ${MAX_DAYS} days` : null;
}

export const pct = (x: number | null): string => (x === null ? '—' : `${Math.round(x * 100)}%`);

/** Whole hours past 10, one decimal below. */
export function hrs(ms: number): string {
  const h = ms / 3_600_000;
  if (h <= 0) return '—';
  return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
}

export const mins = (ms: number | null): string =>
  ms === null ? '—' : `${Math.round(ms / 60_000)}m`;

/** "5 Oct": a week's Monday, for the chart. */
export function weekLabel(monday: string): string {
  return new Date(`${monday}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

// CSV, matching the server's columns (reports/overview.ts).

const h2 = (ms: number): string => (ms / 3_600_000).toFixed(2);
const p1 = (x: number | null): string => (x === null ? '' : (x * 100).toFixed(1));
const n = (x: number | null): string => (x === null ? '' : String(x));

export type CsvSection = 'hours' | 'lateness' | 'activity';

const COLUMNS: Record<CsvSection, readonly (readonly [string, (p: OverviewPerson) => string])[]> = {
  hours: [
    ['Days worked', (p) => String(p.days_worked)],
    ['Shift days', (p) => String(p.shift_days)],
    ['Shift days worked', (p) => String(p.shift_days_worked)],
    ['Attendance %', (p) => p1(p.attendance)],
    ['Hours worked', (p) => h2(p.worked_ms)],
    ['Hours scheduled', (p) => h2(p.scheduled_ms)],
  ],
  lateness: [
    ['Late starts', (p) => String(p.late_starts)],
    ['Average minutes late', (p) => n(p.avg_minutes_late)],
    ['Missed starts', (p) => String(p.missed_starts)],
  ],
  activity: [
    ['Idle hours', (p) => h2(p.idle_ms)],
    ['Idle %', (p) => p1(p.idle_share)],
    [
      'Break minutes per day',
      (p) => (p.break_ms_per_day === null ? '' : String(Math.round(p.break_ms_per_day / 60_000))),
    ],
    ['Breaks over limit', (p) => String(p.breaks_over_limit)],
    ['Away hours', (p) => h2(p.away_ms)],
  ],
};

/** A cell as CSV: quoted when needed; a leading =+-@ can't start a formula. */
function cell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvOf(o: Overview, section: CsvSection): string {
  const cols = COLUMNS[section];
  const lines = [
    ['Person', ...cols.map(([label]) => label)],
    ...o.people.map((p) => [p.name, ...cols.map(([, value]) => value(p))]),
  ];
  return `${lines.map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`;
}

export const csvName = (o: Overview, section: CsvSection): string =>
  `cloudpunch-${section}-${o.from}-to-${o.to}.csv`;
