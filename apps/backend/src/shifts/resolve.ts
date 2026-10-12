import type { DbRepositories, ShiftAssignment, ShiftTemplateVersion } from '../db/index.js';

/**
 * Named shifts (ADR-0038 §6): one place turns stored shift rows into the
 * rows that apply, so `/v1/me/shift`, Team, the shift-start emails and
 * the Monday email all read the same shift.
 *
 * A custom row applies as stored. A row that follows a named shift
 * applies from its date until the person's next row, and over that time
 * it takes each version of the named shift as it comes: the version in
 * force on its date, then each later version from its own date. The
 * result is plain rows, newest first, so `shiftOn` and friends in
 * `model.ts` work unchanged. Pure.
 */
export function resolveRows(
  rows: readonly ShiftAssignment[],
  versions: readonly ShiftTemplateVersion[],
): ShiftAssignment[] {
  const byTemplate = new Map<string, ShiftTemplateVersion[]>();
  for (const v of versions) {
    const list = byTemplate.get(v.templateId) ?? [];
    list.push(v);
    byTemplate.set(v.templateId, list);
  }
  for (const list of byTemplate.values()) list.sort(versionOrder);

  const out: ShiftAssignment[] = [];
  const byEmployee = new Map<string, ShiftAssignment[]>();
  for (const r of rows) {
    const list = byEmployee.get(r.employeeId) ?? [];
    list.push(r);
    byEmployee.set(r.employeeId, list);
  }
  for (const list of byEmployee.values()) {
    // Oldest first: each row applies until the next one's date.
    const asc = [...list].sort((a, b) => -newestFirst(a, b));
    asc.forEach((row, i) => {
      const until = asc[i + 1]?.effectiveFrom ?? null;
      const vs = row.templateId ? byTemplate.get(row.templateId) : undefined;
      if (!vs || (until !== null && until <= row.effectiveFrom)) {
        out.push(row);
        return;
      }
      const atStart = [...vs].reverse().find((v) => v.effectiveFrom <= row.effectiveFrom);
      // Before the named shift's first version: the snapshot stands.
      out.push(atStart ? asRow(row, atStart, row.effectiveFrom) : row);
      for (const v of vs) {
        if (v.effectiveFrom > row.effectiveFrom && (until === null || v.effectiveFrom < until)) {
          out.push(asRow(row, v, v.effectiveFrom));
        }
      }
    });
  }
  return out.sort(newestFirst);
}

/** Oldest version first; on the same date, the later-made one last. */
function versionOrder(a: ShiftTemplateVersion, b: ShiftTemplateVersion): number {
  return (
    a.effectiveFrom.localeCompare(b.effectiveFrom) || a.createdAt.getTime() - b.createdAt.getTime()
  );
}

function newestFirst(a: ShiftAssignment, b: ShiftAssignment): number {
  return (
    b.effectiveFrom.localeCompare(a.effectiveFrom) ||
    b.assignedAt.getTime() - a.assignedAt.getTime() ||
    b.id.localeCompare(a.id)
  );
}

function asRow(row: ShiftAssignment, v: ShiftTemplateVersion, from: string): ShiftAssignment {
  return {
    ...row,
    id: `${row.id}:${v.id}`,
    days: [...v.days],
    start: v.start,
    end: v.end,
    tzIana: v.tzIana,
    effectiveFrom: from,
  };
}

/** The version of a named shift in force on `date`, if any. */
export function templateOn(
  versions: readonly ShiftTemplateVersion[],
  templateId: string,
  date: string,
): ShiftTemplateVersion | null {
  return (
    versions
      .filter((v) => v.templateId === templateId && v.effectiveFrom <= date)
      .sort(versionOrder)
      .at(-1) ?? null
  );
}

/**
 * Everyone's shift rows, resolved: what every reader of a shift calls.
 * Named-shift versions are only fetched when someone is on one.
 */
export async function shiftHistory(
  db: DbRepositories,
  employeeIds: readonly string[],
): Promise<ShiftAssignment[]> {
  const rows = await db.shifts.history(employeeIds);
  if (!rows.some((r) => r.templateId)) return rows;
  return resolveRows(rows, await db.shifts.templates());
}
