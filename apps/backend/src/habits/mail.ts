import { esc } from '../reports/mailHtml.js';
import { hhmm, LOOK_AT, type HabitFlag, type HabitsReport, type PersonHabits } from './model.js';

/**
 * ADR-0051 §3: the habits email, weekly and final. Like the day-end
 * email (ADR-0040 §2): tables and inline styles only, 600 wide, readable
 * on a phone. The headline, the week-by-week trend, who changed, the
 * habits that need a look, then everyone. Times only.
 */

const INK = '#0b0b0b';
const INK_2 = '#52514e';
const MUTED = '#898781';
const LINE = '#e1e0d9';
const SURFACE = '#fcfcfb';
const PAGE = '#f4f4f1';
const ACCENT = '#2a78d6';
const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';

export const FLAG_TITLE: Record<HabitFlag, string> = {
  few_days: 'Not enough days yet',
  steady: 'Steady',
  irregular_start: 'Irregular start times',
  irregular_end: 'Irregular finish times',
  often_late: 'Often late',
  late_on_weekday: 'Later on one weekday',
  leaves_clocked_in: 'Leaves clocked in',
  locks_without_clocking_out: 'Locks up without clocking out',
  leaves_early: 'Leaves before the shift end',
  split_days: 'Splits the day',
  long_days: 'Long days',
  missed_starts: 'Missed clock-ins',
  starts_from_sign_in: 'Starts from sign-in',
};

const pct = (r: number | null): string => (r === null ? '—' : `${Math.round(r * 100)}%`);
const t = (m: number | null | undefined): string => (m === null || m === undefined ? '—' : hhmm(m));
const signed = (m: number | null): string =>
  m === null || m === 0 ? '—' : `${m > 0 ? '+' : '−'}${Math.abs(m)} min`;

