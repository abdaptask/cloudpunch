import type { DayReport, DayReportRow, DayReportStatus } from '../api.js';

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
