import type { EmployeeRow, Person, Shift, ShiftRow } from '../api.js';

/**
 * The People table (ADR-0038 §3): one row per person, joined from the
 * three lists the server already gives (roles from Entra, the employee
 * record with its manager, and shifts). Pure, so the table and its
 * tests share it.
 */

export interface PersonRow {
  /** The Entra id, or the employee id for a record without one. */
  key: string;
  oid: string | null;
  /** Null: no CloudPunch record yet. */
  employeeId: string | null;
  name: string;
  email: string | null;
  roles: string[];
  managerId: string | null;
  managerName: string | null;
  /** Undefined: shifts not known to this role (HR); null: no shift. */
  shift: Shift | null | undefined;
  /** The named shift they're on (ADR-0038 §6); null: custom or none. */
  template: { id: string; name: string } | null;
}

/** Roles that can see others' time, so can be someone's manager (ADR-0025). */
export const MANAGING_ROLES = ['Manager', 'HR'];

export function buildRows(
  people: readonly Person[],
  employees: readonly EmployeeRow[],
  shifts: readonly ShiftRow[] | null,
): PersonRow[] {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const shiftOf = (employeeId: string | null): Shift | null | undefined => {
    if (shifts === null) return undefined;
    if (employeeId === null) return null;
    return shifts.find((s) => s.employee_id === employeeId)?.shift ?? null;
  };
  const templateOf = (employeeId: string | null) =>
    (employeeId && shifts?.find((s) => s.employee_id === employeeId)?.template) || null;
  const row = (p: Person | null, e: EmployeeRow | null): PersonRow => {
    const managerId = e?.reporting_manager_id ?? null;
    return {
      key: p?.oid ?? e?.oid ?? e?.id ?? '',
      oid: p?.oid ?? e?.oid ?? null,
      employeeId: e?.id ?? null,
      name: p?.name ?? e?.name ?? '',
      email: e?.email ?? null,
      roles: p ? [...p.roles] : [],
      managerId,
      managerName: managerId ? (byId.get(managerId)?.name ?? null) : null,
      shift: shiftOf(e?.id ?? null),
      template: templateOf(e?.id ?? null),
    };
  };
  const rows = people.map((p) => row(p, employees.find((e) => e.oid === p.oid) ?? null));
  // Records whose roles are gone (ADR-0020 §4): still listed, as "No role".
  for (const e of employees) {
    if (!e.oid || !people.some((p) => p.oid === e.oid)) rows.push(row(null, e));
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export type Flag = 'noManager' | 'noShift' | 'managerNoRole' | 'noRole';

const lacksManagingRole = (r: PersonRow): boolean =>
  !MANAGING_ROLES.some((role) => r.roles.includes(role));

/** Whether a row has this problem; `all` to know who manages whom. */
export function hasFlag(r: PersonRow, flag: Flag, all: readonly PersonRow[]): boolean {
  switch (flag) {
    case 'noManager':
      return r.employeeId !== null && r.managerId === null;
    case 'noShift':
      return r.employeeId !== null && r.shift === null;
    case 'managerNoRole':
      return (
        r.employeeId !== null &&
        lacksManagingRole(r) &&
        all.some((x) => x.managerId === r.employeeId)
      );
    case 'noRole':
      return r.roles.length === 0;
  }
}

export const FLAGS: readonly Flag[] = ['noManager', 'noShift', 'managerNoRole', 'noRole'];

/** "3 without a manager", as the needs-attention filter reads. */
export function flagText(flag: Flag, n: number): string {
  const one = n === 1;
  switch (flag) {
    case 'noManager':
      return `${n} without a manager`;
    case 'noShift':
      return `${n} without a shift`;
    case 'managerNoRole':
      return `${n} ${one ? 'manager' : 'managers'} without the Manager role`;
    case 'noRole':
      return `${n} with a record but no role`;
  }
}

/** How many rows have each problem. */
export function attention(rows: readonly PersonRow[]): Record<Flag, number> {
  const out = { noManager: 0, noShift: 0, managerNoRole: 0, noRole: 0 };
  for (const r of rows) for (const f of FLAGS) if (hasFlag(r, f, rows)) out[f] += 1;
  return out;
}

/** Short words for the Status column; empty when nothing needs doing. */
export function statusOf(r: PersonRow, all: readonly PersonRow[]): string[] {
  if (r.employeeId === null) return ['No record'];
  const out: string[] = [];
  if (hasFlag(r, 'noRole', all)) out.push('No role');
  if (hasFlag(r, 'noManager', all)) out.push('No manager');
  if (hasFlag(r, 'noShift', all)) out.push('No shift');
  if (hasFlag(r, 'managerNoRole', all)) out.push('Needs Manager role');
  return out;
}

export interface Filter {
  /** Name or email. */
  q: string;
  /** A role, or '' for any. */
  role: string;
  /** Reports to this employee id, or '' for anyone. */
  managerId: string;
  flag: Flag | null;
}

export const NO_FILTER: Filter = { q: '', role: '', managerId: '', flag: null };

export function applyFilter(rows: readonly PersonRow[], f: Filter): PersonRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!q || r.name.toLowerCase().includes(q) || (r.email ?? '').toLowerCase().includes(q)) &&
      (!f.role || r.roles.includes(f.role)) &&
      (!f.managerId || r.managerId === f.managerId) &&
      (!f.flag || hasFlag(r, f.flag, rows)),
  );
}

