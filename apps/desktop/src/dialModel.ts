import type { Segment, SegmentKind } from './timelineModel.js';

/**
 * Geometry for the day dial: today's segments drawn on a 12-hour clock
 * face at their real times. Pure, so it's unit-tested apart from the SVG.
 *
 * The dial shows the last 12 hours ending now. On a 12-hour face that
 * window is exactly one turn, so arcs never overlap; anything older is
 * clipped at the 12-hour mark.
 */

export const WINDOW_MS = 12 * 3_600_000;

/** Degrees clockwise from 12 o'clock for a wall-clock time (local). */
export function clockAngle(ms: number): number {
  const d = new Date(ms);
  const minutes = (d.getHours() % 12) * 60 + d.getMinutes() + d.getSeconds() / 60;
  return (minutes / 720) * 360;
}

export interface DialArc {
  kind: SegmentKind;
  /** Degrees clockwise from 12 o'clock. */
  from: number;
  /** Arc length in degrees (0 < sweep ≤ 360). */
  sweep: number;
  /** The segment still running (drawn up to now). */
  open: boolean;
}

/** Arcs shorter than this still show as a sliver. */
const MIN_SWEEP = 1.2;

export function dialArcs(segments: readonly Segment[], now: number): DialArc[] {
  const windowStart = now - WINDOW_MS;
  const out: DialArc[] = [];
  for (const s of segments) {
    const end = s.endedAt ?? now;
    const start = Math.max(s.startedAt, windowStart);
    if (end <= start) continue;
    const sweep = Math.min(360, ((end - start) / WINDOW_MS) * 360);
    out.push({
      kind: s.kind,
      from: clockAngle(start),
      sweep: Math.max(MIN_SWEEP, sweep),
      open: s.endedAt === null,
    });
  }
  return out;
}

/** A point on a circle at `angle` degrees clockwise from 12 o'clock. */
export function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  const rad = ((angle - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** SVG path for an arc of radius `r` from `from` for `sweep` degrees. */
export function arcPath(cx: number, cy: number, r: number, from: number, sweep: number): string {
  // A full circle can't be one arc command; stop a hair short.
  const s = Math.min(sweep, 359.99);
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, from + s);
  const large = s > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** Rev-counter ring: one LED per 15 minutes worked, 12 hours round. */
export const LED_COUNT = 48;
const LED_MS = 15 * 60_000;

/** How many LEDs are lit for `workedMs` (0 … LED_COUNT). */
export function ledsLit(workedMs: number): number {
  if (!Number.isFinite(workedMs) || workedMs <= 0) return 0;
  return Math.min(LED_COUNT, Math.floor(workedMs / LED_MS));
}

/** LED `i`'s band: normal up to 8h, over from 8h, red from 10h. */
export function ledBand(i: number): 'normal' | 'over' | 'red' {
  if (i < 32) return 'normal';
  if (i < 40) return 'over';
  return 'red';
}
