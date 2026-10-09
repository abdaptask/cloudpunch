import type { ShiftAlertKind } from '../db/index.js';
import type { ShiftWindow } from '../shifts/model.js';

/**
 * ADR-0037 §3, pure: which shift-start emails are due for one person in
 * the shift window they're in now.
 *
 * - A holiday: none.
 * - "Not working today": that email, and never a missed clock-in.
 * - No clock-in `graceMinutes` after the start: missed clock-in.
 * - A clock-in after a missed clock-in email: the late clock-in email.
 *
 * Each goes once per shift; `sent` holds the kinds already sent.
 */
export interface ShiftState {
  window: ShiftWindow;
  holiday: boolean;
  saidNotWorking: boolean;
  /** The first clock-in that touches the window, if any. */
  firstClockIn: Date | null;
  sent: ReadonlySet<ShiftAlertKind>;
}

export function dueAlerts(s: ShiftState, now: Date, graceMinutes: number): ShiftAlertKind[] {
  if (s.holiday) return [];
  const out: ShiftAlertKind[] = [];
  if (s.saidNotWorking) {
    if (!s.sent.has('not_working')) out.push('not_working');
    return out;
  }
  const graceOver = now.getTime() >= s.window.start.getTime() + graceMinutes * 60_000;
  if (!s.firstClockIn && graceOver && !s.sent.has('missed')) out.push('missed');
  if (s.firstClockIn && s.sent.has('missed') && !s.sent.has('late_clock_in')) {
    out.push('late_clock_in');
  }
  return out;
}

/** Whether the clock-in is still unknown and matters (so the job looks it up). */
export function needsClockIn(s: Omit<ShiftState, 'firstClockIn'>, now: Date, graceMinutes: number) {
  if (s.holiday || s.saidNotWorking) return false;
  if (s.sent.has('missed')) return !s.sent.has('late_clock_in');
  return now.getTime() >= s.window.start.getTime() + graceMinutes * 60_000;
}

/** The first clock-in among sessions that touch the window. */
export function firstClockInFor(
  window: ShiftWindow,
  sessions: readonly { clockIn: Date; end: Date }[],
): Date | null {
  let first: Date | null = null;
  for (const s of sessions) {
    if (s.clockIn < window.end && s.end > window.start && (!first || s.clockIn < first)) {
      first = s.clockIn;
    }
  }
  return first;
}
