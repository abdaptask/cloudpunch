import { groupOf, today, totals, type Segment } from './timelineModel.js';

/**
 * End-of-day summary (ADR-0013 §8): what the day looked like when the
 * employee clocked out or signed out. A day of at least the policy's
 * `reminders.long_day_hours` gets the "Trip complete" animation;
 * shorter days get a quiet card.
 */
export interface TripSummary {
  worked: number;
  calls: number;
  breaks: number;
  /** Break and logged idle time (ms): the owner wants both shown. */
  breakMs: number;
  idleMs: number;
  /** At least the policy's long day. */
  long: boolean;
}

export function tripSummary(
  segments: readonly Segment[],
  now: number,
  since: number,
  longDayMs: number,
): TripSummary {
  const rows = today(segments, now, since);
  const sum = totals(segments, now, since);
  const worked = sum.working;
  return {
    worked,
    calls: rows.filter((r) => r.kind.startsWith('call_')).length,
    breaks: rows.filter((r) => groupOf(r.kind) === 'break').length,
    breakMs: sum.break,
    idleMs: sum.idle,
    long: worked >= longDayMs,
  };
}

/** "8h 12m", "45m". */
export function hoursMinutes(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
}

const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "8h 12m worked · 45m breaks · 20m idle · 3 calls"; zeros are left out. */
export function tripLine(s: TripSummary): string {
  const parts = [`${hoursMinutes(s.worked)} worked`];
  if (s.breakMs > 0)
    parts.push(`${hoursMinutes(s.breakMs)} ${s.breaks === 1 ? 'break' : 'breaks'}`);
  if (s.idleMs > 0) parts.push(`${hoursMinutes(s.idleMs)} idle`);
  if (s.calls > 0) parts.push(count(s.calls, 'call'));
  return parts.join(' · ');
}

/** The odometer's "HH:MM" for `ms` worked. */
export function odometer(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.min(99, Math.floor(mins / 60)))}:${pad(mins % 60)}`;
}
