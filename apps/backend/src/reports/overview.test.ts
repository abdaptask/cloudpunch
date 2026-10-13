import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryDb } from '../db/in-memory.js';
import type { DayRow, DayStatus } from './day.js';
import { compareVersions, health, overviewCsv, summarise, weekOf } from './overview.js';
import { rangeProblem } from './routes.js';

const H = 3_600_000;

function row(name: string, date: string, status: DayStatus, over: Partial<DayRow> = {}): DayRow {
  return {
    employee_id: `id-${name}`,
    name,
    manager_id: null,
    date,
    status,
    shift: ['worked', 'late', 'not_clocked_in'].includes(status)
      ? { start: `${date}T03:30:00.000Z`, end: `${date}T12:30:00.000Z` }
      : null,
    tz: 'Asia/Kolkata',
    clock_in: null,
    clock_out: null,
    still_in: false,
    minutes_late: null,
    worked_ms: status === 'worked' || status === 'late' ? 8 * H : 0,
    shift_ms: ['worked', 'late', 'not_clocked_in'].includes(status) ? 9 * H : 0,
    idle_ms: 0,
    breaks_ms: 0,
    breaks_over_limit: 0,
    away_ms: 0,
    corrections_waiting: 0,
    ...over,
  };
}

describe('overview sums (ADR-0040 §3)', () => {
  const rows = [
    row('Roshni', '2026-10-05', 'worked', { idle_ms: 2 * H, breaks_ms: 30 * 60_000 }),
    row('Roshni', '2026-10-06', 'late', { minutes_late: 20 }),
    row('Roshni', '2026-10-07', 'late', { minutes_late: 41, breaks_over_limit: 1 }),
    row('Roshni', '2026-10-08', 'not_clocked_in'),
    row('Roshni', '2026-10-09', 'holiday'),
    row('Roshni', '2026-10-12', 'in_office'),
    row('Farheen', '2026-10-05', 'not_working'),
    row('Farheen', '2026-10-10', 'worked', { shift: null, shift_ms: 0, away_ms: H }),
    row('Farheen', '2026-10-11', 'off'),
  ];

  it('attendance leaves out holidays, office days and "not working"; lateness averages late starts', () => {
    const { people, totals, weeks } = summarise(rows);
    const [farheen, roshni] = people;
    expect(roshni).toMatchObject({
      name: 'Roshni',
      days_worked: 3,
      shift_days: 4,
      shift_days_worked: 3,
      attendance: 0.75,
      worked_ms: 24 * H,
      scheduled_ms: 36 * H,
      late_starts: 2,
      avg_minutes_late: 31,
      missed_starts: 1,
      idle_ms: 2 * H,
      idle_share: 2 / 26,
      break_ms_per_day: 10 * 60_000,
      breaks_over_limit: 1,
    });
    // Worked on a day without a shift: a day worked, not a shift day.
    expect(farheen).toMatchObject({
      days_worked: 1,
      shift_days: 0,
      attendance: null,
      avg_minutes_late: null,
      away_ms: H,
    });
    expect(totals).toMatchObject({ people: 2, days_worked: 4, shift_days: 4, late_starts: 2 });
    expect(weeks).toEqual([
      expect.objectContaining({
        week: '2026-10-05',
        shift_days: 4,
        late_starts: 2,
        missed_starts: 1,
      }),
      expect.objectContaining({ week: '2026-10-12', shift_days: 0 }),
    ]);
    expect(weekOf('2026-10-11')).toBe('2026-10-05');
    expect(weekOf('2026-10-12')).toBe('2026-10-12');
  });

  it('CSV per section: hours as decimals, percentages, and no formulas from names', () => {
    const { people } = summarise([
      ...rows,
      row('=HYPERLINK("x")', '2026-10-05', 'worked'),
      row('Lee, Sam', '2026-10-05', 'worked'),
    ]);
    const csv = overviewCsv(people, 'hours').split('\r\n');
    expect(csv[0]).toBe(
      'Person,Days worked,Shift days,Shift days worked,Attendance %,Hours worked,Hours scheduled',
    );
    expect(csv).toContain('Roshni,3,4,3,75.0,24.00,36.00');
    expect(csv).toContain('"\'=HYPERLINK(""x"")",1,1,1,100.0,8.00,9.00');
    expect(csv).toContain('"Lee, Sam",1,1,1,100.0,8.00,9.00');
    expect(overviewCsv(people, 'lateness').split('\r\n')).toContain('Roshni,2,31,1');
    expect(overviewCsv(people, 'activity').split('\r\n')[0]).toBe(
      'Person,Idle hours,Idle %,Break minutes per day,Breaks over limit,Away hours',
    );
  });

  it('a range of up to 93 days within the last year', () => {
    const now = new Date('2026-10-13T10:00:00Z');
    expect(rangeProblem('2026-07-13', '2026-10-13', now)).toBeNull();
    expect(rangeProblem('2026-07-12', '2026-10-13', now)).toMatch(/at most 93/);
    expect(rangeProblem('2026-10-14', '2026-10-13', now)).toMatch(/from not after to/);
    expect(rangeProblem('2026-10-01', '2026-10-16', now)).toMatch(/after tomorrow/);
    expect(rangeProblem('2025-01-01', '2025-01-31', now)).toMatch(/last 366 days/);
    expect(rangeProblem('2026-02-30', '2026-03-01', now)).not.toBeNull();
  });
});

