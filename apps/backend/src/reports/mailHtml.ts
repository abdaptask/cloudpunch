import { clockIn as hhmm, zoneName } from '../alerts/mail.js';
import { countsOf, problemsFirst, type DayRow } from './day.js';
import { duration } from './mail.js';

/**
 * ADR-0040 §2: the day-end summary as an HTML email (owner, 2026-10-14:
 * the text list was "barely of any use"). Built for mail clients:
 * tables and inline styles only, no scripts, no SVG (Outlook), 600 wide,
 * readable on a phone. Headline numbers, a status bar, what needs
 * attention, then everyone with a small hours bar, and a button to the
 * interactive report. Totals and statuses only (§5).
 */

const INK = '#0b0b0b';
const INK_2 = '#52514e';
const MUTED = '#898781';
const LINE = '#e1e0d9';
const SURFACE = '#fcfcfb';
const PAGE = '#f4f4f1';
/** Status colours (reserved), always with a label beside them. */
const GOOD = '#0ca30c';
const WARNING = '#fab219';
const CRITICAL = '#d03b3b';
const NEUTRAL = '#c3c2b7';
/** The timeline's three kinds (validated categorical slots 1–3). */
const WORK = '#2a78d6';
const IDLE = '#eb6834';
const BREAK = '#1baf7a';
const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';

/** Long idle and short or long days: what "needs attention" means here. */
export const LONG_IDLE_MS = 60 * 60_000;
const SHORT_DAY = 0.8;
const LONG_DAY_EXTRA_MS = 60 * 60_000;

export const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

const at = (r: DayRow, iso: string | null): string => (iso ? hhmm(r.tz, new Date(iso)) : '—');
const zone = (r: DayRow): string =>
  r.shift ? zoneName(r.tz, new Date(r.shift.start)).replace('GMT+5:30', 'IST') : '';
const worked = (r: DayRow): boolean => r.status === 'worked' || r.status === 'late';

/** "Tuesday 13 Oct". */
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

export interface Attention {
  notClockedIn: DayRow[];
  late: DayRow[];
  stillIn: DayRow[];
  longIdle: DayRow[];
  breaksOver: DayRow[];
  shortDays: DayRow[];
  longDays: DayRow[];
}

/** Pure: who needs a look, each list sorted worst first. */
export function attentionOf(rows: readonly DayRow[]): Attention {
  const w = rows.filter(worked);
  const done = w.filter((r) => !r.still_in);
  return {
    notClockedIn: rows
      .filter((r) => r.status === 'not_clocked_in')
      .sort((a, b) => a.name.localeCompare(b.name)),
    late: rows
      .filter((r) => r.status === 'late')
      .sort((a, b) => (b.minutes_late ?? 0) - (a.minutes_late ?? 0)),
    stillIn: w.filter((r) => r.still_in).sort((a, b) => b.worked_ms - a.worked_ms),
    longIdle: w.filter((r) => r.idle_ms >= LONG_IDLE_MS).sort((a, b) => b.idle_ms - a.idle_ms),
    breaksOver: w
      .filter((r) => r.breaks_over_limit > 0)
      .sort((a, b) => b.breaks_over_limit - a.breaks_over_limit),
    shortDays: done
      .filter((r) => r.shift_ms > 0 && r.worked_ms < r.shift_ms * SHORT_DAY)
      .sort((a, b) => a.worked_ms / a.shift_ms - b.worked_ms / b.shift_ms),
    longDays: w
      .filter((r) => r.shift_ms > 0 && r.worked_ms > r.shift_ms + LONG_DAY_EXTRA_MS)
      .sort((a, b) => b.worked_ms - a.worked_ms),
  };
}

export interface DayHtmlInput {
  date: string;
  rows: readonly DayRow[];
  who: string;
  /** The interactive report for this day. */
  reportUrl: string;
}

function tile(label: string, value: string, note: string, accent?: string): string {
  return `<td valign="top" style="width:25%;padding:6px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};border:1px solid ${LINE};border-radius:10px">
    <tr><td style="padding:12px 14px">
      <div style="font:600 12px ${FONT};color:${INK_2}">${accent ? `<span style="color:${accent}">&#9679;</span> ` : ''}${esc(label)}</div>
      <div style="font:700 26px/1.2 ${FONT};color:${INK};padding-top:4px">${esc(value)}</div>
      <div style="font:12px/1.35 ${FONT};color:${MUTED};padding-top:2px">${esc(note)}</div>
    </td></tr>
  </table>
</td>`;
}

/** A horizontal bar of parts (percent widths), with a 2px surface gap. */
function bar(parts: readonly { pct: number; color: string }[], height = 10): string {
  const shown = parts.filter((p) => p.pct > 0.4);
  const cells = shown
    .map(
      (p, i) =>
        `<td style="width:${p.pct.toFixed(1)}%;background:${p.color};height:${height}px;${i > 0 ? `border-left:2px solid ${SURFACE};` : ''}font-size:0;line-height:0">&nbsp;</td>`,
    )
    .join('');
  const rest = Math.max(0, 100 - shown.reduce((s, p) => s + p.pct, 0));
  const pad =
    rest > 0.4
      ? `<td style="width:${rest.toFixed(1)}%;height:${height}px;font-size:0;line-height:0">&nbsp;</td>`
      : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:4px;overflow:hidden;background:${PAGE}"><tr>${cells}${pad}</tr></table>`;
}

