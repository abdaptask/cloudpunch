import type { DbRepositories, OfficeDay, OfficePattern } from '../db/index.js';
import { isoWeekday } from '../shifts/model.js';

/**
 * In-office days (ADR-0039 §1): a person is in the office on a date when
 * a one-off says so, or else their usual office weekdays in force on that
 * date include its weekday. The latest one-off for a date wins. Pure.
 */
export function inOffice(
  patterns: readonly OfficePattern[],
  days: readonly OfficeDay[],
  date: string,
): boolean {
  const oneOff = days
    .filter((d) => d.date === date)
    .sort((a, b) => b.setAt.getTime() - a.setAt.getTime())[0];
  if (oneOff) return oneOff.inOffice;
  const pattern = [...patterns]
    .sort(
      (a, b) =>
        b.effectiveFrom.localeCompare(a.effectiveFrom) || b.setAt.getTime() - a.setAt.getTime(),
    )
    .find((p) => p.effectiveFrom <= date);
  return !!pattern && pattern.weekdays.includes(isoWeekday(date));
}

/** The usual office weekdays in force on `date` (newest first rows). */
export function weekdaysOn(patterns: readonly OfficePattern[], date: string): number[] {
  return (
    [...patterns]
      .sort(
        (a, b) =>
          b.effectiveFrom.localeCompare(a.effectiveFrom) || b.setAt.getTime() - a.setAt.getTime(),
      )
      .find((p) => p.effectiveFrom <= date)?.weekdays ?? []
  );
}

/**
 * `${employeeId}:${date}` for each of these people and dates that is an
 * office day: what Team, the alerts and `/v1/me/shift` all ask.
 */
export async function officeDays(
  db: DbRepositories,
  employeeIds: readonly string[],
  dates: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (employeeIds.length === 0 || dates.length === 0) return out;
  const sorted = [...dates].sort();
  const [patterns, days] = await Promise.all([
    db.office.patterns(employeeIds),
    db.office.days(employeeIds, sorted[0] ?? '', sorted.at(-1) ?? ''),
  ]);
  if (patterns.length === 0 && days.length === 0) return out;
  for (const id of employeeIds) {
    const p = patterns.filter((x) => x.employeeId === id);
    const d = days.filter((x) => x.employeeId === id);
    if (p.length === 0 && d.length === 0) continue;
    for (const date of dates) if (inOffice(p, d, date)) out.add(`${id}:${date}`);
  }
  return out;
}
