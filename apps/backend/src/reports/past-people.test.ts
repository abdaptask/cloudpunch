import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryDb } from '../db/in-memory.js';
import { peopleOverRange, rangeRows } from './day.js';

/** ADR-0053 §3: past reports keep the people who worked those days. */

function seed(db: InMemoryDb, name: string): string {
  const id = randomUUID();
  db.seedEmployee({
    id,
    source: 'local_admin',
    greythrEmployeeId: null,
    employeeNumber: null,
    givenName: name,
    familyName: 'Test',
    displayName: `${name} Test`,
    workEmail: `${name.toLowerCase()}@aptask.com`,
    status: 'active',
  });
  return id;
}

describe('reports and deactivated people (ADR-0053 §3)', () => {
  it('kept up to and including the day they left, not after', async () => {
    const db = new InMemoryDb();
    const stays = seed(db, 'Anil');
    const left = seed(db, 'Bina');
    // 23:00 UTC on 4 Nov is 5 Nov in India: their last day is 5 Nov.
    await db.people.deactivate({
      employeeId: left,
      oid: null,
      session: null,
      entra: { outcome: 'none', roles: [] },
      actorUserId: randomUUID(),
      reason: 'Left ApTask',
      correlationId: randomUUID(),
      at: new Date('2026-11-04T23:00:00Z'),
    });

    const before = await peopleOverRange(db, '2026-11-02');
    expect(before.map((p) => p.id)).toEqual([stays, left]);
    expect(before[1]?.lastActiveDate).toBe('2026-11-05');
    expect((await peopleOverRange(db, '2026-11-06')).map((p) => p.id)).toEqual([stays]);

    const rows = await rangeRows(
      db,
      before,
      '2026-11-03',
      '2026-11-07',
      new Date('2026-11-10T06:00:00Z'),
    );
    expect(rows.filter((r) => r.employee_id === stays).map((r) => r.date)).toEqual([
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
    ]);
    expect(rows.filter((r) => r.employee_id === left).map((r) => r.date)).toEqual([
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
    ]);
  });
});
