import type { DayRow } from '../reports/day.js';

/**
 * ADR-0047 §1, pure: the findings a person's last 14 days support.
 * Holidays, office days and "not working" never count; a day with no
 * shift counts only for the hours-based findings.
 */

export type InsightKind =
  | 'late_starts'
  | 'missed_starts'
  | 'short_days'
  | 'long_idle'
  | 'breaks_over'
  | 'forgets_clock_out'
  | 'long_days';

export type Severity = 'info' | 'warning' | 'serious';

export const SEVERITY: Record<InsightKind, Severity> = {
  late_starts: 'warning',
  missed_starts: 'serious',
  short_days: 'warning',
  long_idle: 'warning',
  breaks_over: 'info',
  forgets_clock_out: 'info',
  long_days: 'info',
};

/** How many qualifying days (or breaks) open a finding (ADR-0047 §1). */
export const THRESHOLD: Record<InsightKind, number> = {
  late_starts: 3,
  missed_starts: 2,
  short_days: 3,
  long_idle: 3,
  breaks_over: 5,
  forgets_clock_out: 2,
  long_days: 3,
};

export const WINDOW_DAYS = 14;
const HOUR = 3_600_000;

/** One day on the 14-day strip. */
export type DayMark =
  'on_time' | 'late' | 'missed' | 'short' | 'worked' | 'off' | 'office' | 'holiday' | 'not_working';

export interface StripDay {
  date: string;
  mark: DayMark;
  /** Minutes late, hours worked and scheduled, idle, for the tooltip. */
  minutes_late: number | null;
  worked_ms: number;
  shift_ms: number;
  idle_ms: number;
}

export interface Finding {
  kind: InsightKind;
  severity: Severity;
  /** Qualifying days (or breaks, for breaks over limit). */
  count: number;
  /** The days that qualified, oldest first. */
  dates: string[];
}

const worked = (r: DayRow): boolean => r.status === 'worked' || r.status === 'late';
const finished = (r: DayRow): boolean => worked(r) && !r.still_in;

/** The strip: one mark per day, oldest first. */
export function stripOf(rows: readonly DayRow[]): StripDay[] {
  return [...rows]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({
      date: r.date,
      mark:
        r.status === 'late'
          ? 'late'
          : r.status === 'not_clocked_in'
            ? 'missed'
            : r.status === 'in_office'
              ? 'office'
              : r.status === 'holiday'
                ? 'holiday'
                : r.status === 'not_working'
                  ? 'not_working'
                  : r.status === 'off'
                    ? 'off'
                    : r.shift_ms > 0 && finished(r) && r.worked_ms < r.shift_ms * 0.8
                      ? 'short'
                      : r.shift_ms > 0
                        ? 'on_time'
                        : 'worked',
      minutes_late: r.minutes_late,
      worked_ms: r.worked_ms,
      shift_ms: r.shift_ms,
      idle_ms: r.idle_ms,
    }));
}

/** Which days qualify for each kind. */
function qualifying(
  rows: readonly DayRow[],
): Record<InsightKind, { days: string[]; count: number }> {
  const days = (f: (r: DayRow) => boolean): string[] =>
    rows
      .filter(f)
      .map((r) => r.date)
      .sort();
  const breaks = rows.filter((r) => worked(r) && r.breaks_over_limit > 0);
  return {
    late_starts: { days: days((r) => r.status === 'late'), count: 0 },
    missed_starts: { days: days((r) => r.status === 'not_clocked_in'), count: 0 },
    short_days: {
      days: days((r) => finished(r) && r.shift_ms > 0 && r.worked_ms < r.shift_ms * 0.8),
      count: 0,
    },
    long_idle: { days: days((r) => worked(r) && r.idle_ms >= HOUR), count: 0 },
    breaks_over: {
      days: breaks.map((r) => r.date).sort(),
      count: breaks.reduce((s, r) => s + r.breaks_over_limit, 0),
    },
    forgets_clock_out: { days: days((r) => worked(r) && r.still_in), count: 0 },
    long_days: {
      days: days((r) => worked(r) && r.shift_ms > 0 && r.worked_ms > r.shift_ms + HOUR),
      count: 0,
    },
  };
}

/** The findings `rows` (one person, up to 14 days) support. */
export function findingsOf(rows: readonly DayRow[]): Finding[] {
  const q = qualifying(rows);
  return (Object.keys(THRESHOLD) as InsightKind[]).flatMap((kind) => {
    const { days, count } = q[kind];
    const n = kind === 'breaks_over' ? count : days.length;
    return n >= THRESHOLD[kind] ? [{ kind, severity: SEVERITY[kind], count: n, dates: days }] : [];
  });
}

/** Whether `kind` still holds for these rows (the follow-up check). */
export const stillHolds = (rows: readonly DayRow[], kind: InsightKind): boolean =>
  findingsOf(rows).some((f) => f.kind === kind);

// Words (ADR-0047 §3): the finding in a line, and the nudge draft.

const DAY_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const dayText = (d: string): string => DAY_FMT.format(new Date(`${d}T12:00:00Z`)).replace(',', '');

export function headlineOf(f: { kind: InsightKind; count: number }): string {
  const n = f.count;
  switch (f.kind) {
    case 'late_starts':
      return `Late ${n} times in ${WINDOW_DAYS} days`;
    case 'missed_starts':
      return `No clock-in on ${n} shift days`;
    case 'short_days':
      return `${n} short days (under 80% of the shift)`;
    case 'long_idle':
      return `Idle an hour or more on ${n} days`;
    case 'breaks_over':
      return `${n} breaks over their limit`;
    case 'forgets_clock_out':
      return `Didn't clock out on ${n} days`;
    case 'long_days':
      return `${n} long days (an hour or more over the shift)`;
  }
}

/** The nudge as drafted for a person to edit (ADR-0047 §3). */
export function draftNudge(firstName: string, f: { kind: InsightKind; dates: string[] }): string {
  const days = f.dates.slice(-5).map(dayText).join(', ');
  const hi = `Hi ${firstName},`;
  const end =
    'If something is getting in the way, reply to this email or have a word with your manager.';
  switch (f.kind) {
    case 'late_starts':
      return `${hi}\n\nCloudPunch shows you started after your shift time on ${f.dates.length} days in the last two weeks (${days}). Is anything making mornings hard?\n\n${end}`;
    case 'missed_starts':
      return `${hi}\n\nCloudPunch shows no clock-in on ${f.dates.length} of your shift days in the last two weeks (${days}). If you were working, please clock in from CloudPunch, or tell us if you weren't working those days.\n\n${end}`;
    case 'short_days':
      return `${hi}\n\nYour days were well short of your shift on ${f.dates.length} days recently (${days}). If your hours have changed, let us know so your shift can be updated.\n\n${end}`;
    case 'long_idle':
      return `${hi}\n\nCloudPunch logged an hour or more of idle time on ${f.dates.length} days (${days}). If you were working away from the computer, say so in CloudPunch when it asks, or use Away.\n\n${end}`;
    case 'breaks_over':
      return `${hi}\n\nA few of your breaks have run past their limit lately (${days}). Setting "Back in" when you start a break helps keep them on time.\n\n${end}`;
    case 'forgets_clock_out':
      return `${hi}\n\nYou stayed clocked in after finishing on ${f.dates.length} days (${days}). Please clock out at the end of your day so your hours are right.\n\n${end}`;
    case 'long_days':
      return `${hi}\n\nYou've worked well past your shift on ${f.dates.length} days recently (${days}). Thank you, and please look after yourself: tell your manager if the workload needs a look.\n\n${end}`;
  }
}
