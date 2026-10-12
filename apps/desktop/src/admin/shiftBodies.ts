import type { BulkShiftTarget, ShiftPattern } from '../api.js';

/**
 * Request bodies for named shifts (ADR-0038 §6), shared by the desktop's
 * `api.ts` and the web's: no Tauri here, so the web build can use it.
 */

/** A named shift's fields as the server takes them. */
export function patternBody(t: ShiftPattern, reason: string): Record<string, unknown> {
  const r = reason.trim();
  return {
    name: t.name,
    days: t.days,
    start: t.start,
    end: t.end,
    tz_iana: t.tzIana,
    ...(r ? { reason: r } : {}),
  };
}

/** A bulk shift request as the server takes it. */
export function bulkShiftBody(
  key: string,
  employeeIds: string[],
  target: BulkShiftTarget,
  effectiveFrom: string | null,
  reason: string,
): Record<string, unknown> {
  const r = reason.trim();
  return {
    idempotency_key: key,
    employee_ids: employeeIds,
    ...('templateId' in target
      ? { template_id: target.templateId }
      : { days: target.days, start: target.start, end: target.end, tz_iana: target.tzIana }),
    ...(effectiveFrom ? { effective_from: effectiveFrom } : {}),
    ...(r ? { reason: r } : {}),
  };
}