function section(title: string, count: number, body: string, color: string): string {
  return `<tr><td style="padding:14px 6px 4px">
  <div style="font:700 14px ${FONT};color:${INK}"><span style="color:${color}">&#9679;</span> ${esc(title)} <span style="font-weight:400;color:${MUTED}">(${count})</span></div>
  <div style="font:13px/1.6 ${FONT};color:${INK_2};padding-top:4px">${body}</div>
</td></tr>`;
}

const list = (items: readonly string[], max = 12): string => {
  const more =
    items.length > max ? ` <span style="color:${MUTED}">and ${items.length - max} more</span>` : '';
  return items.slice(0, max).join(' &middot; ') + more;
};

const strong = (s: string): string => `<strong style="color:${INK}">${esc(s)}</strong>`;

export function dayMailHtml(i: DayHtmlInput): { subject: string; html: string } {
  const c = countsOf(i.rows);
  const day = longDay(i.date);
  const onShift = c.worked + c.late + c.not_clocked_in;
  const clockedIn = c.worked + c.late;
  const w = i.rows.filter(worked);
  const done = w.filter((r) => r.shift_ms > 0);
  const avgWorked = done.length ? done.reduce((s, r) => s + r.worked_ms, 0) / done.length : 0;
  const avgShift = done.length ? done.reduce((s, r) => s + r.shift_ms, 0) / done.length : 0;
  const lateMins = i.rows.filter((r) => r.status === 'late').map((r) => r.minutes_late ?? 0);
  const avgLate = lateMins.length
    ? Math.round(lateMins.reduce((s, m) => s + m, 0) / lateMins.length)
    : 0;
  const a = attentionOf(i.rows);
  const pct = (n: number): number => (onShift > 0 ? (n / onShift) * 100 : 0);

  const tiles = [
    tile(
      'Clocked in',
      `${clockedIn} / ${onShift}`,
      onShift ? `${Math.round(pct(clockedIn))}% of those on shift` : 'nobody on shift',
      GOOD,
    ),
    tile(
      'Late',
      String(c.late),
      c.late ? `${duration(avgLate * 60_000)} late on average` : 'none',
      WARNING,
    ),
    tile('Not clocked in', String(c.not_clocked_in), 'had a shift, no clock-in', CRITICAL),
    tile(
      'Hours worked',
      done.length ? duration(avgWorked) : '—',
      done.length ? `average, of ${duration(avgShift)} scheduled` : 'nothing worked',
    ),
  ];

  const other = c.not_working + c.in_office + c.holiday;
  const statusBar = bar([
    { pct: pct(c.worked), color: GOOD },
    { pct: pct(c.late), color: WARNING },
    { pct: pct(c.not_clocked_in), color: CRITICAL },
  ]);
  const legend = [
    [GOOD, 'On time', c.worked],
    [WARNING, 'Late', c.late],
    [CRITICAL, 'Not clocked in', c.not_clocked_in],
  ]
    .map(
      ([color, label, n]) =>
        `<span style="white-space:nowrap;padding-right:14px"><span style="color:${color}">&#9679;</span> ${label} <strong style="color:${INK}">${n}</strong></span>`,
    )
    .join('');
  const others =
    other + c.off > 0
      ? `<div style="font:12px ${FONT};color:${MUTED};padding-top:4px">Also: ${[
          c.not_working && `${c.not_working} not working today`,
          c.in_office && `${c.in_office} in office`,
          c.holiday && `${c.holiday} on holiday`,
          c.off && `${c.off} off`,
        ]
          .filter(Boolean)
          .join(' · ')}</div>`
      : '';

  const attention = [
    a.notClockedIn.length &&
      section(
        'Not clocked in',
        a.notClockedIn.length,
        list(
          a.notClockedIn.map(
            (r) =>
              `${strong(r.name)} <span style="color:${MUTED}">${at(r, r.shift?.start ?? null)} ${zone(r)}</span>`,
          ),
        ),
        CRITICAL,
      ),
    a.late.length &&
      section(
        'Late',
        a.late.length,
        list(a.late.map((r) => `${strong(r.name)} +${duration((r.minutes_late ?? 0) * 60_000)}`)),
        WARNING,
      ),
    a.stillIn.length &&
      section(
        'Still clocked in (may have forgotten to clock out)',
        a.stillIn.length,
        list(a.stillIn.map((r) => `${strong(r.name)} ${duration(r.worked_ms)} so far`)),
        WARNING,
      ),
    a.longIdle.length &&
      section(
        'Idle an hour or more',
        a.longIdle.length,
        list(a.longIdle.map((r) => `${strong(r.name)} ${duration(r.idle_ms)}`)),
        IDLE,
      ),
    a.breaksOver.length &&
      section(
        'Breaks over their limit',
        a.breaksOver.length,
        list(a.breaksOver.map((r) => `${strong(r.name)} ${r.breaks_over_limit}×`)),
        BREAK,
      ),
    a.shortDays.length &&
      section(
        'Short days (under 80% of the shift)',
        a.shortDays.length,
        list(
          a.shortDays.map(
            (r) => `${strong(r.name)} ${duration(r.worked_ms)} of ${duration(r.shift_ms)}`,
          ),
        ),
        NEUTRAL,
      ),
    a.longDays.length &&
      section(
        'Long days (an hour or more over the shift)',
        a.longDays.length,
        list(a.longDays.map((r) => `${strong(r.name)} ${duration(r.worked_ms)}`)),
        NEUTRAL,
      ),
  ]
    .filter(Boolean)
    .join('');

  // Everyone who worked, with work / breaks / idle against the shift.
  const scale = Math.max(
    1,
    ...w.map((r) => Math.max(r.shift_ms, r.worked_ms + r.breaks_ms + r.idle_ms)),
  );
  const people = problemsFirst(w)
    .map((r) => {
      const p = (ms: number): number => (ms / scale) * 100;
      const marker = r.status === 'late' ? ` <span style="color:${WARNING}">&#9679;</span>` : '';
      return `<tr>
  <td style="padding:7px 6px;border-top:1px solid ${LINE};font:13px ${FONT};color:${INK};white-space:nowrap">${esc(r.name)}${marker}</td>
  <td style="padding:7px 6px;border-top:1px solid ${LINE};font:12px ${FONT};color:${INK_2};white-space:nowrap">${at(r, r.clock_in)}–${r.still_in ? 'still in' : at(r, r.clock_out)}</td>
  <td style="padding:7px 6px;border-top:1px solid ${LINE};width:40%">${bar(
    [
      { pct: p(r.worked_ms), color: WORK },
      { pct: p(r.breaks_ms), color: BREAK },
      { pct: p(r.idle_ms), color: IDLE },
    ],
    8,
  )}</td>
  <td align="right" style="padding:7px 6px;border-top:1px solid ${LINE};font:12px ${FONT};color:${INK_2};white-space:nowrap">${duration(r.worked_ms)}${r.shift_ms ? ` / ${duration(r.shift_ms)}` : ''}</td>
</tr>`;
    })
    .join('');
  const kinds = [
    [WORK, 'Worked'],
    [BREAK, 'Breaks'],
    [IDLE, 'Idle'],
  ]
    .map(
      ([color, label]) =>
        `<span style="padding-right:12px"><span style="color:${color}">&#9632;</span> ${label}</span>`,
    )
    .join('');

  const button = `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${WORK};border-radius:8px">
  <a href="${esc(i.reportUrl)}" style="display:inline-block;padding:11px 18px;font:600 14px ${FONT};color:#ffffff;text-decoration:none">Open the interactive report &rarr;</a>
</td></tr></table>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${PAGE}">
<div style="display:none;max-height:0;overflow:hidden">${clockedIn} of ${onShift} clocked in, ${c.late} late, ${c.not_clocked_in} not clocked in.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE}"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
  <tr><td style="padding:0 6px 10px">
    <div style="font:600 12px ${FONT};color:${MUTED};letter-spacing:.04em;text-transform:uppercase">CloudPunch · ${esc(i.who)}</div>
    <div style="font:700 22px/1.3 ${FONT};color:${INK};padding-top:2px">Day summary, ${esc(day)}</div>
  </td></tr>
  <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${tiles.slice(0, 2).join('')}</tr><tr>${tiles.slice(2).join('')}</tr></table></td></tr>
  <tr><td style="padding:12px 6px 4px">${statusBar}
    <div style="font:12px ${FONT};color:${INK_2};padding-top:8px">${legend}</div>${others}
  </td></tr>
  <tr><td style="padding:16px 6px 6px">${button}</td></tr>
  ${attention ? `<tr><td style="padding:14px 6px 0"><div style="font:700 16px ${FONT};color:${INK}">Needs attention</div></td></tr>${attention}` : `<tr><td style="padding:14px 6px;font:14px ${FONT};color:${INK_2}">Nothing needs attention.</td></tr>`}
  ${
    people
      ? `<tr><td style="padding:22px 6px 4px"><div style="font:700 16px ${FONT};color:${INK}">Everyone who worked</div>
    <div style="font:12px ${FONT};color:${INK_2};padding-top:4px">${kinds}<span style="color:${MUTED}">· times on each shift's own clock</span></div></td></tr>
  <tr><td style="padding:0 0 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};border:1px solid ${LINE};border-radius:10px">${people}</table></td></tr>`
      : ''
  }
  <tr><td style="padding:16px 6px;font:12px/1.5 ${FONT};color:${MUTED}">Hours count work, calls and Away. Late means after the shift-start grace. From cloudpunch@aptask.com; Rules → Day-end summary turns it off.</td></tr>
</table>
</td></tr></table>
</body></html>`;

  return {
    subject: `Day summary, ${day}: ${clockedIn}/${onShift} clocked in · ${c.late} late · ${c.not_clocked_in} not clocked in`,
    html,
  };
}
