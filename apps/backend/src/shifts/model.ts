import type { ShiftAssignment } from '../db/index.js';

/**
 * Shifts (ADR-0031 §1, §2). Pure: which shift applies on a date, and
 * the shift window someone is in now, in the shift's own zone (so a
 * 12:00 IST shift starts at 12:00 IST and an 08:00 Eastern one follows
 * US daylight saving).
 */

const DAY_MS = 86_400_000;

/** Minutes east of UTC in `tz` at `utcMs`. */
export function offsetAt(utcMs: number, tz: string): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(new Date(utcMs))
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -minutes : minutes;
}

/** The instant the wall clock in `tz` reads `hhmm` on `date`. */
export function wallToUtc(date: string, hhmm: string, tz: string): Date {
  const wall = Date.parse(`${date}T${hhmm}:00Z`);
  const first = offsetAt(wall, tz);
  return new Date(wall - offsetAt(wall - first * 60_000, tz) * 60_000);
}

/** `YYYY-MM-DD` of `utcMs` on the wall clock in `tz`. */
export function dateIn(utcMs: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(utcMs));
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** ISO weekday of a date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The shift that applies on `date` (rows newest first), or null for none. */
export function shiftOn(rows: readonly ShiftAssignment[], date: string): ShiftAssignment | null {
  const row = rows.find((r) => r.effectiveFrom <= date);
  return row && row.days.length > 0 && row.start && row.end ? row : null;
}

export interface ShiftWindow {
  /** The date the shift starts on, in its zone. */
  date: string;
  start: Date;
  end: Date;
  shift: ShiftAssignment;
}

/** The window of the shift that started on `date`, if it is a shift day. */
export function windowOn(rows: readonly ShiftAssignment[], date: string): ShiftWindow | null {
  const s = shiftOn(rows, date);
  if (!s?.start || !s.end || !s.days.includes(isoWeekday(date))) return null;
  const endDate = s.end <= s.start ? shiftDate(date, 1) : date;
  return {
    date,
    start: wallToUtc(date, s.start, s.tzIana),
    end: wallToUtc(endDate, s.end, s.tzIana),
    shift: s,
  };
}

/** The shift window `now` falls in (yesterday's overnight one included), or null. */
export function activeWindow(rows: readonly ShiftAssignment[], now: Date): ShiftWindow | null {
  const tz = rows[0]?.tzIana;
  if (!tz) return null;
  const today = dateIn(now.getTime(), tz);
  for (const date of [shiftDate(today, -1), today]) {
    const w = windowOn(rows, date);
    if (w && w.start <= now && now < w.end) return w;
  }
  return null;
}
