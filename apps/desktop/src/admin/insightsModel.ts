import type { DayMark, InsightItem, InsightKind, Overview } from '../api.js';

/**
 * Reports → Insights and Trends (ADR-0047 §4), pure: the strip's marks,
 * filters, the summary line, time words, and the period comparison.
 *
 * Colours follow the dataviz method: the reserved status palette for
 * day outcomes (good / warning / serious / critical), never alone (a
 * glyph and a legend label go with each), and a neutral for days that
 * don't count. Status colours are mode-invariant; the neutral and the
 * "worked, no shift" blue have a dark step.
 */

export interface MarkStyle {
  label: string;
  /** Shown in the square, so colour is never alone. */
  glyph: string;
  light: string;
  dark: string;
  /** Glyph colour on the square. */
  ink: string;
}

const GOOD = '#0ca30c';
const WARNING = '#fab219';
const SERIOUS = '#ec835a';
const CRITICAL = '#d03b3b';

export const MARKS: Record<DayMark, MarkStyle> = {
  on_time: { label: 'On time', glyph: '', light: GOOD, dark: GOOD, ink: '#ffffff' },
  late: { label: 'Late', glyph: '!', light: WARNING, dark: WARNING, ink: '#0b0b0b' },
  missed: { label: 'No clock-in', glyph: '×', light: CRITICAL, dark: CRITICAL, ink: '#ffffff' },
  short: { label: 'Short day', glyph: '–', light: SERIOUS, dark: SERIOUS, ink: '#0b0b0b' },
  worked: {
    label: 'Worked, no shift',
    glyph: '',
    light: '#2a78d6',
    dark: '#3987e5',
    ink: '#ffffff',
  },
  off: { label: 'Off', glyph: '', light: '#e1e0d9', dark: '#2c2c2a', ink: '#52514e' },
  office: { label: 'In office', glyph: 'O', light: '#c3c2b7', dark: '#52514e', ink: '#0b0b0b' },
  holiday: { label: 'Holiday', glyph: 'H', light: '#c3c2b7', dark: '#52514e', ink: '#0b0b0b' },
  not_working: {
    label: 'Not working',
    glyph: 'N',
    light: '#c3c2b7',
    dark: '#52514e',
    ink: '#0b0b0b',
  },
};

export const LEGEND_ORDER: readonly DayMark[] = [
  'on_time',
  'late',
  'missed',
  'short',
  'worked',
  'off',
  'office',
  'holiday',
  'not_working',
];

export const KIND_LABEL: Record<InsightKind, string> = {
  late_starts: 'Late starts',
  missed_starts: 'Missed starts',
  short_days: 'Short days',
  long_idle: 'Long idle',
  breaks_over: 'Breaks over limit',
  forgets_clock_out: 'Not clocked out',
  long_days: 'Long days',
};

export const SEVERITY_ORDER = ['serious', 'warning', 'info'] as const;
export const SEVERITY_LABEL: Record<InsightItem['severity'], string> = {
  serious: 'Serious',
  warning: 'Needs a look',
  info: 'Worth knowing',
};

export type View = 'open' | 'serious' | 'no_change' | 'nudged' | 'due';

export const VIEW_LABEL: Record<View, string> = {
  open: 'All open',
  serious: 'Serious',
  no_change: 'No change after nudge',
  nudged: 'Nudged',
  due: 'Follow-up due',
};

export interface InsightFilter {
  view: View;
  kind: InsightKind | '';
  manager: string;
  q: string;
}

export const NO_FILTER: InsightFilter = { view: 'open', kind: '', manager: '', q: '' };

/** Follow-up due on or before `today`. */
const due = (i: InsightItem, today: string): boolean =>
  i.status === 'nudged' && !!i.follow_up_on && i.follow_up_on <= today;

export function matchesView(i: InsightItem, view: View, today: string): boolean {
  switch (view) {
    case 'open':
      return true;
    case 'serious':
      return i.severity === 'serious';
    case 'no_change':
      return i.no_change;
    case 'nudged':
      return i.status === 'nudged';
    case 'due':
      return due(i, today);
  }
}

export function applyFilter(
  items: readonly InsightItem[],
  f: InsightFilter,
  today: string,
): InsightItem[] {
  const q = f.q.trim().toLowerCase();
  return items.filter(
    (i) =>
      matchesView(i, f.view, today) &&
      (!f.kind || i.kind === f.kind) &&
      (!f.manager || (i.manager_name ?? 'No manager') === f.manager) &&
      (!q ||
        i.name.toLowerCase().includes(q) ||
        (i.manager_name ?? '').toLowerCase().includes(q) ||
        i.headline.toLowerCase().includes(q)),
  );
}

