import { describe, expect, it } from 'vitest';
import { MAX_START_BACKDATE_MS, clockInStart, startFromSignIn } from './start.js';

describe('clock-in from the Windows sign-in time (ADR-0018 §4)', () => {
  const clicked = new Date('2026-09-28T12:35:00.000Z');
  const payload = (startedAt: string): Record<string, unknown> => ({
    start_source: 'os_sign_in',
    started_at: startedAt,
  });

  it('starts at the sign-in time within 12 hours before the click', () => {
    expect(startFromSignIn(clicked, payload('2026-09-28T12:05:00.000Z'))?.toISOString()).toBe(
      '2026-09-28T12:05:00.000Z',
    );
    const edge = new Date(clicked.getTime() - MAX_START_BACKDATE_MS).toISOString();
    expect(startFromSignIn(clicked, payload(edge))?.toISOString()).toBe(edge);
  });

  it('ignores anything else: later than the click, too early, malformed, or no source', () => {
    expect(startFromSignIn(clicked, payload('2026-09-28T12:36:00.000Z'))).toBeNull();
    const tooEarly = new Date(clicked.getTime() - MAX_START_BACKDATE_MS - 1).toISOString();
    expect(startFromSignIn(clicked, payload(tooEarly))).toBeNull();
    expect(startFromSignIn(clicked, payload('yesterday'))).toBeNull();
    expect(startFromSignIn(clicked, { started_at: '2026-09-28T12:05:00.000Z' })).toBeNull();
    expect(startFromSignIn(clicked, { start_source: 'os_sign_in' })).toBeNull();
  });

  it('clockInStart falls back to the click', () => {
    expect(clockInStart({ client_ts: clicked.toISOString(), payload: {} }).toISOString()).toBe(
      clicked.toISOString(),
    );
  });
});
