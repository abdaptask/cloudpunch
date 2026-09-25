import type { Status } from './api.js';
import type { Segment, SegmentKind } from './timelineModel.js';

/**
 * Past days on the home screen (ADR-0016). Pure helpers over the
 * backend's `GET /v1/me/days/{date}` body.
 *
 * Times are shown on the clock of the computer where the work happened:
 * each instant is shifted so that this computer's local clock reads the
 * recorded wall time. The dial, timeline and totals then work unchanged.
 */

/** Today and the previous 30 days. */
export const LOOKBACK_DAYS = 30;

export interface DayApiSession {
  session_id: string;
  device_id: string;
  tz_iana: string;
  /** ISO 8601 with the recorded offset: `2026-09-25T18:30:00.000+05:30`. */
  clock_in: string;
  clock_out: string | null;
  close_reason: string | null;
  reconstructed: boolean;
  open: boolean;
  segments: { kind: SegmentKind; started_at: string; ended_at: string }[];
}

export interface DayApi {
  date: string;
  sessions: DayApiSession[];
}

/** Mirrors `commands::DayResult`. */
export interface DayResult {
  day: DayApi;
  /** This computer's device id, when known. */
  thisDevice: string | null;
  /** Offline: the copy fetched earlier this run. */
  stale: boolean;
}

/** Offset in minutes east of UTC from an ISO string's suffix. */
export function offsetOf(iso: string): number {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -mins : mins;
}

/**
 * An epoch value whose local-time reading on this computer is the wall
 * time recorded in `iso`.
 */
export function asRecordedWallTime(iso: string): number {
  const utc = Date.parse(iso);
  return utc + (offsetOf(iso) + new Date(utc).getTimezoneOffset()) * 60_000;
}

/** The day's segments, on recorded wall time, numbered by session. */
export function daySegments(day: DayApi): Segment[] {
  return day.sessions.flatMap((s, i) =>
    s.segments.map((g) => ({
      kind: g.kind,
      startedAt: asRecordedWallTime(g.started_at),
      endedAt: asRecordedWallTime(g.ended_at),
      session: i + 1,
    })),
  );
}

/** When the day's last segment ends (recorded wall time), or null. */
export function dayEnd(segments: readonly Segment[]): number | null {
  const ends = segments.map((s) => s.endedAt ?? s.startedAt);
  return ends.length > 0 ? Math.max(...ends) : null;
}

/** "UTC+05:30". */
function utcLabel(offset: number): string {
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${offset < 0 ? '-' : '+'}${hh}:${mm}`;
}

/**
 * A note when the day was recorded in a different time zone from this
 * computer's (`localOffset`, minutes east of UTC), else null.
 */
export function zoneNote(day: DayApi, localOffset: number): string | null {
  const zones = new Map<string, number>();
  for (const s of day.sessions) zones.set(s.tz_iana, offsetOf(s.clock_in));
  if (zones.size === 0 || [...zones.values()].every((o) => o === localOffset)) return null;
  if (zones.size > 1) return 'Times as recorded on each computer';
  const [[tz, offset]] = [...zones.entries()] as [[string, number]];
  return `Times in ${tz} (${utcLabel(offset)}), where this was recorded`;
}

/** Whether any session was recorded on a different computer. */
export function recordedElsewhere(day: DayApi, thisDevice: string | null): boolean {
  return thisDevice !== null && day.sessions.some((s) => s.device_id !== thisDevice);
}

/** Local `YYYY-MM-DD` of `ms` on this computer. */
export function localDateOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `date` moved by `days` (calendar arithmetic, no zones). */
export function shiftDate(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Today", "Yesterday", or "Tue 23 Sep". */
export function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === shiftDate(today, -1)) return 'Yesterday';
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Dial face tint for the current status (owner request). */
export type Tint = 'working' | 'break' | 'off';

export function tintFor(status: Status): Tint {
  switch (status) {
    case 'active':
    case 'on_call':
    case 'away':
      return 'working';
    case 'on_break':
    case 'idle_pending':
      return 'break';
    case 'clocked_out':
      return 'off';
  }
}