/** Serious first, then the "no change" ones, then the longest open. */
export function grouped(items: readonly InsightItem[]): [InsightItem['severity'], InsightItem[]][] {
  return SEVERITY_ORDER.map(
    (s) =>
      [
        s,
        items
          .filter((i) => i.severity === s)
          .sort(
            (a, b) =>
              Number(b.no_change) - Number(a.no_change) ||
              a.opened_at.localeCompare(b.opened_at) ||
              a.name.localeCompare(b.name),
          ),
      ] as [InsightItem['severity'], InsightItem[]],
  ).filter(([, list]) => list.length > 0);
}

/** "12 open · 3 no change after nudge · 5 nudged, 2 follow-ups due". */
export function summaryLine(items: readonly InsightItem[], today: string): string {
  if (items.length === 0) return 'Nothing needs attention.';
  const open = items.filter((i) => i.status === 'open').length;
  const noChange = items.filter((i) => i.no_change).length;
  const nudged = items.filter((i) => i.status === 'nudged').length;
  const dueN = items.filter((i) => due(i, today)).length;
  return [
    `${open} open`,
    noChange > 0 && `${noChange} no change after nudge`,
    nudged > 0 &&
      `${nudged} nudged${dueN > 0 ? `, ${dueN} follow-up${dueN === 1 ? '' : 's'} due` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "just now", "5 min ago", "3 hours ago", "2 days ago". */
export function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** "28 Oct" for a `YYYY-MM-DD`. */
export function dayText(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const ACTION_WORD: Record<string, string> = {
  opened: 'Found',
  updated: 'Updated',
  nudged: 'Nudged',
  explained: 'They added context',
  dismissed: 'Dismissed',
  resolved: 'Resolved',
  reopened: 'Reopened',
};

/** The card's last-step line: "Nudged by Abdulla Sheikh 2 days ago · follow-up 28 Oct". */
export function lastStep(i: InsightItem, now: number): string {
  const l = i.last;
  const step = l
    ? `${ACTION_WORD[l.action] ?? l.action}${l.by ? ` by ${l.by}` : ''} ${ago(l.at, now)}`
    : `Found ${ago(i.opened_at, now)}`;
  const follow =
    i.status === 'nudged' && i.follow_up_on ? ` · follow-up ${dayText(i.follow_up_on)}` : '';
  return `${step}${follow}`;
}

export const actionWord = (action: string): string => ACTION_WORD[action] ?? action;

// Trends (ADR-0047 §4): this period against the one before it.

/** The period of the same length just before [from, to]. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const DAY = 86_400_000;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  const len = Math.round((b - a) / DAY) + 1;
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(a - len * DAY), to: iso(a - DAY) };
}

export interface Delta {
  /** "up 6", "down 2", "no change", "" when there is nothing to compare. */
  text: string;
  /** Whether the change is good, bad or neither for this measure. */
  tone: 'good' | 'bad' | 'neutral';
}

/**
 * The change from `prev` to `cur`. `higherIsBetter` says which way is
 * good (attendance up is good, late starts up is bad). `percent` for
 * shares (0–1), compared in points.
 */
export function delta(
  cur: number | null,
  prev: number | null,
  higherIsBetter: boolean,
  percent = false,
): Delta {
  if (cur === null || prev === null) return { text: '', tone: 'neutral' };
  const d = percent ? Math.round((cur - prev) * 100) : Math.round(cur - prev);
  if (d === 0) return { text: 'no change', tone: 'neutral' };
  const unit = percent ? ' pts' : '';
  return {
    text: `${d > 0 ? 'up' : 'down'} ${Math.abs(d)}${unit}`,
    tone: d > 0 === higherIsBetter ? 'good' : 'bad',
  };
}

export interface TeamRow {
  team: string;
  people: number;
  late: number;
  missed: number;
  shiftDays: number;
  shiftDaysWorked: number;
  attendance: number | null;
}

/** Per manager ("team"), from the overview's people and who reports to whom. */
export function byTeam(o: Overview, managerOf: ReadonlyMap<string, string | null>): TeamRow[] {
  const rows = new Map<string, TeamRow>();
  for (const p of o.people) {
    const team = managerOf.get(p.employee_id) ?? 'No manager';
    const r = rows.get(team) ?? {
      team,
      people: 0,
      late: 0,
      missed: 0,
      shiftDays: 0,
      shiftDaysWorked: 0,
      attendance: null,
    };
    r.people++;
    r.late += p.late_starts;
    r.missed += p.missed_starts;
    r.shiftDays += p.shift_days;
    r.shiftDaysWorked += p.shift_days_worked;
    rows.set(team, r);
  }
  return [...rows.values()]
    .map((r) => ({ ...r, attendance: r.shiftDays > 0 ? r.shiftDaysWorked / r.shiftDays : null }))
    .sort((a, b) => b.late + b.missed - (a.late + a.missed) || a.team.localeCompare(b.team));
}
