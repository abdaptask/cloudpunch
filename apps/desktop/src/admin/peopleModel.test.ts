import { describe, expect, it } from 'vitest';
import type { EmployeeRow, Person, ShiftRow } from '../api.js';
import {
  NO_FILTER,
  managerPlan,
  namesText,
  rolePlan,
  welcomePlan,
  PAGE_SIZE,
  applyFilter,
  attention,
  buildRows,
  managerChoices,
  pageOf,
  sortRows,
  statusOf,
} from './peopleModel.js';

const DAY = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', tz_iana: 'Asia/Kolkata' };

const people: Person[] = [
  { oid: 'o-priya', name: 'Priya Shah', roles: ['Manager', 'Employee'], has_employee_record: true },
  { oid: 'o-roshni', name: 'Roshni Sahani', roles: ['Employee'], has_employee_record: true },
  { oid: 'o-nilesh', name: 'Nilesh D', roles: ['Employee'], has_employee_record: true },
  { oid: 'o-new', name: 'New Person', roles: ['Employee'], has_employee_record: false },
];
const employees: EmployeeRow[] = [
  {
    id: 'e-priya',
    name: 'Priya Shah',
    email: 'priya@aptask.com',
    reporting_manager_id: null,
    oid: 'o-priya',
  },
  {
    id: 'e-roshni',
    name: 'Roshni Sahani',
    email: 'roshni@aptask.com',
    reporting_manager_id: 'e-priya',
    oid: 'o-roshni',
  },
  // Reports to Roshni, who has no Manager role.
  {
    id: 'e-nilesh',
    name: 'Nilesh D',
    email: 'nilesh@aptask.com',
    reporting_manager_id: 'e-roshni',
    oid: 'o-nilesh',
  },
  // A record whose roles are gone.
  { id: 'e-old', name: 'Old Hand', email: null, reporting_manager_id: 'e-priya', oid: 'o-old' },
];
const shifts: ShiftRow[] = [
  { employee_id: 'e-priya', name: 'Priya Shah', shift: DAY },
  { employee_id: 'e-roshni', name: 'Roshni Sahani', shift: null },
  { employee_id: 'e-nilesh', name: 'Nilesh D', shift: DAY },
  { employee_id: 'e-old', name: 'Old Hand', shift: DAY },
];

describe('People table model (ADR-0038 §3)', () => {
  it('joins roles, records and shifts, with roleless records kept', () => {
    const rows = buildRows(people, employees, shifts);
    expect(rows.map((r) => [r.name, r.employeeId, r.managerName, r.shift === DAY])).toEqual([
      ['New Person', null, null, false],
      ['Nilesh D', 'e-nilesh', 'Roshni Sahani', true],
      ['Old Hand', 'e-old', 'Priya Shah', true],
      ['Priya Shah', 'e-priya', null, true],
      ['Roshni Sahani', 'e-roshni', 'Priya Shah', false],
    ]);
    expect(rows.find((r) => r.name === 'Old Hand')?.roles).toEqual([]);
  });

  it('shift is unknown (not "none") when shifts were refused', () => {
    const rows = buildRows(people, employees, null);
    expect(rows.every((r) => r.shift === undefined)).toBe(true);
    expect(attention(rows).noShift).toBe(0);
  });

  it('counts what needs attention', () => {
    const rows = buildRows(people, employees, shifts);
    expect(attention(rows)).toEqual({ noManager: 1, noShift: 1, managerNoRole: 1, noRole: 1 });
    const status = (name: string): string[] =>
      statusOf(
        rows.find((r) => r.name === name)!,
        rows,
      );
    expect(status('Roshni Sahani')).toEqual(['No shift', 'Needs Manager role']);
    expect(status('Priya Shah')).toEqual(['No manager']);
    expect(status('Old Hand')).toEqual(['No role']);
    expect(status('New Person')).toEqual(['No record']);
    expect(status('Nilesh D')).toEqual([]);
  });

  it('filters by text, role, manager and flag', () => {
    const rows = buildRows(people, employees, shifts);
    const names = (f: Partial<typeof NO_FILTER>): string[] =>
      applyFilter(rows, { ...NO_FILTER, ...f }).map((r) => r.name);
    expect(names({ q: 'ROSHNI@' })).toEqual(['Roshni Sahani']);
    expect(names({ role: 'Manager' })).toEqual(['Priya Shah']);
    expect(names({ managerId: 'e-priya' })).toEqual(['Old Hand', 'Roshni Sahani']);
    expect(names({ flag: 'managerNoRole' })).toEqual(['Roshni Sahani']);
    expect(names({ flag: 'noRole', q: 'old' })).toEqual(['Old Hand']);
  });

  it('sorts with blanks last either way', () => {
    const rows = buildRows(people, employees, shifts);
    const byManager = (dir: 'asc' | 'desc'): string[] =>
      sortRows(rows, { key: 'manager', dir }, (r) => r.managerName ?? '').map((r) => r.name);
    expect(byManager('asc')).toEqual([
      'Old Hand',
      'Roshni Sahani',
      'Nilesh D',
      'New Person',
      'Priya Shah',
    ]);
    expect(byManager('desc').slice(0, 3)).toEqual(['Nilesh D', 'Old Hand', 'Roshni Sahani']);
  });

  it('pages by 50, clamping the page', () => {
    const many = Array.from({ length: 120 }, (_, i) => i);
    expect(pageOf(many, 0).rows).toHaveLength(PAGE_SIZE);
    expect(pageOf(many, 2)).toMatchObject({ page: 2, pages: 3 });
    expect(pageOf(many, 2).rows).toHaveLength(20);
    expect(pageOf(many, 9).page).toBe(2);
    expect(pageOf([], 0)).toEqual({ rows: [], page: 0, pages: 1 });
  });

  it('offers managers with the Manager or HR role, plus the current one', () => {
    const rows = buildRows(people, employees, shifts);
    const nilesh = rows.find((r) => r.name === 'Nilesh D')!;
    expect(managerChoices(rows, nilesh).map((c) => c.name)).toEqual([
      'Priya Shah',
      'Roshni Sahani',
    ]);
    const priya = rows.find((r) => r.name === 'Priya Shah')!;
    expect(managerChoices(rows, priya)).toEqual([]);
  });
});

