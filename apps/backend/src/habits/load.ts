import type { DbRepositories, Employee } from '../db/index.js';
import type { WorkingDay } from '../days/build.js';
import { rangeRows, type DayRow } from '../reports/day.js';
import {
  companyHabits,
  needsALookFirst,
  personHabits,
  type HabitDay,
  type HabitsReport,
} from './model.js';

/**
 * ADR-0051: the inspector's window and its data. The 30 days run from
 * the owner's go-ahead; the final report goes the morning after.
 */
export const HABITS_FROM = '2026-10-15';
export const HABITS_TO = '2026-11-13';
/** The final 30-day report goes out this morning (India time). */
export const HABITS_FINAL_ON = '2026-11-14';

const DAY_MS = 86_400_000;

/** Minutes after local midnight of `date` in `tz` (past 1440 after midnight). */
export function minutesOn(tz: string, date: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'));
  const days = Math.round((local - Date.parse(`${date}T00:00:00Z`)) / DAY_MS);
  return days * 1440 + get('hour') * 60 + get('minute');
}

const weekdayOf = (date: string): number => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;

/** Pure: a report row and its working day as the inspector's day. */
export function habitDay(row: DayRow, day: WorkingDay | undefined): HabitDay {
  const last = day?.sessions.at(-1);
  const autoOut: HabitDay['autoOut'] = last?.lockedOut
    ? 'locked_after_shift'
    : last &&
        !last.open &&
        ['idle_cap', 'idle_auto_clock_out'].includes(last.session.closedReason ?? '')
      ? 'idle_cap'
      : null;
  const at = (iso: string | null): number | null =>
    iso ? minutesOn(row.tz, row.date, new Date(iso)) : null;
  return {
    date: row.date,
    weekday: weekdayOf(row.date),
    status: row.status,
    inMin: at(row.clock_in),
    outMin: row.still_in || autoOut ? null : at(row.clock_out),
    shiftStartMin: row.shift ? at(row.shift.start) : null,
    shiftEndMin: row.shift ? at(row.shift.end) : null,
    minutesLate: row.minutes_late,
    stillIn: row.still_in,
    workedMs: row.worked_ms,
    shiftMs: row.shift_ms,
    sessions: day?.sessions.length ?? 0,
    fromSignIn: day?.sessions[0]?.startedFromSignIn ?? false,
    autoOut,
  };
}

/** The zone someone's times read in: their most common one. */
function zoneOf(rows: readonly DayRow[]): string {
  const n = new Map<string, number>();
  for (const r of rows) if (r.clock_in) n.set(r.tz, (n.get(r.tz) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? rows[0]?.tz ?? 'Asia/Kolkata';
}

/** Everyone's habits from `from` to `to`, inclusive. */
export async function habitsReport(
  db: DbRepositories,
  people: readonly Employee[],
  from: string,
  to: string,
  now: Date,
): Promise<HabitsReport> {
  const workingDays = new Map<string, readonly WorkingDay[]>();
  const rows = await rangeRows(db, people, from, to, now, (e, days) => workingDays.set(e.id, days));
  const daysOf = new Map<string, HabitDay[]>();
  const out = [];
  for (const p of people) {
    const mine = rows.filter((r) => r.employee_id === p.id);
    const days = workingDays.get(p.id) ?? [];
    const habit = mine.map((r) =>
      habitDay(
        r,
        r.clock_in
          ? days.find((d) => d.sessions[0]?.clockIn.toISOString() === r.clock_in)
          : undefined,
      ),
    );
    daysOf.set(p.id, habit);
    out.push(
      personHabits(
        { employee_id: p.id, name: mine[0]?.name ?? p.displayName ?? '', tz: zoneOf(mine) },
        habit,
      ),
    );
  }
  const people_ = needsALookFirst(out);
  return { from, to, people: people_, company: companyHabits(people_, daysOf, from) };
}