describe('adoption and health (ADR-0040 §3.4)', () => {
  it('who has the app, who clocked in, versions and how many are behind', async () => {
    const db = new InMemoryDb();
    const now = new Date('2026-10-13T10:00:00Z');
    const people = ['Roshni', 'Farheen', 'Nilesh'].map((name) => {
      const id = randomUUID();
      const e = {
        id,
        source: 'local_admin' as const,
        greythrEmployeeId: null,
        employeeNumber: null,
        givenName: name,
        familyName: 'Test',
        displayName: `${name} Test`,
        workEmail: `${name.toLowerCase()}@aptask.com`,
        status: 'active' as const,
        reportingManagerId: null,
      };
      db.seedEmployee(e);
      return e;
    });
    for (const [i, version] of ['0.1.35', '0.1.9'].entries()) {
      const userId = randomUUID();
      db.seedUser(
        {
          id: userId,
          entraObjectId: randomUUID(),
          workEmail: people[i]?.workEmail ?? '',
          displayName: 'x',
          isServiceAccount: false,
          breakGlass: false,
          employeeId: people[i]?.id ?? null,
        },
        randomUUID(),
      );
      const d = await db.devices.enroll({
        id: randomUUID(),
        userId,
        os: 'windows',
        hostnameHash: 'h',
        publicKeyEd25519: new Uint8Array(32),
        appVersion: version,
      });
      await db.devices.touchLastSeen(d.id, now, version);
    }
    const totals = summarise([
      row('Roshni Test', '2026-10-12', 'worked', { employee_id: people[0]?.id ?? '' }),
      row('Farheen Test', '2026-10-12', 'not_clocked_in', { employee_id: people[1]?.id ?? '' }),
      row('Nilesh Test', '2026-10-12', 'off', { employee_id: people[2]?.id ?? '' }),
    ]).people;
    await db.refusals.note({
      deviceId: 'dev-x',
      employeeId: people[1]?.id ?? '',
      reason: 'clock_ahead',
      events: 3,
      aheadSeconds: 150,
      at: new Date('2026-10-12T10:00:00Z'),
    });
    await db.refusals.note({
      deviceId: 'dev-x',
      employeeId: people[1]?.id ?? '',
      reason: 'clock_ahead',
      events: 2,
      aheadSeconds: 140,
      at: new Date('2026-10-13T09:00:00Z'),
    });
    const h = await health(db, people, totals, now, { from: '2026-10-12', to: '2026-10-13' });
    expect(h).toMatchObject({
      active_people: 3,
      with_app: 2,
      clocked_in: 1,
      never_clocked_in: [{ name: 'Farheen Test' }],
      versions: [
        { version: '0.1.35', computers: 1 },
        { version: '0.1.9', computers: 1 },
      ],
      newest_version: '0.1.35',
      computers_behind: 1,
      corrections_waiting: 0,
      refused: [
        {
          name: 'Farheen Test',
          os: null,
          reason: 'clock_ahead',
          events: 5,
          ahead_seconds: 150,
          last_at: '2026-10-13T09:00:00.000Z',
        },
      ],
    });
    expect(compareVersions('0.1.9', '0.1.10')).toBeLessThan(0);
  });
});
