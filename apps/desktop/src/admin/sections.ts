/**
 * The admin console's sidebar (ADR-0038 §1): each section, and the
 * capabilities that show it. These are the same checks the desktop's
 * Settings tabs use; the server checks every request again, so this only
 * hides what would be refused.
 */

export type SectionKey =
  'people' | 'managers' | 'shifts' | 'holidays' | 'rules' | 'computers' | 'connections';

export interface Section {
  key: SectionKey;
  label: string;
  /** Shown when the person has any of these. */
  anyOf: readonly string[];
}

export const SECTIONS: readonly Section[] = [
  { key: 'people', label: 'People', anyOf: ['admin.role.assign', 'hr.employee.write'] },
  // Reporting lines on their own page (owner request, 2026-10-12).
  { key: 'managers', label: 'Managers', anyOf: ['admin.role.assign', 'hr.employee.write'] },
  { key: 'shifts', label: 'Shifts', anyOf: ['admin.shift.write'] },
  { key: 'holidays', label: 'Holidays', anyOf: ['hr.holiday.write'] },
  { key: 'rules', label: 'Rules', anyOf: ['admin.policy.write', 'hr.policy.write'] },
  { key: 'computers', label: 'Computers', anyOf: ['admin.device.read'] },
  { key: 'connections', label: 'Connections', anyOf: ['admin.connection.read'] },
];

/** The sections these capabilities can use, in sidebar order. */
export function sectionsFor(capabilities: readonly string[]): Section[] {
  return SECTIONS.filter((s) => s.anyOf.some((c) => capabilities.includes(c)));
}

/** `wanted` if it's offered, else the first section offered, else null. */
export function pickSection(offered: readonly Section[], wanted: string | null): SectionKey | null {
  return offered.find((s) => s.key === wanted)?.key ?? offered[0]?.key ?? null;
}