describe('bulk plans (ADR-0038 §5)', () => {
  const rows = buildRows(people, employees, shifts);
  const by = (...names: string[]) => rows.filter((r) => names.includes(r.name));
  const names = (rs: readonly { name: string }[]) => rs.map((r) => r.name);

  it('manager: who changes, who already has them, who has no record', () => {
    const plan = managerPlan(
      rows,
      by('Roshni Sahani', 'Old Hand', 'Nilesh D', 'New Person'),
      'e-priya',
    );
    expect(names(plan.change)).toEqual(['Nilesh D']);
    expect(names(plan.already)).toEqual(['Old Hand', 'Roshni Sahani']);
    expect(names(plan.skipped)).toEqual(['New Person']);
    expect(plan.problem).toBeNull();
  });

  it('manager: spots the manager among them, and a loop, naming who', () => {
    expect(managerPlan(rows, by('Priya Shah', 'Nilesh D'), 'e-priya').problem).toMatchObject({
      code: 'self_manager',
      who: { name: 'Priya Shah' },
    });
    // Nilesh reports to Roshni, who reports to Priya: Priya under Nilesh is a loop.
    expect(managerPlan(rows, by('Priya Shah'), 'e-nilesh').problem).toMatchObject({
      code: 'manager_loop',
      who: { name: 'Priya Shah' },
    });
    expect(managerPlan(rows, by('Priya Shah', 'Nilesh D'), null).problem).toBeNull();
  });

  it('roles and welcome', () => {
    const add = rolePlan(by('Priya Shah', 'Roshni Sahani', 'Old Hand'), 'Manager', true);
    expect(names(add.change)).toEqual(['Old Hand', 'Roshni Sahani']);
    expect(names(add.already)).toEqual(['Priya Shah']);
    const remove = rolePlan(by('Priya Shah', 'Roshni Sahani'), 'Manager', false);
    expect(names(remove.change)).toEqual(['Priya Shah']);
    const w = welcomePlan(by('Priya Shah', 'Old Hand', 'New Person'));
    expect(names(w.send)).toEqual(['New Person', 'Priya Shah']);
    expect(names(w.skipped)).toEqual(['Old Hand']);
  });

  it('names a few, then counts the rest', () => {
    const r = by('Priya Shah', 'Roshni Sahani', 'Old Hand', 'Nilesh D', 'New Person');
    expect(namesText(r.slice(0, 1))).toBe('New Person');
    expect(namesText(r.slice(0, 2))).toBe('New Person and Nilesh D');
    expect(namesText(r)).toBe('New Person, Nilesh D, Old Hand and 2 others');
  });
});
