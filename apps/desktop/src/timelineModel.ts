/**
 * Pure helpers for the home window's timeline (mirrors
 * `src-tauri/src/timeline.rs`). These are tracked periods on this
 * device for display, not payable hours.
 */

export type SegmentKind =
  | 'working'
  | 'call_teams'
  | 'call_zoom'
  | 'call_other'
  | 'bio_break'
  | 'meal_break'
  | 'other_break'
  | 'away_meeting'
  | 'away_phone'
  | 'away_working'
  | 'prompt';

export interface Segment {
  kind: SegmentKind;
  startedAt: number;
  /** null while the segment is still open. */
  endedAt: number | null;
  /** Clock-in number; segments of one clock-in → clock-out share it. */
  session: number;
}

/** A segment with a definite end (open segments end at "now"). */
export type ClosedSegment = Segment & { endedAt: number };

/**
 * Calls (by kind, ADR-0012), meetings, phone calls and working away
 * all count as working time; they are shown as separate segments
 * while they happen.
 */
export type SegmentGroup = 'working' | 'break' | 'prompt';

export function groupOf(kind: SegmentKind): SegmentGroup {
  switch (kind) {
    case 'working':
    case 'call_teams':
    case 'call_zoom':
    case 'call_other':
    case 'away_meeting':
    case 'away_phone':
    case 'away_working':
      return 'working';
    case 'bio_break':
    case 'meal_break':
    case 'other_break':
      return 'break';
    case 'prompt':
      return 'prompt';
  }
}

export const KIND_LABEL: Record<SegmentKind, string> = {
  working: 'Working',
  call_teams: 'Teams call',
  call_zoom: 'Zoom call',
  call_other: 'Other call',
  bio_break: 'Bio break',
  meal_break: 'Meal break',
  other_break: 'Break',
  away_meeting: 'In a meeting',
  away_phone: 'On a phone call',
  away_working: 'Working away',
  prompt: 'Idle prompt',
};

/** Label for a kind as a line under the Working total. */
export const WORKING_PART_LABEL: Partial<Record<SegmentKind, string>> = {
  working: 'At the computer',
  call_teams: 'Teams calls',
  call_zoom: 'Zoom calls',
  call_other: 'Other calls',
  away_meeting: 'In a meeting',
  away_phone: 'On a phone call',
  away_working: 'Working away',
};

export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Segments overlapping today (local time), clipped to midnight, with
 * open segments ended at `now`.
 */
export function today(segments: readonly Segment[], now: number): ClosedSegment[] {
  const midnight = startOfLocalDay(now);
  return segments
    .map((s): ClosedSegment => ({ ...s, endedAt: s.endedAt ?? now }))
    .filter((s) => s.endedAt > midnight)
    .map((s) => ({ ...s, startedAt: Math.max(s.startedAt, midnight) }))
    .filter((s) => s.endedAt > s.startedAt);
}

export type Totals = Record<SegmentGroup, number>;

export function totals(segments: readonly Segment[], now: number): Totals {
  const out: Totals = { working: 0, break: 0, prompt: 0 };
  for (const s of today(segments, now)) {
    out[groupOf(s.kind)] += s.endedAt - s.startedAt;
  }
  return out;
}

export interface SessionGroup {
  session: number;
  startedAt: number;
  endedAt: number;
  /** True while this session's last segment is still open. */
  open: boolean;
  rows: ClosedSegment[];
}

/** Today's rows grouped by session, oldest first. */
export function sessionsToday(segments: readonly Segment[], now: number): SessionGroup[] {
  const openSession = segments.find((s) => s.endedAt === null)?.session;
  const groups = new Map<number, SessionGroup>();
  for (const row of today(segments, now)) {
    const g = groups.get(row.session);
    if (g) {
      g.rows.push(row);
      g.endedAt = Math.max(g.endedAt, row.endedAt);
    } else {
      groups.set(row.session, {
        session: row.session,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        open: row.session === openSession,
        rows: [row],
      });
    }
  }
  return [...groups.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** Display order for per-kind totals. */
export const KIND_ORDER: readonly SegmentKind[] = [
  'working',
  'call_teams',
  'call_zoom',
  'call_other',
  'away_meeting',
  'away_phone',
  'away_working',
  'bio_break',
  'meal_break',
  'other_break',
  'prompt',
];

/** Today's time per segment kind; kinds with no time are absent. */
export function totalsByKind(
  segments: readonly Segment[],
  now: number,
): Partial<Record<SegmentKind, number>> {
  const out: Partial<Record<SegmentKind, number>> = {};
  for (const s of today(segments, now)) {
    out[s.kind] = (out[s.kind] ?? 0) + (s.endedAt - s.startedAt);
  }
  return out;
}

/** Exact to the second: "42s", "12m 04s", "1h 05m 12s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** "03:42:17". */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** Local "HH:MM", 24-hour. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