/** "15 Oct". */
function short(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T12:00:00Z`));
}

export interface HabitsMailInput {
  report: HabitsReport;
  /** "Habits so far (week 2 of ~4)" or "30-day habits report". */
  title: string;
  final: boolean;
  /** The console's Habits tab. */
  reportUrl: string;
}

function usual(p: PersonHabits): string {
  const s = p.start ? `${t(p.start.median)} (${t(p.start.low)}–${t(p.start.high)})` : '—';
  const e = p.end ? `${t(p.end.median)} (${t(p.end.low)}–${t(p.end.high)})` : '—';
  return `in ${s}, out ${e}`;
}

export function habitsMailText(i: HabitsMailInput): { subject: string; text: string } {
  const { report: r, title } = i;
  const c = r.company;
  const lines = [
    `${title}: ${short(r.from)} – ${short(r.to)}`,
    '',
    `${c.people} people, ${c.days_worked} days worked. On time ${pct(c.on_time_rate)}. Usual start ${t(c.median_start)}, finish ${t(c.median_end)}.`,
    '',
  ];
  if (c.changed.length > 0) {
    lines.push('Who changed (first week against the latest):');
    for (const ch of c.changed.slice(0, 10)) {
      lines.push(`- ${ch.name}: start ${signed(ch.start_shift)}, finish ${signed(ch.end_shift)}`);
    }
    lines.push('');
  }
  const look = r.people.filter((p) => p.flags.some((f) => LOOK_AT.includes(f)));
  if (look.length > 0) {
    lines.push('Needs a look:');
    for (const p of look) lines.push(`- ${p.name}: ${p.notes.join('; ')}`);
    lines.push('');
  }
  lines.push('Everyone:');
  for (const p of r.people) lines.push(`- ${p.name}: ${p.label}. ${usual(p)}`);
  lines.push('', `Open it in CloudPunch: ${i.reportUrl}`);
  return { subject: `CloudPunch: ${title}`, text: lines.join('\n') };
}

const cell = (s: string, extra = ''): string =>
  `<td style="padding:6px 8px;border-top:1px solid ${LINE};font-size:13px;color:${INK};${extra}">${s}</td>`;
const head = (s: string): string =>
  `<th align="left" style="padding:6px 8px;font-size:11px;font-weight:600;color:${MUTED};text-transform:uppercase;letter-spacing:.04em">${s}</th>`;
const section = (title: string, body: string): string =>
  `<tr><td style="padding:18px 20px 4px"><div style="font-size:15px;font-weight:650;color:${INK}">${esc(title)}</div>${body}</td></tr>`;

export function habitsMailHtml(i: HabitsMailInput): { subject: string; html: string } {
  const { report: r, title } = i;
  const c = r.company;
  const tile = (value: string, label: string): string =>
    `<td width="25%" style="padding:10px;background:${PAGE};border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:650;color:${INK}">${esc(value)}</div><div style="font-size:11.5px;color:${INK_2}">${esc(label)}</div></td>`;
  const tiles = `<table role="presentation" width="100%" cellspacing="6" cellpadding="0"><tr>${tile(String(c.people), 'people')}${tile(pct(c.on_time_rate), 'on time')}${tile(t(c.median_start), 'usual start')}${tile(t(c.median_end), 'usual finish')}</tr></table>`;

  const weeks =
    c.weeks.length > 0
      ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${head('Week of')}${head('On time')}${head('Start')}${head('Finish')}${head('Late')}${head('Left in')}</tr>${c.weeks
          .map(
            (w) =>
              `<tr>${cell(esc(short(w.week_start)))}${cell(pct(w.on_time_rate))}${cell(t(w.median_start))}${cell(t(w.median_end))}${cell(String(w.late_days))}${cell(String(w.left_clocked_in))}</tr>`,
          )
          .join('')}</table>`
      : '';

  const changed =
    c.changed.length > 0
      ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${head('Person')}${head('Start')}${head('Finish')}</tr>${c.changed
          .slice(0, 10)
          .map(
            (ch) =>
              `<tr>${cell(esc(ch.name))}${cell(`${t(ch.first_start)} → ${t(ch.last_start)} <span style="color:${MUTED}">${signed(ch.start_shift)}</span>`)}${cell(`${t(ch.first_end)} → ${t(ch.last_end)} <span style="color:${MUTED}">${signed(ch.end_shift)}</span>`)}</tr>`,
          )
          .join('')}</table>`
      : `<div style="font-size:13px;color:${INK_2};padding:6px 0">Nobody's start or finish moved by half an hour or more.</div>`;

  const look = r.people.filter((p) => p.flags.some((f) => LOOK_AT.includes(f)));
  const lookHtml =
    look.length > 0
      ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${look
          .map(
            (p) =>
              `<tr>${cell(`<b>${esc(p.name)}</b>`, 'width:34%;vertical-align:top')}${cell(p.notes.map(esc).join('<br>'), `color:${INK_2}`)}</tr>`,
          )
          .join('')}</table>`
      : `<div style="font-size:13px;color:${INK_2};padding:6px 0">No habits that need a look.</div>`;

  const everyone = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${head('Person')}${head('Pattern')}${head('Usually in')}${head('Usually out')}</tr>${r.people
    .map(
      (p) =>
        `<tr>${cell(esc(p.name))}${cell(esc(p.label), `color:${INK_2}`)}${cell(p.start ? `${t(p.start.median)}<div style="font-size:11px;color:${MUTED}">${t(p.start.low)}–${t(p.start.high)}</div>` : '—', 'white-space:nowrap')}${cell(p.end ? `${t(p.end.median)}<div style="font-size:11px;color:${MUTED}">${t(p.end.low)}–${t(p.end.high)}</div>` : '—', 'white-space:nowrap')}</tr>`,
    )
    .join('')}</table>`;

  const intro = i.final
    ? 'The full 30 days: how everyone usually starts and finishes, and the habits worth a word.'
    : 'How everyone has been starting and finishing so far. A final report follows at the end of the 30 days.';

  const html = `<!doctype html><html><body style="margin:0;background:${PAGE};font-family:${FONT}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${PAGE}"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:${SURFACE};border:1px solid ${LINE};border-radius:12px">
<tr><td style="padding:20px 20px 6px"><div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.06em">CloudPunch · ${esc(short(r.from))} – ${esc(short(r.to))}</div><div style="font-size:20px;font-weight:650;color:${INK};margin-top:4px">${esc(title)}</div><div style="font-size:13px;color:${INK_2};margin-top:4px">${esc(intro)}</div></td></tr>
<tr><td style="padding:6px 14px">${tiles}</td></tr>
${c.weeks.length > 1 ? section('Week by week', weeks) : ''}
${section('Who changed', changed)}
${section('Needs a look', lookHtml)}
${section('Everyone', everyone)}
<tr><td style="padding:18px 20px 22px"><a href="${esc(i.reportUrl)}" style="display:inline-block;background:${ACCENT};color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 16px;border-radius:8px">Open Habits in CloudPunch</a><div style="font-size:11.5px;color:${MUTED};margin-top:10px">Times are each person's own (their usual time zone). Ranges are the middle half of their days.</div></td></tr>
</table></td></tr></table></body></html>`;
  return { subject: `CloudPunch: ${title}`, html };
}
