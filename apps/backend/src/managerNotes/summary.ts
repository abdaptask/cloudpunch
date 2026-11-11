import { clockIn } from '../alerts/mail.js';
import type { ManagerNoteTopic } from '../db/index.js';
import type { DayRow } from '../reports/day.js';

/**
 * "Tell manager" (ADR-0055), pure: a person's 14 days in numbers, the
 * follow-up comparison, and the two emails. Built from the same day rows
 * as Reports (ADR-0040), so nothing new is collected (invariant 1).
 */

/** The days a note summarises, and the days until its follow-up. */
export const NOTE_DAYS = 14;

export const TOPICS: readonly ManagerNoteTopic[] = ['activity', 'timings', 'breaks', 'missed'];

export const TOPIC_LABEL: Record<ManagerNoteTopic, string> = {
  activity: 'activity level',
  timings: 'start and finish times',
  breaks: 'breaks',
  missed: 'missed days',
};

export interface SummaryDay {
  date: string;
  status: DayRow['status'];
  tz: string;
  clock_in: string | null;
  clock_out: string | null;
  still_in: boolean;
  minutes_late: number | null;
  worked_ms: number;
  shift_ms: number;
  idle_ms: number;
  breaks_over_limit: number;
}

export interface NoteSummary {
  from: string;
  to: string;
  /** Shift days that counted: worked, late or missed. */
  shift_days: number;
  on_time: number;
  late: number;
  missed: number;
  worked_days: number;
  worked_ms: number;
  scheduled_ms: number;
  idle_ms: number;
  breaks_over: number;
  days: SummaryDay[];
}

const isWorked = (r: DayRow): boolean => r.status === 'worked' || r.status === 'late';

export function summaryOf(rows: readonly DayRow[], from: string, to: string): NoteSummary {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const worked = sorted.filter(isWorked);
  const shiftDays = sorted.filter(
    (r) => (isWorked(r) || r.status === 'not_clocked_in') && r.shift !== null,
  );
  return {
    from,
    to,
    shift_days: shiftDays.length,
    on_time: sorted.filter((r) => r.status === 'worked' && r.shift !== null).length,
    late: sorted.filter((r) => r.status === 'late').length,
    missed: sorted.filter((r) => r.status === 'not_clocked_in').length,
    worked_days: worked.length,
    worked_ms: worked.reduce((s, r) => s + r.worked_ms, 0),
    scheduled_ms: shiftDays.reduce((s, r) => s + r.shift_ms, 0),
    idle_ms: worked.reduce((s, r) => s + r.idle_ms, 0),
    breaks_over: worked.reduce((s, r) => s + r.breaks_over_limit, 0),
    days: sorted.map((r) => ({
      date: r.date,
      status: r.status,
      tz: r.tz,
      clock_in: r.clock_in,
      clock_out: r.clock_out,
      still_in: r.still_in,
      minutes_late: r.minutes_late,
      worked_ms: r.worked_ms,
      shift_ms: r.shift_ms,
      idle_ms: r.idle_ms,
      breaks_over_limit: r.breaks_over_limit,
    })),
  };
}

// ---------------------------------------------------------------------
// The follow-up (ADR-0055 §5)

export type Change = 'better' | 'worse' | 'same' | 'unknown';
export type Verdict = 'improved' | 'no_change' | 'worse';

export interface TopicResult {
  topic: ManagerNoteTopic;
  /** The measure before and after; null when there was nothing to measure. */
  before: number | null;
  after: number | null;
  change: Change;
}

export interface FollowUpResult {
  verdict: Verdict;
  topics: TopicResult[];
  after: Omit<NoteSummary, 'days'>;
}

/** Shares move by 5 points; counts by one whole break or missed day. */
const SHARE_MARGIN = 0.05;
const COUNT_MARGIN = 1;

