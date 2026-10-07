import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryDb, type CorrectionWithDecisions } from '../db/index.js';
import { totals, workingDays, type BuiltSession } from './build.js';
import { applyCorrections, correctionStatus } from './corrections.js';
import { daySummaries, dayView } from './service.js';

const IST = 330;
const t = (iso: string): Date => new Date(iso);
const H = 3_600_000;

function correction(
  over: Partial<CorrectionWithDecisions> & { approvedAt?: string; status?: string } = {},
): CorrectionWithDecisions {
  const id = over.id ?? randomUUID();
  const status = over.status ?? 'approved';
  const decisions: CorrectionWithDecisions['decisions'] = [];
  const decide = (decision: 'endorsed' | 'approved' | 'rejected', at: string) =>
    decisions.push({
      id: randomUUID(),
      correctionId: id,
      decision,
      decidedByUserId: 'u',
      decidedAt: t(at),
      note: null,
    });
  if (status !== 'requested') decide('endorsed', '2026-10-07T10:00:00Z');
  if (status === 'approved') decide('approved', over.approvedAt ?? '2026-10-07T11:00:00Z');
  if (status === 'rejected') decide('rejected', '2026-10-07T11:00:00Z');
  return {
    id,
    employeeId: 'emp',
    fromAt: t('2026-10-05T12:00:00Z'),
    toAt: t('2026-10-05T20:00:00Z'),
    tzIana: 'Asia/Kolkata',
    utcOffsetMinutes: IST,
    kind: 'working',
    reason: 'not recorded',
    requestedByUserId: 'u',
    requestedAt: t('2026-10-07T09:00:00Z'),
    ...over,
    decisions: over.decisions ?? decisions,
  };
}

/** A recorded session: working 12:00–14:00 then idle 14:00–15:00 (UTC). */
function session(): BuiltSession {
  const start = t('2026-10-06T12:00:00Z');
  const end = t('2026-10-06T15:00:00Z');
  return {
    session: {
      id: 's1',
      employeeId: 'emp',
      deviceId: 'dev',
      openedAt: start,
      closedAt: end,
      closedReason: 'user_clock_out',
      reconstructed: false,
    },
    tzIana: 'Asia/Kolkata',
    offsetMinutes: IST,
    clockIn: start,
    startedFromSignIn: false,
    end,
    open: false,
    segments: [
      { kind: 'working', startedAt: start, endedAt: t('2026-10-06T14:00:00Z'), offsetMinutes: IST },
      { kind: 'idle', startedAt: t('2026-10-06T14:00:00Z'), endedAt: end, offsetMinutes: IST },
    ],
  };
}

describe('correctionStatus', () => {
  it('a final decision wins, else endorsed, else requested', () => {
    expect(correctionStatus(correction({ status: 'requested' }))).toBe('requested');
    expect(correctionStatus(correction({ status: 'endorsed' }))).toBe('endorsed');
    expect(correctionStatus(correction())).toBe('approved');
    expect(correctionStatus(correction({ status: 'rejected' }))).toBe('rejected');
  });
});

