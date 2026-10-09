/**
 * Pure helpers for the manager and HR Team screens (ADR-0025): the
 * words for someone's status now, an exception, and a day's rows.
 */
import type { TeamDay, TeamException, TeamPerson } from './api.js';
import { asRecordedWallTime } from './dayHistory.js';
import { formatClock, KIND_LABEL, type SegmentKind } from './timelineModel.js';

const label = (kind: string | null): string =>
  kind && kind in KIND_LABEL ? KIND_LABEL[kind as SegmentKind] : 'Break';

const clock = (iso: string | null): string => (iso ? formatClock(Date.parse(iso)) : '');

/** "Personal · back by 10:45", "In a meeting since 2:10 pm", "Not clocked in". */
export function statusText(p: TeamPerson): string {
  switch (p.status) {
    case 'clocked_out':
      return p.since ? `Clocked out at ${clock(p.since)}` : 'Not clocked in';
    case 'working':
      return `Working since ${clock(p.since)}`;
    case 'on_call':
      return `${label(p.kind)} since ${clock(p.since)}`;
    case 'on_break':
      return p.back_by
        ? `${label(p.kind)} · back by ${clock(p.back_by)}`
        : `${label(p.kind)} since ${clock(p.since)}`;
    case 'away':
      return `${label(p.kind)} since ${clock(p.since)}`;
    case 'prompt':
      return 'Idle prompt showing';
    case 'idle':
      return `Idle since ${clock(p.since)}`;
    case 'shift_not_started':
      return `Not clocked in · shift started ${clock(p.since)}`;
    case 'not_working':
      return 'Said not working today';
    case 'holiday':
      return p.holiday ? `Holiday: ${p.holiday}` : 'Holiday';
  }
}

/** "Missed starts: 4 in 30 days · Not working today: 1" (ADR-0037 §4), or null. */
export function startsText(p: TeamPerson): string | null {
  const s = p.starts;
  if (!s || (s.missed === 0 && s.not_working === 0)) return null;
  const parts = [`Missed starts: ${s.missed} in ${s.days} days`];
  if (s.not_working > 0) parts.push(`Not working today: ${s.not_working}`);
  return parts.join(' · ');
}

/** A break back-by time that has passed: "late" on the Team list. */
export function overdue(p: TeamPerson, now: number): boolean {
  return p.status === 'on_break' && p.back_by !== null && Date.parse(p.back_by) < now;
}

const EXPLANATION: Record<string, string> = {
  working_away: 'Working away from the computer',
  meeting: 'In a meeting',
  phone_call: 'On a phone call',
  break: 'On a break',
  idle: 'Not working',
};

/** "20 min", "1h 12m". */
export const hm = (minutes: number): string => {
  const m = Math.max(0, Math.round(minutes));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

/** One line for an exception, and the person's own account if any. */
export function exceptionText(e: TeamException): { text: string; said: string | null } {
  const len = e.minutes ?? 0;
  const over = e.over_minutes ?? 0;
  switch (e.kind) {
    case 'long_idle': {
      const x = e.explanation;
      const said = x
        ? `Said: ${EXPLANATION[x.explanation] ?? x.explanation}${x.note ? ` · “${x.note}”` : ''}`
        : 'No explanation given';
      return { text: `Idle ${hm(len)} from ${clock(e.at)}`, said };
    }
    case 'break_over_planned':
      return {
        text: `${label(e.segment)} ${hm(len)} · planned ${hm(len - over)} (+${hm(over)})`,
        said: null,
      };
    case 'break_over_limit':
      return {
        text: `${label(e.segment)} ${hm(len)} · limit ${hm(len - over)} (+${hm(over)})`,
        said: null,
      };
    case 'long_shift':
      return { text: `Worked ${hm(len)} (${hm(over)} over the long-shift mark)`, said: null };
    case 'auto_clock_out':
      return { text: `Clocked out automatically after long idle at ${clock(e.at)}`, said: null };
    case 'presence_check': {
      const what =
        e.pattern === 'periodic' ? 'input in a fixed rhythm' : 'non-stop input with no pauses';
      return e.answered
        ? { text: `Presence check at ${clock(e.at)} (${what}): answered`, said: null }
        : {
            text: `Presence check (${what}): not answered · idle ${hm(len)} from ${clock(e.at)}`,
            said: e.explanation
              ? `Said: ${EXPLANATION[e.explanation.explanation] ?? e.explanation.explanation}`
              : null,
          };
    }
    case 'long_away': {
      const how =
        e.ended_by === 'input'
          ? ' · ended when they were back at the computer'
          : e.ended_by === 'call'
            ? ' · ended when a call started'
            : '';
      return { text: `${label(e.segment)} ${hm(len)} from ${clock(e.at)}${how}`, said: null };
    }
    case 'reconstructed':
      return {
        text: `Session from ${clock(e.at)} recovered after the app closed unexpectedly`,
        said: null,
      };
  }
}

export interface DayRow {
  kind: string;
  label: string;
  /** Recorded wall time, epoch ms (as the employee's clock read). */
  from: number;
  to: number;
  /** "Personal · planned 20m · took 24m" details, or the idle account. */
  detail: string | null;
  /** The break went over the plan. */
  late: boolean;
}

/** A team member's day as rows, on the clock where the work happened. */
export function dayRows(day: TeamDay): DayRow[] {
  return day.sessions.flatMap((s) =>
    s.segments.map((g) => {
      const from = asRecordedWallTime(g.started_at);
      const to = asRecordedWallTime(g.ended_at);
      const took = Math.round((to - from) / 60_000);
      let detail: string | null = null;
      let late = false;
      if (g.correction_id) {
        // An approved correction's stretch (ADR-0030 §4: never hidden).
        detail = 'Corrected';
      } else if (g.planned_minutes !== undefined) {
        late = took > g.planned_minutes;
        const more = g.extended_minutes ? ` (incl. +${hm(g.extended_minutes)})` : '';
        detail = `Planned ${hm(g.planned_minutes)}${more} · took ${hm(took)}`;
      } else if (g.ended_by) {
        detail =
          g.ended_by === 'input'
            ? 'Ended on its own: back at the computer'
            : 'Ended on its own: a call started';
      } else if (g.presence_check && g.kind === 'prompt') {
        detail = 'Presence check · answered';
      } else if (g.kind === 'idle') {
        const x = g.explanation;
        detail = x
          ? `Said: ${EXPLANATION[x.explanation] ?? x.explanation}${x.note ? ` · “${x.note}”` : ''}`
          : 'No explanation given';
        if (g.presence_check) detail = `Presence check not answered · ${detail}`;
      }
      return {
        kind: g.kind,
        label: g.presence_check && g.kind === 'prompt' ? 'Presence check' : label(g.kind),
        from,
        to,
        detail,
        late: late || (g.kind === 'idle' && !!g.presence_check),
      };
    }),
  );
}