/** What each topic measures, and whether higher is better. */
function measure(
  topic: ManagerNoteTopic,
  s: NoteSummary | Omit<NoteSummary, 'days'>,
): number | null {
  switch (topic) {
    case 'timings':
      return s.shift_days > 0 ? s.on_time / s.shift_days : null;
    case 'activity':
      return s.worked_ms > 0 ? s.idle_ms / s.worked_ms : null;
    case 'breaks':
      return s.worked_days > 0 ? s.breaks_over : null;
    case 'missed':
      return s.shift_days > 0 ? s.missed : null;
  }
}

const HIGHER_IS_BETTER: Record<ManagerNoteTopic, boolean> = {
  timings: true,
  activity: false,
  breaks: false,
  missed: false,
};

export function compare(
  topics: readonly ManagerNoteTopic[],
  before: NoteSummary,
  after: NoteSummary,
): FollowUpResult {
  const results = topics.map((topic): TopicResult => {
    const b = measure(topic, before);
    const a = measure(topic, after);
    if (b === null || a === null) return { topic, before: b, after: a, change: 'unknown' };
    const margin = topic === 'timings' || topic === 'activity' ? SHARE_MARGIN : COUNT_MARGIN;
    const up = a - b;
    const change: Change =
      Math.abs(up) < margin - 1e-9
        ? 'same'
        : up > 0 === HIGHER_IS_BETTER[topic]
          ? 'better'
          : 'worse';
    return { topic, before: b, after: a, change };
  });
  const better = results.filter((r) => r.change === 'better').length;
  const worse = results.filter((r) => r.change === 'worse').length;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { days, ...totals } = after;
  return {
    verdict: better > worse ? 'improved' : worse > better ? 'worse' : 'no_change',
    topics: results,
    after: totals,
  };
}

// ---------------------------------------------------------------------
// Words

export const VERDICT_LABEL: Record<Verdict, string> = {
  improved: 'Improved',
  no_change: 'No change',
  worse: 'Worse',
};