describe('applyCorrections (ADR-0030 §4)', () => {
  it('a day nobody recorded gets its hours as a corrected session', () => {
    const out = applyCorrections([], [correction()]);
    expect(out).toHaveLength(1);
    expect(out[0]?.corrected).toBe(true);
    expect(out[0]?.segments.map((s) => [s.kind, s.correctionId !== undefined])).toEqual([
      ['working', true],
    ]);
    const [day] = workingDays(out);
    expect(day?.date).toBe('2026-10-05');
    expect(totals(day ?? null).worked_ms).toBe(8 * H);
  });

  it('only approved corrections count', () => {
    for (const status of ['requested', 'endorsed', 'rejected']) {
      expect(applyCorrections([], [correction({ status })])).toEqual([]);
    }
  });

  it('inside a session the kind replaces what was there; outside it adds time', () => {
    const c = correction({
      fromAt: t('2026-10-06T11:00:00Z'),
      toAt: t('2026-10-06T15:00:00Z'),
    });
    const out = applyCorrections([session()], [c]);
    const recorded = out.find((s) => !s.corrected);
    expect(recorded?.segments.map((s) => [s.kind, s.startedAt.toISOString()])).toEqual([
      ['working', '2026-10-06T12:00:00.000Z'],
    ]);
    const added = out.find((s) => s.corrected);
    expect([added?.clockIn.toISOString(), added?.end.toISOString()]).toEqual([
      '2026-10-06T11:00:00.000Z',
      '2026-10-06T12:00:00.000Z',
    ]);
    const [day] = workingDays(out);
    expect(totals(day ?? null)).toMatchObject({ worked_ms: 4 * H, idle_ms: 0 });
  });

  it('not_worked removes the time and adds nothing outside sessions', () => {
    const c = correction({
      kind: 'not_worked',
      fromAt: t('2026-10-06T13:00:00Z'),
      toAt: t('2026-10-06T16:00:00Z'),
    });
    const out = applyCorrections([session()], [c]);
    expect(out).toHaveLength(1);
    expect(out[0]?.segments.map((s) => [s.kind, s.endedAt.toISOString()])).toEqual([
      ['working', '2026-10-06T13:00:00.000Z'],
    ]);
    expect(totals(workingDays(out)[0] ?? null).worked_ms).toBe(H);
  });

  it('where two overlap, the later-approved one wins', () => {
    const first = correction({ kind: 'meal_break', approvedAt: '2026-10-07T12:00:00Z' });
    const second = correction({
      kind: 'working',
      fromAt: t('2026-10-05T14:00:00Z'),
      toAt: t('2026-10-05T15:00:00Z'),
      approvedAt: '2026-10-07T13:00:00Z',
    });
    // Order given doesn't matter; approval order does.
    const out = applyCorrections([], [second, first]);
    const segs = out
      .flatMap((s) => s.segments)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map((s) => [s.kind, s.startedAt.toISOString()]);
    expect(segs).toEqual([
      ['meal_break', '2026-10-05T12:00:00.000Z'],
      ['working', '2026-10-05T14:00:00.000Z'],
      ['meal_break', '2026-10-05T15:00:00.000Z'],
    ]);
  });
});

describe('day views count approved corrections', () => {
  it("Roshni's case: a day with no sessions shows the corrected hours, and the request", async () => {
    const db = new InMemoryDb();
    const at = t('2026-10-07T09:00:00Z');
    const base = {
      employeeId: 'emp',
      tzIana: 'Asia/Kolkata',
      utcOffsetMinutes: IST,
      kind: 'working',
      reason: 'App did not record the day',
      requestedByUserId: 'mgr',
      endorse: true,
      correlationId: randomUUID(),
      at,
    };
    const approved = await db.corrections.request({
      ...base,
      fromAt: t('2026-10-05T12:00:00Z'),
      toAt: t('2026-10-05T20:00:00Z'),
    });
    await db.corrections.decide({
      correctionId: approved.id,
      employeeId: 'emp',
      decision: 'approved',
      decidedByUserId: 'admin',
      note: null,
      correlationId: randomUUID(),
      at,
    });
    // Waiting for approval: listed, not counted.
    await db.corrections.request({
      ...base,
      fromAt: t('2026-10-06T12:00:00Z'),
      toAt: t('2026-10-06T13:00:00Z'),
    });
    const now = t('2026-10-07T12:00:00Z');

    const day5 = await dayView(db, 'emp', '2026-10-05', now);
    expect(day5.totals.worked_ms).toBe(8 * H);
    expect(day5.sessions).toHaveLength(1);
    expect(day5.sessions[0]).toMatchObject({
      corrected: true,
      close_reason: 'corrected',
      clock_in: '2026-10-05T17:30:00.000+05:30',
    });
    expect(day5.sessions[0]?.segments[0]?.correction_id).toBe(approved.id);
    expect(day5.corrections.map((c) => c.status)).toEqual(['approved']);

    const day6 = await dayView(db, 'emp', '2026-10-06', now);
    expect(day6.totals.worked_ms).toBe(0);
    expect(day6.corrections.map((c) => [c.status, c.from])).toEqual([
      ['endorsed', '2026-10-06T17:30:00.000+05:30'],
    ]);

    const sums = await daySummaries(db, 'emp', '2026-10-04', '2026-10-07', now);
    expect(sums.map((d) => [d.date, d.worked_ms])).toEqual([['2026-10-05', 8 * H]]);
  });
});
