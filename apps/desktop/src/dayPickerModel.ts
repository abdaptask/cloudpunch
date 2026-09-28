import { dayLabel, LOOKBACK_DAYS, shiftDate } from './dayHistory.js';

/**
 * The day picker (ADR-0016): a heat calendar of the look-back, shaded
 * by hours worked. Pure helpers over `GET /v1/me/days?from&to`.
 */

/** One entry of the backend's `days` array (`DaySummary`). */
export interface DaySummary {
  date: string;
  sessions: number;
  worked_ms: number;
  calls_ms: number;
  meetings_ms: number;
  breaks_ms: number;
  prompt_ms: number;
}

/** Mirrors `commands::DaysResult`. */
export interface DaysResult {
  days: { days: DaySummary[] };
  /** Offline: the copy fetched earlier this run. */
  stale: boolean;
}

/** The picker's range: the oldest day in the look-back through today. */
export function pickerRange(today: string): { from: string; to: string } {
  return { from: shiftDate(today, -LOOKBACK_DAYS), to: today };
}

/** 0 = nothing tracked, then up to 4 for a long day. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

const HOUR = 3_600_000;

/** Shade for a day's worked time: under 2h, 2–5h, 5–8h, 8h or more. */
export function heatLevel(workedMs: number): HeatLevel {
  if (workedMs <= 0) return 0;
  if (workedMs < 2 * HOUR) return 1;
  if (workedMs < 5 * HOUR) return 2;
  if (workedMs < 8 * HOUR) return 3;
  return 4;
}

export interface PickerCell {
  date: string;
  /** Day of the month, for the cell's face. */
  dayOfMonth: number;
  /** Outside the look-back or after today: drawn as a gap. */
  outside: boolean;
  summary: DaySummary | null;
}

/** Monday of the week containing `date`. */
function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return shiftDate(date, -((dow + 6) % 7));
}

/** Week rows, Monday first, covering the look-back through today. */
export function pickerWeeks(today: string, summaries: readonly DaySummary[]): PickerCell[][] {
  const { from, to } = pickerRange(today);
  const byDate = new Map(summaries.map((s) => [s.date, s]));
  const weeks: PickerCell[][] = [];
  for (let monday = mondayOf(from); monday <= to; monday = shiftDate(monday, 7)) {
    const week: PickerCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const date = shiftDate(monday, i);
      week.push({
        date,
        dayOfMonth: Number(date.slice(8, 10)),
        outside: date < from || date > to,
        summary: byDate.get(date) ?? null,
      });
    }
    weeks.push(week);
  }
  return weeks;
}

/** "8h 12m", "45m", "0m". */
export function hoursMinutes(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** "Tue 23 Sep · 8h 12m", or "… · Nothing tracked". */
export function cellReadout(cell: PickerCell, today: string): string {
  const worked = cell.summary?.worked_ms ?? 0;
  const label = dayLabel(cell.date, today);
  return `${label} · ${worked > 0 ? hoursMinutes(worked) : 'Nothing tracked'}`;
}

/** The look-back at a glance: days worked, total, and average per day worked. */
export function lookbackSummary(summaries: readonly DaySummary[]): string {
  const worked = summaries.filter((s) => s.worked_ms > 0);
  if (worked.length === 0) return 'Nothing tracked in the last 30 days';
  const total = worked.reduce((sum, s) => sum + s.worked_ms, 0);
  const days = worked.length === 1 ? '1 day' : `${worked.length} days`;
  return `${days} · ${hoursMinutes(total)} · avg ${hoursMinutes(total / worked.length)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Aug – Sep 2026", or "Sep 2026" when the range is in one month. */
export function rangeTitle(today: string): string {
  const { from, to } = pickerRange(today);
  const month = (d: string): string => MONTHS[Number(d.slice(5, 7)) - 1] ?? '';
  const year = to.slice(0, 4);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${month(to)} ${year}`;
  const fromYear = from.slice(0, 4);
  return fromYear === year
    ? `${month(from)} – ${month(to)} ${year}`
    : `${month(from)} ${fromYear} – ${month(to)} ${year}`;
}

export interface CellTooltip {
  /** "Today", "Yesterday", "Tue 22 Sep". */
  title: string;
  /** "8h 12m worked", or "Nothing tracked". */
  worked: string;
  /** "2 sessions · 45m breaks · 1h 10m calls", or null. */
  detail: string | null;
}

/** The hover card for a day; `loaded` is false while offline or loading. */
export function cellTooltip(cell: PickerCell, today: string, loaded: boolean): CellTooltip {
  const title = dayLabel(cell.date, today);
  if (!loaded) return { title, worked: 'Hours unavailable offline', detail: null };
  const s = cell.summary;
  if (!s || s.worked_ms <= 0) return { title, worked: 'Nothing tracked', detail: null };
  const parts = [s.sessions === 1 ? '1 session' : `${s.sessions} sessions`];
  if (s.breaks_ms > 0) parts.push(`${hoursMinutes(s.breaks_ms)} breaks`);
  if (s.calls_ms > 0) parts.push(`${hoursMinutes(s.calls_ms)} calls`);
  if (s.meetings_ms > 0) parts.push(`${hoursMinutes(s.meetings_ms)} meetings`);
  return { title, worked: `${hoursMinutes(s.worked_ms)} worked`, detail: parts.join(' · ') };
}