/** "7h 05m". */
export function hm(ms: number): string {
  const min = Math.round(ms / 60_000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mon 27 Oct" for `YYYY-MM-DD`. */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return `${WEEKDAY[at.getUTCDay()]} ${at.getUTCDate()} ${MONTH[at.getUTCMonth()]}`;
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

export const listText = (topics: readonly ManagerNoteTopic[]): string =>
  topics.map((t) => TOPIC_LABEL[t]).join(', ');

/** One line per day, for the email. */
function dayLine(d: SummaryDay): string {
  const label = dayLabel(d.date).padEnd(11);
  switch (d.status) {
    case 'not_clocked_in':
      return `${label} missed (no clock-in)`;
    case 'holiday':
      return `${label} holiday`;
    case 'not_working':
      return `${label} not working`;
    case 'off':
      return `${label} off`;
    case 'in_office':
      return `${label} in the office`;
    default: {
      if (!d.clock_in) return `${label} -`;
      const start = clockIn(d.tz, new Date(d.clock_in));
      const end = d.clock_out
        ? clockIn(d.tz, new Date(d.clock_out))
        : d.still_in
          ? 'still in'
          : '?';
      const late =
        d.status === 'late' && d.minutes_late !== null ? ` (late ${d.minutes_late} min)` : '';
      const idle = d.idle_ms >= 60_000 ? `, idle ${hm(d.idle_ms)}` : '';
      const breaks = d.breaks_over_limit > 0 ? `, ${d.breaks_over_limit} long break(s)` : '';
      return `${label} ${start}–${end}${late}, ${hm(d.worked_ms)} worked${idle}${breaks}`;
    }
  }
}

/** The headline numbers, one per line. */
export function totalsLines(s: Omit<NoteSummary, 'days'>): string[] {
  const lines = [
    s.shift_days > 0
      ? `- On time: ${s.on_time} of ${s.shift_days} shift days (${s.late} late, ${s.missed} missed)`
      : '- No shift days in this period',
    `- Hours worked: ${hm(s.worked_ms)}${s.scheduled_ms > 0 ? ` of ${hm(s.scheduled_ms)} scheduled` : ''}`,
    `- Idle: ${hm(s.idle_ms)}${s.worked_ms > 0 ? ` (${pct(s.idle_ms / s.worked_ms)} of worked time)` : ''}`,
    `- Breaks over their limit: ${s.breaks_over}`,
  ];
  return lines;
}

export interface NoteMailInput {
  person: string;
  personFirst: string;
  manager: string;
  managerFirst: string;
  sender: string;
  topics: readonly ManagerNoteTopic[];
  message: string;
  summary: NoteSummary;
  followUpOn: string;
  siteUrl: string;
}

/** The note, to the manager (ADR-0055 §3). */
export function noteMail(i: NoteMailInput): { subject: string; text: string } {
  const site = i.siteUrl.replace(/\/$/, '');
  return {
    subject: `Please keep an eye on ${i.person}`,
    text: [
      `Hi ${i.managerFirst},`,
      '',
      `${i.sender} has asked you to keep an eye on ${i.person}'s ${listText(i.topics)}.`,
      '',
      i.message,
      '',
      `${i.personFirst}'s last ${NOTE_DAYS} days (${dayLabel(i.summary.from)} to ${dayLabel(i.summary.to)}):`,
      ...totalsLines(i.summary),
      '',
      'Day by day:',
      ...i.summary.days.map(dayLine),
      '',
      `Please open Team in CloudPunch and click "Seen, I'll follow up": ${site}/app/`,
      `On ${dayLabel(i.followUpOn)} CloudPunch compares the next ${NOTE_DAYS} days with these and tells ${i.sender} how it went.`,
      '',
      `This note goes to you only. ${i.personFirst} doesn't get it.`,
    ].join('\n'),
  };
}

const measureText = (topic: ManagerNoteTopic, v: number | null): string => {
  if (v === null) return 'n/a';
  return topic === 'timings'
    ? `${pct(v)} on time`
    : topic === 'activity'
      ? `${pct(v)} idle`
      : topic === 'breaks'
        ? `${v} over limit`
        : `${v} missed`;
};

const CHANGE_WORD: Record<Change, string> = {
  better: 'better',
  worse: 'worse',
  same: 'about the same',
  unknown: 'not enough days to tell',
};

export interface FollowUpMailInput {
  person: string;
  manager: string;
  senderFirst: string;
  sentOn: string;
  seenOn: string | null;
  result: FollowUpResult;
  siteUrl: string;
}

/** The follow-up, to whoever sent the note, the manager copied (ADR-0055 §5). */
export function followUpMail(i: FollowUpMailInput): { subject: string; text: string } {
  const site = i.siteUrl.replace(/\/$/, '');
  const verdict = VERDICT_LABEL[i.result.verdict];
  return {
    subject: `Follow-up on ${i.person}: ${verdict}`,
    text: [
      `Hi ${i.senderFirst},`,
      '',
      `On ${dayLabel(i.sentOn)} you asked ${i.manager} to keep an eye on ${i.person}. ` +
        (i.seenOn
          ? `${i.manager} marked it seen on ${dayLabel(i.seenOn)}.`
          : `${i.manager} hasn't marked it seen in CloudPunch.`),
      '',
      `The ${NOTE_DAYS} days since, against the ${NOTE_DAYS} days before:`,
      ...i.result.topics.map(
        (r) =>
          `- ${TOPIC_LABEL[r.topic][0]?.toUpperCase()}${TOPIC_LABEL[r.topic].slice(1)}: ` +
          `${measureText(r.topic, r.before)} -> ${measureText(r.topic, r.after)} (${CHANGE_WORD[r.change]})`,
      ),
      '',
      `Overall: ${verdict}.`,
      '',
      'The last 14 days:',
      ...totalsLines(i.result.after),
      '',
      `See their days in CloudPunch: ${site}/app/admin/`,
    ].join('\n'),
  };
}