export type SortKey = 'name' | 'roles' | 'manager' | 'shift' | 'status';
export interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** Sorted by `s`; blanks last either way, then by name. */
export function sortRows(
  rows: readonly PersonRow[],
  s: Sort,
  text: (r: PersonRow) => string,
): PersonRow[] {
  const sign = s.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = text(a);
    const y = text(b);
    if (x === '' && y !== '') return 1;
    if (y === '' && x !== '') return -1;
    return sign * x.localeCompare(y) || a.name.localeCompare(b.name);
  });
}

export const PAGE_SIZE = 50;

/** One page of rows, the page clamped to those there are. */
export function pageOf<T>(
  rows: readonly T[],
  page: number,
): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { rows: rows.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), page: p, pages };
}

/** Who can be picked as this person's manager (ADR-0038 §4). */
export function managerChoices(
  rows: readonly PersonRow[],
  forRow: PersonRow,
): { id: string; name: string }[] {
  return rows
    .filter(
      (r): r is PersonRow & { employeeId: string } =>
        r.employeeId !== null &&
        r.employeeId !== forRow.employeeId &&
        (!lacksManagingRole(r) || r.employeeId === forRow.managerId),
    )
    .map((r) => ({ id: r.employeeId, name: r.name }));
}

// Bulk changes (ADR-0038 §5): what Apply would do, shown before it does.

/** At most this many people per bulk change (the server checks too). */
export const MAX_BULK = 200;

export interface ManagerPlan {
  /** Will get the new manager. */
  change: PersonRow[];
  /** Already have them. */
  already: PersonRow[];
  /** No CloudPunch record, so no manager to set: left out. */
  skipped: PersonRow[];
  /** Why the whole batch can't go, naming who; null when it can. */
  problem: { code: 'self_manager' | 'manager_loop'; who: PersonRow } | null;
}

/** Give everyone in `picked` the manager `managerId` (null: none). */
export function managerPlan(
  rows: readonly PersonRow[],
  picked: readonly PersonRow[],
  managerId: string | null,
): ManagerPlan {
  const withRecord = picked.filter((r) => r.employeeId !== null);
  const plan: ManagerPlan = {
    change: withRecord.filter((r) => r.managerId !== managerId),
    already: withRecord.filter((r) => r.managerId === managerId),
    skipped: picked.filter((r) => r.employeeId === null),
    problem: null,
  };
  if (managerId === null) return plan;
  const ids = new Set(withRecord.map((r) => r.employeeId));
  const self = withRecord.find((r) => r.employeeId === managerId);
  if (self) return { ...plan, problem: { code: 'self_manager', who: self } };
  // Nobody being moved may be above the new manager.
  const byId = new Map(rows.map((r) => [r.employeeId, r]));
  let up = byId.get(managerId)?.managerId ?? null;
  for (let i = 0; up && i < 50; i++) {
    if (ids.has(up)) {
      const who = byId.get(up);
      if (who) return { ...plan, problem: { code: 'manager_loop', who } };
    }
    up = byId.get(up)?.managerId ?? null;
  }
  return plan;
}

export interface RolePlan {
  change: PersonRow[];
  already: PersonRow[];
  /** Not linked to a Microsoft account: no roles to set. */
  skipped: PersonRow[];
}

/** Add `role` to (or remove it from) everyone in `picked`. */
export function rolePlan(picked: readonly PersonRow[], role: string, add: boolean): RolePlan {
  const linked = picked.filter((r) => r.oid !== null);
  const has = (r: PersonRow): boolean => r.roles.includes(role);
  return {
    change: linked.filter((r) => has(r) !== add),
    already: linked.filter((r) => has(r) === add),
    skipped: picked.filter((r) => r.oid === null),
  };
}

/** Welcome emails go to those with a Microsoft account and the Employee role. */
export function welcomePlan(picked: readonly PersonRow[]): {
  send: PersonRow[];
  skipped: PersonRow[];
} {
  const ok = (r: PersonRow): boolean => r.oid !== null && r.roles.includes('Employee');
  return { send: picked.filter(ok), skipped: picked.filter((r) => !ok(r)) };
}

/** "Priya Shah, Roshni Sahani and 3 others". */
export function namesText(rows: readonly PersonRow[], max = 3): string {
  const names = rows.map((r) => r.name);
  if (names.length <= max) {
    return names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  }
  const rest = names.length - max;
  return `${names.slice(0, max).join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`;
}

export interface ShiftPlan {
  change: PersonRow[];
  /** Already on that named shift. */
  already: PersonRow[];
  /** No CloudPunch record, so no shift to set: left out. */
  skipped: PersonRow[];
}

/** Give everyone in `picked` the named shift `templateId`. */
export function shiftPlan(picked: readonly PersonRow[], templateId: string): ShiftPlan {
  const withRecord = picked.filter((r) => r.employeeId !== null);
  return {
    change: withRecord.filter((r) => r.template?.id !== templateId),
    already: withRecord.filter((r) => r.template?.id === templateId),
    skipped: picked.filter((r) => r.employeeId === null),
  };
}
