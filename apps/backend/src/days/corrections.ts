import type { CorrectionWithDecisions } from '../db/index.js';
import type { BuiltSession, DaySegment, SegmentKind } from './build.js';

/**
 * Time corrections laid over the derived day (ADR-0030 §4). Pure.
 *
 * - Only approved corrections change anything; the later-approved one
 *   wins where two overlap.
 * - Inside a session the correction's kind replaces whatever was there.
 *   `not_worked` removes the time (a gap), so every app version, old or
 *   new, reads only kinds it already knows.
 * - Outside every session it adds a session of its own (`corrected`):
 *   that is how a day the app never recorded gets its hours.
 */

/** What a correction may say the time was (ADR-0030 §1). */
export const CORRECTION_KINDS = [
  'working',
  'away_working',
  'bio_break',
  'meal_break',
  'rest_break',
  'personal_break',
  'other_break',
  'not_worked',
] as const;

export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export function isCorrectionKind(k: string): k is CorrectionKind {
  return (CORRECTION_KINDS as readonly string[]).includes(k);
}

export type CorrectionStatus = 'requested' | 'endorsed' | 'approved' | 'rejected' | 'withdrawn';

/** Derived from the decisions (ADR-0030 §2): a final one wins, else endorsed, else requested. */
export function correctionStatus(c: CorrectionWithDecisions): CorrectionStatus {
  const final = c.decisions.find(
    (d) => d.decision === 'approved' || d.decision === 'rejected' || d.decision === 'withdrawn',
  );
  if (final) return final.decision;
  return c.decisions.some((d) => d.decision === 'endorsed') ? 'endorsed' : 'requested';
}

/** The approved ones, in the order they were approved (later wins). */
export function approvedInOrder(cs: readonly CorrectionWithDecisions[]): CorrectionWithDecisions[] {
  const approvedAt = (c: CorrectionWithDecisions): number =>
    c.decisions.find((d) => d.decision === 'approved')?.decidedAt.getTime() ?? 0;
  return cs
    .filter((c) => correctionStatus(c) === 'approved' && isCorrectionKind(c.kind))
    .sort((a, b) => approvedAt(a) - approvedAt(b));
}

/** `segments` with [a, b) given over to `c` (removed for `not_worked`). */
function replaceRange(
  segments: readonly DaySegment[],
  a: number,
  b: number,
  c: CorrectionWithDecisions,
  offsetMinutes: number,
): DaySegment[] {
  const out: DaySegment[] = [];
  for (const seg of segments) {
    const s = seg.startedAt.getTime();
    const e = seg.endedAt.getTime();
    if (e <= a || s >= b) {
      out.push(seg);
      continue;
    }
    if (s < a) out.push({ ...seg, endedAt: new Date(a) });
    if (e > b) out.push({ ...seg, startedAt: new Date(b) });
  }
  if (c.kind !== 'not_worked') {
    out.push({
      kind: c.kind as SegmentKind,
      startedAt: new Date(a),
      endedAt: new Date(b),
      offsetMinutes,
      correctionId: c.id,
    });
  }
  return out.sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime());
}

/** Parts of [from, to) that no interval covers. */
function uncovered(from: number, to: number, intervals: [number, number][]): [number, number][] {
  const sorted = [...intervals].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let at = from;
  for (const [s, e] of sorted) {
    if (e <= at) continue;
    if (s >= to) break;
    if (s > at) out.push([at, s]);
    at = Math.max(at, e);
    if (at >= to) break;
  }
  if (at < to) out.push([at, to]);
  return out;
}

/** A session made only of a correction (no device recorded it). */
function correctedSession(
  c: CorrectionWithDecisions,
  a: number,
  b: number,
  piece: number,
): BuiltSession {
  const start = new Date(a);
  const end = new Date(b);
  return {
    session: {
      id: piece === 0 ? c.id : `${c.id}:${piece}`,
      employeeId: c.employeeId,
      deviceId: '',
      openedAt: start,
      closedAt: end,
      closedReason: null,
      reconstructed: false,
    },
    tzIana: c.tzIana,
    offsetMinutes: c.utcOffsetMinutes,
    clockIn: start,
    startedFromSignIn: false,
    end,
    open: false,
    corrected: true,
    segments: [
      {
        kind: c.kind as SegmentKind,
        startedAt: start,
        endedAt: end,
        offsetMinutes: c.utcOffsetMinutes,
        correctionId: c.id,
      },
    ],
  };
}

/** `sessions` with every approved correction laid over them, in approval order. */
export function applyCorrections(
  sessions: readonly BuiltSession[],
  corrections: readonly CorrectionWithDecisions[],
): BuiltSession[] {
  let out = sessions.map((s) => ({ ...s, segments: [...s.segments] }));
  for (const c of approvedInOrder(corrections)) {
    const from = c.fromAt.getTime();
    const to = c.toAt.getTime();
    out = out.map((s) => {
      const a = Math.max(from, s.clockIn.getTime());
      const b = Math.min(to, s.end.getTime());
      if (a >= b) return s;
      const offset = s.segments.find((g) => g.endedAt.getTime() > a)?.offsetMinutes;
      return { ...s, segments: replaceRange(s.segments, a, b, c, offset ?? s.offsetMinutes) };
    });
    if (c.kind === 'not_worked') continue;
    const covered = out.map((s): [number, number] => [s.clockIn.getTime(), s.end.getTime()]);
    uncovered(from, to, covered).forEach(([a, b], i) => out.push(correctedSession(c, a, b, i)));
  }
  return out;
}
