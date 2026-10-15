/**
 * ADR-0051: the habits inspector, pure. From each person's days in the
 * window it works out when they usually start and finish, how steady
 * that is, and the habits worth a look (late starts, leaving clocked
 * in, locking up without clocking out, split days...). Times only, from
 * records CloudPunch already keeps (invariant 1). Rule-based: no AI.
 */

/** One person's day, as the inspector needs it. */
export interface HabitDay {
  date: string;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** Worked (on time or late), else why not. */
  status: 'worked' | 'late' | 'not_clocked_in' | 'not_working' | 'holiday' | 'in_office' | 'off';
  /** Minutes after local midnight of `date` (can pass 1440 after midnight). */
  inMin: number | null;
  /** The last clock-out the person made themselves; null if still in or clocked out by CloudPunch. */
  outMin: number | null;
  shiftStartMin: number | null;
  shiftEndMin: number | null;
  minutesLate: number | null;
  /** Still clocked in at the end of the day (never clocked out). */
  stillIn: boolean;
  workedMs: number;
  shiftMs: number;
  /** Clock-in → clock-out sessions that day. */
  sessions: number;
  /** Started from the computer's sign-in time (ADR-0018 §4). */
  fromSignIn: boolean;
  /** Clocked out by CloudPunch: idle cap, or locked after the shift (ADR-0050). */
  autoOut: 'idle_cap' | 'locked_after_shift' | null;
}

export type HabitFlag =
  | 'few_days'
  | 'steady'
  | 'irregular_start'
  | 'irregular_end'
  | 'often_late'
  | 'late_on_weekday'
  | 'leaves_clocked_in'
  | 'locks_without_clocking_out'
  | 'leaves_early'
  | 'split_days'
  | 'long_days'
  | 'missed_starts'
  | 'starts_from_sign_in';

/** A typical time: the middle one, and the range the middle half falls in. */
export interface TypicalTime {
  median: number;
  low: number;
  high: number;
  /** high − low, in minutes. */
  spread: number;
  n: number;
}

export interface PersonHabits {
  employee_id: string;
  name: string;
  /** The zone their times are in (their most common one). */
  tz: string;
  days_worked: number;
  shift_days: number;
  start: TypicalTime | null;
  end: TypicalTime | null;
  /** Median start per weekday (0 = Monday), where there are two or more. */
  start_by_weekday: (number | null)[];
  late_days: number;
  /** Median minutes late, on the late days. */
  late_median: number | null;
  /** Of the shift days they worked, the share on time. */
  on_time_rate: number | null;
  early_leaves: number;
  left_clocked_in: number;
  idle_cap_outs: number;
  locked_outs: number;
  split_days: number;
  long_days: number;
  missed_starts: number;
  from_sign_in: number;
  /** The headline, plain English: "Steady 09:00–18:00". */
  label: string;
  /** Everything worth knowing, most important first. */
  notes: string[];
  flags: HabitFlag[];
}

export interface WeekHabits {
  /** The Monday it starts. */
  week_start: string;
  days_worked: number;
  on_time_rate: number | null;
  median_start: number | null;
  median_end: number | null;
  late_days: number;
  left_clocked_in: number;
  auto_outs: number;
}

export interface HabitChange {
  employee_id: string;
  name: string;
  /** Minutes later (+) or earlier (−) than their first week. */
  start_shift: number | null;
  end_shift: number | null;
  first_start: number | null;
  last_start: number | null;
  first_end: number | null;
  last_end: number | null;
}

export interface CompanyHabits {
  people: number;
  days_worked: number;
  on_time_rate: number | null;
  median_start: number | null;
  median_end: number | null;
  /** Clock-ins by local hour (index 0–23). */
  start_hours: number[];
  /** Clock-outs by local hour (index 0–23; after midnight folds into the hour). */
  end_hours: number[];
  /** How many people carry each flag. */
  flags: Partial<Record<HabitFlag, number>>;
  weeks: WeekHabits[];
  changed: HabitChange[];
}

export interface HabitsReport {
  from: string;
  to: string;
  people: PersonHabits[];
  company: CompanyHabits;
}

