import { clockIn as hhmm, zoneName } from '../alerts/mail.js';
import { countsOf, problemsFirst, type DayRow, type DayStatus } from './day.js';

/**
 * ADR-0040 §2: the day-end summary email. Plain text, readable on a
 * phone: a header with the counts, one line per person with problems
 * first, then a link. Totals and statuses only; never idle
 * explanations, notes or connection locations (§5).
 */

const LABEL: Record<DayStatus, string> = {
  not_clocked_in: 'not clocked in',
  late: 'late',
  worked: 'worked',
  not_working: 'not working today',
  in_office: 'in office',
  holiday: 'holiday',
  off: 'off',
};

/** "8h 05m", "45m". */
export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "Monday 12 Oct". */
function longDay(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  })
    .format(new Date(`${date}T12:00:00Z`))
    .replace(',', '');
}

const at = (r: DayRow, iso: string): string => hhmm(r.tz, new Date(iso));

function line(r: DayRow): string {
  const zone = r.shift ? zoneName(r.tz, new Date(r.shift.start)) : '';
  const shift = r.shift ? `shift ${at(r, r.shift.start)} ${zone}` : 'no shift';
  const waiting =
    r.corrections_waiting > 0
      ? `; ${r.corrections_waiting} correction${r.corrections_waiting === 1 ? '' : 's'} waiting`
      : '';
  switch (r.status) {
    case 'not_clocked_in':
      return `- ${r.name}: not clocked in (${shift})${waiting}`;
    case 'not_working':
      return `- ${r.name}: said not working today (${shift})${waiting}`;
    case 'holiday':
      return `- ${r.name}: holiday${r.holiday ? `, ${r.holiday}` : ''}`;
    case 'in_office':
      return `- ${r.name}: in office`;
    case 'off':
      return `- ${r.name}: off`;
    case 'late':
    case 'worked': {
      const parts = [
        `in ${r.clock_in ? at(r, r.clock_in) : '?'}`,
        r.still_in ? 'still clocked in' : `out ${r.clock_out ? at(r, r.clock_out) : '?'}`,
      ];
      if (r.status === 'late') parts[0] += ` (${r.minutes_late ?? 0} min late)`;
      const worked = r.shift_ms > 0 ? `${duration(r.worked_ms)} of ${duration(r.shift_ms)}` : '';
      parts.push(`${worked || duration(r.worked_ms)} worked`);
      if (r.idle_ms >= 15 * 60_000) parts.push(`idle ${duration(r.idle_ms)}`);
      if (r.breaks_over_limit > 0) {
        parts.push(
          `${r.breaks_over_limit} break${r.breaks_over_limit === 1 ? '' : 's'} over limit`,
        );
      }
      return `- ${r.name}: ${parts.join(', ')}${r.shift ? '' : ' (no shift)'}${waiting}`;
    }
  }
}

export interface DayMailInput {
  date: string;
  rows: readonly DayRow[];
  /** "Your team" or "Everyone". */
  who: string;
  siteUrl: string;
}

export function dayMailText(i: DayMailInput): { subject: string; text: string } {
  const c = countsOf(i.rows);
  const head = (
    ['worked', 'late', 'not_clocked_in', 'not_working', 'in_office', 'holiday'] as const
  )
    .filter((s) => c[s] > 0)
    .map((s) => `${c[s]} ${LABEL[s]}`);
  const day = longDay(i.date);
  const shown = problemsFirst(i.rows).filter((r) => r.status !== 'off');
  const off = c.off > 0 ? [``, `${c.off} off (no shift, nothing worked).`] : [];
  return {
    subject: `Day summary, ${day}: ${head.join(', ') || 'nobody on shift'}`,
    text: [
      `${i.who}, ${[day, ...head].join(' · ')}`,
      '',
      ...shown.map(line),
      ...off,
      '',
      'Times are in each shift’s zone. Hours count work, calls and Away.',
      `See Team in CloudPunch: ${i.siteUrl.replace(/\/$/, '')}/app/`,
    ].join('\n'),
  };
}
