import { describe, expect, it } from 'vitest';
import {
  asRecordedWallTime,
  dayEnd,
  dayLabel,
  daySegments,
  localDateOf,
  offsetOf,
  recordedElsewhere,
  shiftDate,
  tintFor,
  zoneNote,
  type DayApi,
  type DayApiSession,
} from './dayHistory.js';
import { formatClock } from './timelineModel.js';

function session(over: Partial<DayApiSession>): DayApiSession {
  return {
    session_id: 's',
    device_id: 'here',
    tz_iana: 'Asia/Kolkata',
    clock_in: '2026-09-25T18:30:00.000+05:30',
    clock_out: '2026-09-25T23:30:00.000+05:30',
    close_reason: 'user_clock_out',
    reconstructed: false,
    open: false,
    segments: [],
    ...over,
  };
}

/** The owner's example: 6:30 pm – 3:30 am IST, one working day. */
const nightShift: DayApi = {
  date: '2026-09-25',
  sessions: [
    session({
      segments: [
        {
          kind: 'working',
          started_at: '2026-09-25T18:30:00.000+05:30',
          ended_at: '2026-09-25T21:00:00.000+05:30',
        },
        {
          kind: 'call_teams',
          started_at: '2026-09-25T21:00:00.000+05:30',
          ended_at: '2026-09-25T23:30:00.000+05:30',
        },
      ],
    }),
    session({
      session_id: 't',
      clock_in: '2026-09-26T00:15:00.000+05:30',
      clock_out: '2026-09-26T03:30:00.000+05:30',
      segments: [
        {
          kind: 'working',
          started_at: '2026-09-26T00:15:00.000+05:30',
          ended_at: '2026-09-26T03:30:00.000+05:30',
        },
      ],
    }),
  ],
};

describe('recorded wall time', () => {
  it('reads the recorded clock on this computer, whatever its zone', () => {
    expect(offsetOf('2026-09-25T09:00:00.000-04:00')).toBe(-240);
    expect(offsetOf('2026-09-25T18:30:00.000+05:30')).toBe(330);
    expect(formatClock(asRecordedWallTime('2026-09-25T18:30:00.000+05:30'))).toBe('18:30');
    expect(formatClock(asRecordedWallTime('2026-09-25T09:00:00.000-04:00'))).toBe('09:00');
  });

  it('keeps a night shift in order across midnight, numbered by session', () => {
    const segs = daySegments(nightShift);
    expect(segs.map((s) => [s.kind, formatClock(s.startedAt), s.session])).toEqual([
      ['working', '18:30', 1],
      ['call_teams', '21:00', 1],
      ['working', '00:15', 2],
    ]);
    expect(formatClock(dayEnd(segs)!)).toBe('03:30');
    expect(localDateOf(dayEnd(segs)!)).toBe('2026-09-26');
    expect(dayEnd([])).toBeNull();
  });
});

describe('notes', () => {
  it('mentions the zone only when it differs from this computer', () => {
    expect(zoneNote(nightShift, 330)).toBeNull();
    expect(zoneNote(nightShift, -240)).toBe(
      'Times in Asia/Kolkata (UTC+05:30), where this was recorded',
    );
    const mixed: DayApi = {
      date: '2026-09-25',
      sessions: [
        ...nightShift.sessions,
        session({ tz_iana: 'America/New_York', clock_in: '2026-09-25T09:00:00.000-04:00' }),
      ],
    };
    expect(zoneNote(mixed, 330)).toBe('Times as recorded on each computer');
    expect(zoneNote({ date: '2026-09-25', sessions: [] }, -240)).toBeNull();
  });

  it('flags sessions from another computer', () => {
    expect(recordedElsewhere(nightShift, 'here')).toBe(false);
    expect(recordedElsewhere(nightShift, 'laptop-2')).toBe(true);
    expect(recordedElsewhere(nightShift, null)).toBe(false);
  });
});

describe('dates', () => {
  it('moves by calendar days and labels them', () => {
    expect(shiftDate('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDate('2026-09-25', 7)).toBe('2026-10-02');
    expect(dayLabel('2026-09-25', '2026-09-25')).toBe('Today');
    expect(dayLabel('2026-09-24', '2026-09-25')).toBe('Yesterday');
    expect(dayLabel('2026-09-22', '2026-09-25')).toBe('Tue 22 Sep');
  });
});

describe('tintFor', () => {
  it('green while working (calls and meetings too), amber on a break, grey when out', () => {
    expect(tintFor('active')).toBe('working');
    expect(tintFor('on_call')).toBe('working');
    expect(tintFor('away')).toBe('working');
    expect(tintFor('on_break')).toBe('break');
    expect(tintFor('idle_pending')).toBe('break');
    expect(tintFor('clocked_out')).toBe('off');
  });
});
