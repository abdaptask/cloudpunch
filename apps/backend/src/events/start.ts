/**
 * Where a session starts (ADR-0018 §4). Usually the clock-in's
 * `client_ts`; a clock-in from the Windows sign-in time starts at its
 * `started_at` when that is no later than the click and at most 12
 * hours before it. Pure; shared by ingest and the day builder.
 */

/** How far before the click a sign-in start may be. */
export const MAX_START_BACKDATE_MS = 12 * 3_600_000;

/** The bounded `started_at` of a clock-in from sign-in, or null. */
export function startFromSignIn(clicked: Date, payload: Record<string, unknown>): Date | null {
  if (payload['start_source'] !== 'os_sign_in') return null;
  const raw = payload['started_at'];
  if (typeof raw !== 'string') return null;
  const started = new Date(raw);
  const back = clicked.getTime() - started.getTime();
  if (Number.isNaN(back) || back < 0 || back > MAX_START_BACKDATE_MS) return null;
  return started;
}

/** Session start for a clock-in event as it arrives at ingest. */
export function clockInStart(evt: { client_ts: string; payload: Record<string, unknown> }): Date {
  const clicked = new Date(evt.client_ts);
  return startFromSignIn(clicked, evt.payload) ?? clicked;
}
