import type { CorrectionKind, DayCorrection } from './api.js';
import { shiftDate } from './dayHistory.js';

/**
 * Time corrections on the desktop (ADR-0030). Pure helpers: the zone
 * maths behind the form, and the words for kinds, statuses and errors.
 */

export const KIND_LABEL: Record<CorrectionKind, string> = {
  working: 'Working',
  away_working: 'Working away from the computer',
  bio_break: 'Bio break',
  meal_break: 'Meal break',
  rest_break: 'Tea break',
  personal_break: 'Personal break',
  other_break: 'Other break',
  not_worked: 'Not worked',
};

export const KINDS = Object.keys(KIND_LABEL) as CorrectionKind[];

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

/** `+05:30`. */
function offsetText(minutes: number): string {
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${minutes < 0 ? '-' : '+'}${hh}:${mm}`;
}

/** The wall time `hhmm` on `date` in `tz`, as ISO 8601 with its offset. */
export function zonedIso(date: string, hhmm: string, tz: string): string {
  const wall = Date.parse(`${date}T${hhmm}:00Z`);
  // Twice, so a time just after a daylight-saving change is right.
  const first = offsetAt(wall, tz);
  const offset = offsetAt(wall - first * 60_000, tz);
  return `${date}T${hhmm}:00${offsetText(offset)}`;
}

/**
 * From `start` to `end` on the working day `date`, in `tz`. An end at or
 * before the start is the next morning (a shift past midnight).
 */
export function correctionSpan(
  date: string,
  start: string,
  end: string,
  tz: string,
): { from: string; to: string } {
  const endDate = end <= start ? shiftDate(date, 1) : date;
  return { from: zonedIso(date, start, tz), to: zonedIso(endDate, end, tz) };
}

/** "17:30–01:30", as recorded in the person's zone. */
export function spanText(c: Pick<DayCorrection, 'from' | 'to'>): string {
  const next = c.to.slice(0, 10) > c.from.slice(0, 10) ? ' (next day)' : '';
  return `${c.from.slice(11, 16)}–${c.to.slice(11, 16)}${next}`;
}

/** Where a correction stands, in words. */
export function statusText(c: DayCorrection): string {
  const by = (d: string): string => c.decisions.find((x) => x.decision === d)?.by ?? 'someone';
  switch (c.status) {
    case 'requested':
      return 'Waiting for the manager';
    case 'endorsed':
      return "Waiting for an Administrator's approval";
    case 'approved':
      return `Approved by ${by('approved')}`;
    case 'rejected':
      return `Rejected by ${by('rejected')}`;
    case 'withdrawn':
      return 'Withdrawn';
  }
}

/** The zones the form offers; this computer's first if it is another. */
export function zoneChoices(local: string): { tz: string; label: string }[] {
  const known = [
    { tz: 'Asia/Kolkata', label: 'India (IST)' },
    { tz: 'America/New_York', label: 'US Eastern' },
  ];
  return known.some((z) => z.tz === local)
    ? known
    : [{ tz: local, label: `This computer (${local})` }, ...known];
}

const ERROR_TEXT: Record<string, string> = {
  in_future: "That time hasn't happened yet.",
  too_long: 'A correction can cover at most 16 hours. Split it in two.',
  too_old: 'Only the last 30 days can be corrected.',
  overlaps_pending: 'Part of this time already has a correction waiting.',
  validation: 'Check the times and the reason.',
  not_found: 'Only their manager can correct their time.',
  not_allowed: "You can't do that with this correction any more.",
  already_decided: 'Someone has already decided this one.',
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again first.',
};

export function correctionErrorText(code: string): string {
  return ERROR_TEXT[code] ?? `Something went wrong (${code}).`;
}
