import type { DayReport, DayReportRow, DayReportStatus } from '../api.js';
import { LOOKBACK_DAYS, shiftDate } from '../dayHistory.js';

/**
 * Reports → Day summary (ADR-0040 §2), pure: words for each status, the
 * header line, and times on the clock of each person's shift.
 */

export const STATUS_LABEL: Record<DayReportStatus, string> = {
  not_clocked_in: 'Not clocked in',
  late: 'Late',
  worked: 'Worked',
  not_working: 'Not working today',
  in_office: 'In office',
  holiday: 'Holiday',
  off: 'Off',
};

/** Problems first, as the server sorts them. */
export const STATUS_ORDER: readonly DayReportStatus[] = [
  'not_clocked_in',
  'late',
  'not_working',
  'worked',
  'in_office',
  'holiday',
  'off',
];

/** "12 worked · 2 late · 1 not clocked in": the statuses there are, problems first. */
export function headline(counts: DayReport['counts']): string {
  const parts = STATUS_ORDER.filter((s) => s !== 'off' && (counts[s] ?? 0) > 0).map(
    (s) => `${counts[s]} ${STATUS_LABEL[s].toLowerCase()}`,
  );
  return parts.length > 0 ? parts.join(' · ') : 'Nobody had a shift';
}

/** "8h 05m", "45m", "—" for nothing. */
export function hours(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m <= 0) return '—';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "09:40" on the wall clock in `tz`. */
export function clockIn(tz: string, iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

/** The shift as "09:00–18:00". */
export function shiftText(r: DayReportRow): string {
  return r.shift ? `${clockIn(r.tz, r.shift.start)}–${clockIn(r.tz, r.shift.end)}` : 'No shift';
}

/** The start column: the clock-in and how late, if late. */
export function startText(r: DayReportRow): string {
  if (!r.clock_in) return '—';
  const at = clockIn(r.tz, r.clock_in);
  return r.minutes_late && r.minutes_late > 0 ? `${at} (+${r.minutes_late}m)` : at;
}

export function endText(r: DayReportRow): string {
  if (r.still_in) return 'Still in';
  return clockIn(r.tz, r.clock_out);
}

/** Hours worked, against the shift when there is one. */
export function workedText(r: DayReportRow): string {
  if (r.worked_ms <= 0) return '—';
  return r.shift_ms > 0 ? `${hours(r.worked_ms)} / ${hours(r.shift_ms)}` : hours(r.worked_ms);
}

// The interactive report (owner, 2026-10-14): filters, and a timeline
// of everyone's day on one clock.

export type ReportFilter =
  | 'all'
  | 'attention'
  | 'not_clocked_in'
  | 'late'
  | 'still_in'
  | 'long_idle'
  | 'breaks_over'
  | 'short'
  | 'long';

export const FILTER_LABEL: Record<ReportFilter, string> = {
  all: 'Everyone',
  attention: 'Needs attention',
  not_clocked_in: 'Not clocked in',
  late: 'Late',
  still_in: 'Still clocked in',
  long_idle: 'Idle 1h+',
  breaks_over: 'Breaks over limit',
  short: 'Short days',
  long: 'Long days',
};

const HOUR = 3_600_000;
const worked = (r: DayReportRow): boolean => r.status === 'worked' || r.status === 'late';

/** The same lines the email draws (backend reports/mailHtml.ts). */
export function matches(r: DayReportRow, f: ReportFilter): boolean {
  switch (f) {
    case 'all':
      return r.status !== 'off';
    case 'not_clocked_in':
    case 'late':
      return r.status === f;
    case 'still_in':
      return worked(r) && r.still_in;
    case 'long_idle':
      return worked(r) && r.idle_ms >= HOUR;
    case 'breaks_over':
      return worked(r) && r.breaks_over_limit > 0;
    case 'short':
      return worked(r) && !r.still_in && r.shift_ms > 0 && r.worked_ms < r.shift_ms * 0.8;
    case 'long':
      return worked(r) && r.shift_ms > 0 && r.worked_ms > r.shift_ms + HOUR;
    case 'attention':
      return (
        ['not_clocked_in', 'late', 'still_in', 'long_idle', 'breaks_over', 'short', 'long'] as const
      ).some((x) => matches(r, x));
  }
}

export type SortKey = 'problems' | 'start' | 'hours' | 'name';

export function sortRows(rows: readonly DayReportRow[], key: SortKey): DayReportRow[] {
  const start = (r: DayReportRow): number =>
    Date.parse(r.clock_in ?? r.shift?.start ?? '') || Infinity;
  const out = [...rows];
  switch (key) {
    case 'problems':
      return out.sort(
        (a, b) =>
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
          (b.minutes_late ?? 0) - (a.minutes_late ?? 0) ||
          a.name.localeCompare(b.name),
      );
    case 'start':
      return out.sort((a, b) => start(a) - start(b) || a.name.localeCompare(b.name));
    case 'hours':
      return out.sort((a, b) => b.worked_ms - a.worked_ms || a.name.localeCompare(b.name));
    case 'name':
      return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Minutes east of UTC in `tz` at `ms`. */
export function offsetIn(tz: string, ms: number): number {
  try {
    const name =
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(new Date(ms))
        .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    if (!m) return 0;
    const v = Number(m[2]) * 60 + Number(m[3] ?? 0);
    return m[1] === '-' ? -v : v;
  } catch {
    return 0;
  }
}

export interface Axis {
  from: number;
  to: number;
  /** Whole hours on the chosen clock. */
  ticks: number[];
}

/**
 * The span every row shares: from the earliest shift start, clock-in or
 * span to the latest end ("still in" runs to `now`), out to whole hours
 * on `tz`'s clock. Ticks every hour, or every 2–3 hours on a long day.
 */
export function axisOf(rows: readonly DayReportRow[], tz: string, now: number): Axis | null {
  const times: number[] = [];
  for (const r of rows) {
    for (const t of [r.shift?.start, r.shift?.end, r.clock_in, r.clock_out]) {
      if (t) times.push(Date.parse(t));
    }
    for (const s of r.segments ?? []) times.push(Date.parse(s.from), Date.parse(s.to));
    if (r.still_in) times.push(now);
  }
  const ok = times.filter((t) => Number.isFinite(t));
  if (ok.length === 0) return null;
  const lo = Math.min(...ok);
  const hi = Math.max(...ok);
  const off = offsetIn(tz, lo) * 60_000;
  const from = Math.floor((lo + off) / HOUR) * HOUR - off;
  const to = Math.max(from + HOUR, Math.ceil((hi + off) / HOUR) * HOUR - off);
  const span = (to - from) / HOUR;
  const step = span > 18 ? 3 : span > 10 ? 2 : 1;
  const ticks: number[] = [];
  for (let t = from; t <= to; t += step * HOUR) ticks.push(t);
  return { from, to, ticks };
}

/** Percent along the axis, clamped to the track. */
export const along = (a: Axis, ms: number): number =>
  Math.min(100, Math.max(0, ((ms - a.from) / (a.to - a.from)) * 100));

/** "09:00" on `tz`'s clock. */
export function timeIn(tz: string, ms: number): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

export const ZONES: readonly [string, string][] = [
  ['Asia/Kolkata', 'India time'],
  ['America/New_York', 'US Eastern'],
  [Intl.DateTimeFormat().resolvedOptions().timeZone, 'This computer'],
];

/** `?date=` from the address (the email's link), if it's a usable day. */
export function linkedDate(today: string): string | null {
  try {
    const d = new URLSearchParams(window.location.search).get('date');
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today && d >= shiftDate(today, -LOOKBACK_DAYS)
      ? d
      : null;
  } catch {
    return null;
  }
}