const DAY = 1440;
/** Thresholds (ADR-0051 §2). */
export const MIN_DAYS = 3;
const STEADY_SPREAD = 30;
const IRREGULAR_SPREAD = 90;
const WEEKDAY_LATER = 30;
const EARLY_MIN = 15;
const LONG_EXTRA_MIN = 60;
const NO_SHIFT_LONG_MS = 10 * 3_600_000;
const CHANGED_MIN = 30;
const WEEKDAYS = [
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
  'Sundays',
];

const worked = (d: HabitDay): boolean => d.status === 'worked' || d.status === 'late';

/** Quantile by linear interpolation of a sorted list. */
function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return Math.round(a + (b - a) * (pos - lo));
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return quantile(
    [...xs].sort((a, b) => a - b),
    0.5,
  );
}

export function typical(xs: readonly number[]): TypicalTime | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const low = quantile(s, 0.25);
  const high = quantile(s, 0.75);
  return { median: quantile(s, 0.5), low, high, spread: high - low, n: s.length };
}

/** "09:05", "00:30 (+1)" for after midnight. */
export function hhmm(min: number): string {
  const m = ((Math.round(min) % DAY) + DAY) % DAY;
  const h = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${h}:${mm}${min >= DAY ? ' (+1)' : ''}`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Pure: one person's habits over their days in the window. */
export function personHabits(
  person: { employee_id: string; name: string; tz: string },
  days: readonly HabitDay[],
): PersonHabits {
  const w = days.filter(worked);
  const starts = w.flatMap((d) => (d.inMin === null ? [] : [d.inMin]));
  const ends = w.flatMap((d) => (d.outMin === null ? [] : [d.outMin]));
  const start = typical(starts);
  const end = typical(ends);
  const byWeekday: (number | null)[] = Array.from({ length: 7 }, (_, wd) => {
    const xs = w.filter((d) => d.weekday === wd && d.inMin !== null).map((d) => d.inMin as number);
    return xs.length >= 2 ? median(xs) : null;
  });
  const shiftWorked = w.filter((d) => d.shiftStartMin !== null);
  const late = w.filter((d) => d.status === 'late');
  const shiftDays = days.filter(
    (d) => d.shiftStartMin !== null && (worked(d) || d.status === 'not_clocked_in'),
  ).length;
  const early = w.filter(
    (d) => d.outMin !== null && d.shiftEndMin !== null && d.outMin < d.shiftEndMin - EARLY_MIN,
  ).length;
  const leftIn = w.filter((d) => d.stillIn).length;
  const idleCap = w.filter((d) => d.autoOut === 'idle_cap').length;
  const locked = w.filter((d) => d.autoOut === 'locked_after_shift').length;
  const split = w.filter((d) => d.sessions > 1).length;
  const long = w.filter((d) =>
    d.shiftMs > 0
      ? d.workedMs > d.shiftMs + LONG_EXTRA_MIN * 60_000
      : d.workedMs > NO_SHIFT_LONG_MS,
  ).length;
  const missed = days.filter((d) => d.status === 'not_clocked_in').length;
  const signIn = w.filter((d) => d.fromSignIn).length;

  const flags: HabitFlag[] = [];
  const notes: string[] = [];
  const n = w.length;
  if (n < MIN_DAYS) flags.push('few_days');
  else {
    if (missed >= 2) {
      flags.push('missed_starts');
      notes.push(`No clock-in on ${plural(missed, 'shift day')}`);
    }
    if (late.length >= 3 && shiftWorked.length > 0 && late.length / shiftWorked.length >= 0.3) {
      flags.push('often_late');
      notes.push(
        `Often late: ${late.length} of ${shiftWorked.length} shift days, usually ${median(late.map((d) => d.minutesLate ?? 0))} min`,
      );
    }
    // A later weekday only means something when starts are otherwise steady.
    const overall = start && start.spread <= IRREGULAR_SPREAD ? start.median : null;
    if (overall !== null) {
      const later = byWeekday
        .map((m, wd) => ({ wd, m }))
        .filter(
          (x): x is { wd: number; m: number } => x.m !== null && x.m - overall >= WEEKDAY_LATER,
        )
        .sort((a, b) => b.m - a.m)[0];
      if (later) {
        flags.push('late_on_weekday');
        notes.push(`Starts later on ${WEEKDAYS[later.wd]} (around ${hhmm(later.m)})`);
      }
    }
    if (leftIn + idleCap >= 2) {
      flags.push('leaves_clocked_in');
      notes.push(`Left clocked in on ${plural(leftIn + idleCap, 'day')}`);
    }
    if (locked >= 2) {
      flags.push('locks_without_clocking_out');
      notes.push(`Locked the computer without clocking out on ${plural(locked, 'day')}`);
    }
    if (early >= 3) {
      flags.push('leaves_early');
      notes.push(`Left before the shift end on ${plural(early, 'day')}`);
    }
    if (split >= 3 && split / n >= 0.3) {
      flags.push('split_days');
      notes.push(`Splits the day into several sessions on ${plural(split, 'day')}`);
    }
    if (long >= 3) {
      flags.push('long_days');
      notes.push(`${plural(long, 'long day')} (an hour or more over the shift)`);
    }
    if (start && start.spread > IRREGULAR_SPREAD) {
      flags.push('irregular_start');
      notes.push(`Irregular start times (${hhmm(start.low)}–${hhmm(start.high)})`);
    }
    if (end && end.n >= MIN_DAYS && end.spread > IRREGULAR_SPREAD) {
      flags.push('irregular_end');
      notes.push(`Irregular finish times (${hhmm(end.low)}–${hhmm(end.high)})`);
    }
    if (signIn / n >= 0.8) {
      flags.push('starts_from_sign_in');
      notes.push('Clocks in from the computer sign-in time');
    }
    const quiet = !flags.some((f) => f !== 'starts_from_sign_in');
    if (
      quiet &&
      start &&
      start.spread <= STEADY_SPREAD &&
      (!end || end.n < MIN_DAYS || end.spread <= STEADY_SPREAD)
    ) {
      flags.unshift('steady');
    }
  }

  const range = `${start ? hhmm(start.median) : '?'}–${end ? hhmm(end.median) : '?'}`;
  const lead = notes.find((x) => !x.startsWith('Clocks in from'));
  const label = flags.includes('few_days')
    ? `Not enough days yet (${plural(n, 'day')})`
    : flags.includes('steady')
      ? `Steady ${range}`
      : (lead?.replace(/ \(.*\)$/, '').replace(/: .*$/, '') ?? `Usually ${range}`);

  return {
    employee_id: person.employee_id,
    name: person.name,
    tz: person.tz,
    days_worked: n,
    shift_days: shiftDays,
    start,
    end,
    start_by_weekday: byWeekday,
    late_days: late.length,
    late_median: median(late.map((d) => d.minutesLate ?? 0)),
    on_time_rate:
      shiftWorked.length > 0 ? (shiftWorked.length - late.length) / shiftWorked.length : null,
    early_leaves: early,
    left_clocked_in: leftIn + idleCap,
    idle_cap_outs: idleCap,
    locked_outs: locked,
    split_days: split,
    long_days: long,
    missed_starts: missed,
    from_sign_in: signIn,
    label,
    notes,
    flags,
  };
}

/** The Monday of `date`'s week. */
export function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

/** Pure: the whole picture, from everyone's days. */
export function companyHabits(
  people: readonly PersonHabits[],
  daysOf: ReadonlyMap<string, readonly HabitDay[]>,
  from: string,
): CompanyHabits {
  const all = [...daysOf.values()].flat();
  const w = all.filter(worked);
  const shiftWorked = w.filter((d) => d.shiftStartMin !== null);
  const late = w.filter((d) => d.status === 'late');
  const hours = (xs: readonly number[]): number[] => {
    const out = Array.from({ length: 24 }, () => 0);
    for (const m of xs) {
      const h = Math.floor((((m % DAY) + DAY) % DAY) / 60);
      out[h] = (out[h] ?? 0) + 1;
    }
    return out;
  };
  const starts = w.flatMap((d) => (d.inMin === null ? [] : [d.inMin]));
  const ends = w.flatMap((d) => (d.outMin === null ? [] : [d.outMin]));

  const weeks = new Map<string, HabitDay[]>();
  for (const d of all) {
    const k = mondayOf(d.date);
    weeks.set(k, [...(weeks.get(k) ?? []), d]);
  }
  const weekRows: WeekHabits[] = [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week_start, ds]) => {
      const ww = ds.filter(worked);
      const sw = ww.filter((d) => d.shiftStartMin !== null);
      const l = ww.filter((d) => d.status === 'late').length;
      return {
        week_start,
        days_worked: ww.length,
        on_time_rate: sw.length > 0 ? (sw.length - l) / sw.length : null,
        median_start: median(ww.flatMap((d) => (d.inMin === null ? [] : [d.inMin]))),
        median_end: median(ww.flatMap((d) => (d.outMin === null ? [] : [d.outMin]))),
        late_days: l,
        left_clocked_in: ww.filter((d) => d.stillIn || d.autoOut === 'idle_cap').length,
        auto_outs: ww.filter((d) => d.autoOut !== null).length,
      };
    });

  // Who changed: their first 7 days in the window against their last 7.
  const firstEnd = new Date(Date.parse(`${from}T00:00:00Z`) + 6 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const changed: HabitChange[] = [];
  for (const p of people) {
    const ds = (daysOf.get(p.employee_id) ?? []).filter(worked);
    const last = ds.at(-1)?.date;
    if (!last || last <= firstEnd) continue;
    const lastFrom = new Date(Date.parse(`${last}T00:00:00Z`) - 6 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const first = ds.filter((d) => d.date <= firstEnd);
    const recent = ds.filter((d) => d.date >= lastFrom && d.date > firstEnd);
    if (first.length < 2 || recent.length < 2) continue;
    const m = (xs: HabitDay[], k: 'inMin' | 'outMin'): number | null =>
      median(
        xs.flatMap((d) => {
          const v = d[k];
          return v === null ? [] : [v];
        }),
      );
    const fs = m(first, 'inMin');
    const ls = m(recent, 'inMin');
    const fe = m(first, 'outMin');
    const le = m(recent, 'outMin');
    const ss = fs !== null && ls !== null ? ls - fs : null;
    const es = fe !== null && le !== null ? le - fe : null;
    if (Math.abs(ss ?? 0) < CHANGED_MIN && Math.abs(es ?? 0) < CHANGED_MIN) continue;
    changed.push({
      employee_id: p.employee_id,
      name: p.name,
      start_shift: ss,
      end_shift: es,
      first_start: fs,
      last_start: ls,
      first_end: fe,
      last_end: le,
    });
  }
  changed.sort(
    (a, b) =>
      Math.max(Math.abs(b.start_shift ?? 0), Math.abs(b.end_shift ?? 0)) -
      Math.max(Math.abs(a.start_shift ?? 0), Math.abs(a.end_shift ?? 0)),
  );

  const flags: Partial<Record<HabitFlag, number>> = {};
  for (const p of people) for (const f of p.flags) flags[f] = (flags[f] ?? 0) + 1;

  return {
    people: people.filter((p) => p.days_worked > 0).length,
    days_worked: w.length,
    on_time_rate:
      shiftWorked.length > 0 ? (shiftWorked.length - late.length) / shiftWorked.length : null,
    median_start: median(starts),
    median_end: median(ends),
    start_hours: hours(starts),
    end_hours: hours(ends),
    flags,
    weeks: weekRows,
    changed,
  };
}

/** Flags that need a look, in the order the report lists them. */
export const LOOK_AT: readonly HabitFlag[] = [
  'missed_starts',
  'often_late',
  'leaves_clocked_in',
  'locks_without_clocking_out',
  'late_on_weekday',
  'leaves_early',
  'irregular_start',
  'irregular_end',
  'split_days',
  'long_days',
];

/** People who need a look first (by how many flags), then the rest by name. */
export function needsALookFirst(people: readonly PersonHabits[]): PersonHabits[] {
  const weight = (p: PersonHabits): number => p.flags.filter((f) => LOOK_AT.includes(f)).length;
  return [...people].sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name));
}
