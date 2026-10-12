import { describe, expect, it } from 'vitest';
import type { ShiftAssignment, ShiftTemplateVersion } from '../db/index.js';
import { shiftOn } from './model.js';
import { resolveRows, templateOn } from './resolve.js';

const T = 'tmpl-india-day';

const row = (over: Partial<ShiftAssignment>): ShiftAssignment => ({
  id: `r-${over.effectiveFrom ?? 'x'}`,
  employeeId: 'e1',
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '18:00',
  tzIana: 'Asia/Kolkata',
  effectiveFrom: '2026-10-01',
  reason: null,
  assignedByUserId: 'u',
  assignedAt: new Date('2026-10-01T00:00:00Z'),
  templateId: null,
  ...over,
});

const version = (over: Partial<ShiftTemplateVersion>): ShiftTemplateVersion => ({
  id: `v-${over.effectiveFrom ?? 'x'}`,
  templateId: T,
  name: 'India day',
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '18:00',
  tzIana: 'Asia/Kolkata',
  retired: false,
  effectiveFrom: '2026-09-01',
  reason: null,
  createdByUserId: 'u',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

const newest = (rs: ShiftAssignment[]) =>
  [...rs].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
const at = (rs: ShiftAssignment[], date: string) => {
  const s = shiftOn(rs, date);
  return s ? `${s.start}–${s.end}` : 'none';
};

describe('named shift resolver (ADR-0038 §6)', () => {
  const v1 = version({ effectiveFrom: '2026-09-01' });
  const v2 = version({
    effectiveFrom: '2026-10-20',
    start: '08:00',
    end: '17:00',
    createdAt: new Date('2026-10-12T00:00:00Z'),
  });

  it('custom rows apply as stored', () => {
    const rows = [row({ start: '10:00', end: '19:00' })];
    expect(resolveRows(rows, [v1, v2])).toEqual(rows);
  });

  it('someone on a named shift follows each version from its date', () => {
    const rows = resolveRows([row({ templateId: T, start: '09:00' })], [v2, v1]);
    expect(rows.map((r) => [r.effectiveFrom, r.start])).toEqual([
      ['2026-10-20', '08:00'],
      ['2026-10-01', '09:00'],
    ]);
    expect(at(rows, '2026-10-15')).toBe('09:00–18:00');
    expect(at(rows, '2026-10-26')).toBe('08:00–17:00');
    expect(at(rows, '2026-09-30')).toBe('none');
  });

  it('a later custom shift (or another named one) ends it', () => {
    const custom = row({
      effectiveFrom: '2026-10-15',
      start: '12:00',
      end: '21:00',
      assignedAt: new Date('2026-10-14T00:00:00Z'),
    });
    const rows = resolveRows(newest([row({ templateId: T }), custom]), [v1, v2]);
    expect(at(rows, '2026-10-10')).toBe('09:00–18:00');
    // v2's change on 20 Oct doesn't reach them: they left on 15 Oct.
    expect(at(rows, '2026-10-26')).toBe('12:00–21:00');
  });

  it('two changes on one date: the later-made version wins', () => {
    const fix = version({
      id: 'v-fix',
      effectiveFrom: '2026-10-20',
      start: '07:30',
      end: '16:30',
      createdAt: new Date('2026-10-13T00:00:00Z'),
    });
    const rows = resolveRows([row({ templateId: T })], [v1, v2, fix]);
    expect(at(rows, '2026-10-21')).toBe('07:30–16:30');
  });

  it("before the named shift's first version, the stored snapshot stands", () => {
    const rows = resolveRows(
      [row({ templateId: T, effectiveFrom: '2026-08-01', start: '09:30', end: '18:30' })],
      [v1],
    );
    expect(at(rows, '2026-08-15')).toBe('09:30–18:30');
    expect(at(rows, '2026-09-02')).toBe('09:00–18:00');
  });

  it('a retired named shift keeps its pattern for those still on it', () => {
    const retired = version({ effectiveFrom: '2026-10-25', retired: true });
    const rows = resolveRows([row({ templateId: T })], [v1, retired]);
    expect(at(rows, '2026-10-27')).toBe('09:00–18:00');
    expect(templateOn([v1, retired], T, '2026-10-27')?.retired).toBe(true);
    expect(templateOn([v1, retired], T, '2026-08-01')).toBeNull();
  });

  it('keeps each person apart', () => {
    const rows = resolveRows(
      [row({ templateId: T }), row({ employeeId: 'e2', start: '11:00', end: '20:00' })],
      [v1, v2],
    );
    expect(
      at(
        rows.filter((r) => r.employeeId === 'e2'),
        '2026-10-26',
      ),
    ).toBe('11:00–20:00');
    expect(
      at(
        rows.filter((r) => r.employeeId === 'e1'),
        '2026-10-26',
      ),
    ).toBe('08:00–17:00');
  });
});
