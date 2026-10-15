import {
  bulkShiftBody,
  officePatternBody,
  patternBody,
} from '../../desktop/src/admin/shiftBodies.js';
import type { api as DesktopApi } from '../../desktop/src/api.js';

/**
 * The browser side of the desktop's `api` object (ADR-0033 §5). The
 * desktop's Team, person and connections screens are built into the
 * web app unchanged; `desktopScreens()` in vite.config points their
 * `./api.js` here. Each call is the same `/v1` request the desktop's
 * Rust core makes, with the MSAL token, and rejects the same way: the
 * screens read `String(e)` as a code (`offline`, `sign_in_again`, or the
 * server's `code`), which `ApiRefusal` gives them.
 *
 * Managers decide corrections here too (ADR-0033, amended 2026-10-08),
 * and the admin console's screens make their changes here as in the
 * desktop (ADR-0038 §2); asking for a correction still refuses with
 * `view_only` before sending anything.
 */

type Api = typeof DesktopApi;

/** The calls the shared screens make. */
export type WebApi = Pick<
  Api,
  | 'teamNow'
  | 'teamDay'
  | 'teamDays'
  | 'teamExceptions'
  | 'teamConnections'
  | 'personConnections'
  | 'myConnections'
  | 'myInsights'
  | 'addInsightContext'
  | 'requestCorrection'
  | 'correctionsQueue'
  | 'decideCorrection'
  | 'adminCorrectTime'
  // The admin console (ADR-0038).
  | 'adminPeople'
  | 'adminPeopleSearch'
  | 'adminPeopleSetRoles'
  | 'adminWelcomePreview'
  | 'adminWelcomeSend'
  | 'adminEmployees'
  | 'adminSetManager'
  | 'adminActiveDevice'
  | 'adminActiveDeviceSignOut'
  | 'adminShifts'
  | 'adminSetShift'
  | 'holidays'
  | 'setHoliday'
  | 'removeHoliday'
  | 'adminDepartments'
  | 'adminPolicyGet'
  | 'adminRetentionPreview'
  | 'adminPolicyHistory'
  | 'adminPersonHistory'
  | 'adminPolicyPut'
  | 'adminDevices'
  | 'adminBulkManager'
  | 'adminBulkRoles'
  | 'adminBulkWelcome'
  | 'adminShiftTemplates'
  | 'adminCreateShiftTemplate'
  | 'adminSaveShiftTemplate'
  | 'adminRetireShiftTemplate'
  | 'adminSetNamedShift'
  | 'adminBulkShift'
  | 'adminOfficeDays'
  | 'adminSetOfficePattern'
  | 'adminSetOfficeDay'
  | 'adminBulkOffice'
  | 'reportDay'
  | 'insights'
  | 'insightHistory'
  | 'insightNudge'
  | 'insightDismiss'
  | 'adminUpdatesLatest'
  | 'reportOverview'
  | 'reportHabits'
  | 'saveCsv'
>;

export interface Transport {
  fetch: typeof fetch;
  token: () => Promise<string>;
}

/** A refused call; `String()` of it is the code, as the desktop's rejections are. */
export class ApiRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ApiRefusal';
  }

  override toString(): string {
    return this.code;
  }
}

const refuse = (code: string): ApiRefusal => new ApiRefusal(code);

let transport: Transport | null = null;

/** Called once signed in; until then every call answers `sign_in_again`. */
export function connectApi(t: Transport | null): void {
  transport = t;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const get = <T>(path: string): Promise<T> => send<T>('GET', path);

async function send<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  if (!transport) throw refuse('sign_in_again');
  let token: string;
  try {
    token = await transport.token();
  } catch {
    throw refuse('sign_in_again');
  }
  let res: Response;
  try {
    res = await transport.fetch(
      path,
      body === undefined
        ? method === 'GET'
          ? { headers: { authorization: `Bearer ${token}` } }
          : { method, headers: { authorization: `Bearer ${token}` } }
        : {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
  } catch {
    throw refuse('offline');
  }
  // As the Rust core: an empty answer (204) is `null`.
  if (res.ok) return (res.status === 204 ? null : await res.json().catch(() => null)) as T;
  if (res.status === 401) throw refuse('sign_in_again');
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
    throw refuse(typeof body?.code === 'string' ? body.code : `http_${res.status}`);
  }
  throw refuse('offline');
}

/** Same checks as the Rust core: ids and dates go into the URL path. */
function check(ok: boolean): void {
  if (!ok) throw refuse('invalid_argument');
}

/** The optional reason or note, trimmed, as the Rust core sends it. */
function withText(body: Record<string, unknown>, key: string, text: string | null): unknown {
  const t = text?.trim();
  return t ? { ...body, [key]: t } : body;
}

/** `("global", null)` or `("department", uuid)`, as `Scope::parse`. */
function policyPath(scope: 'global' | 'department', id: string | null): string {
  if (scope === 'global' && id === null) return '/v1/admin/policy/global';
  check(scope === 'department' && id !== null && UUID.test(id));
  return `/v1/admin/policy/departments/${id}`;
}

const viewOnly = (): Promise<never> => Promise.reject(refuse('view_only'));

export const api: WebApi = {
  teamNow: () => get('/v1/team'),
  teamDay: async (employeeId, date) => {
    check(UUID.test(employeeId) && DATE.test(date));
    return get(`/v1/team/${employeeId}/days/${date}`);
  },
  teamDays: async (employeeId, from, to) => {
    check(UUID.test(employeeId) && DATE.test(from) && DATE.test(to));
    return get(`/v1/team/${employeeId}/days?from=${from}&to=${to}`);
  },
  teamExceptions: async (from, to, employeeId = null) => {
    check(DATE.test(from) && DATE.test(to) && (employeeId === null || UUID.test(employeeId)));
    const who = employeeId ? `&employee_id=${employeeId}` : '';
    return get(`/v1/team/exceptions?from=${from}&to=${to}${who}`);
  },
  teamConnections: () => get('/v1/team/connections'),
  personConnections: async (employeeId) => {
    check(UUID.test(employeeId));
    return get(`/v1/team/${employeeId}/connections`);
  },
  myConnections: () => get('/v1/me/connections'),
  myInsights: () => get('/v1/me/insights'),
  addInsightContext: async (id, text) => {
    check(UUID.test(id));
    return send('POST', `/v1/me/insights/${id}/context`, { text });
  },
  correctionsQueue: () => get('/v1/corrections/queue'),
  requestCorrection: viewOnly,
  // As the Rust core: endorse/approve/reject/withdraw, an optional note.
  decideCorrection: async (id, decision, note = null) => {
    check(UUID.test(id) && ['endorse', 'approve', 'reject', 'withdraw'].includes(decision));
    const text = note?.trim();
    return send(
      'POST',
      `/v1/corrections/${id}/decision`,
      text ? { decision, note: text } : { decision },
    );
  },

  // ADR-0049: an Administrator's correction counts at once.
  adminCorrectTime: async (c) => {
    check(UUID.test(c.employeeId));
    return send('POST', `/v1/admin/employees/${c.employeeId}/corrections`, {
      from: c.from,
      to: c.to,
      tz_iana: c.tzIana,
      kind: c.kind,
      reason: c.reason,
    });
  },

  // The admin console (ADR-0038 §2): the same requests as the Rust
  // core's `admin.rs`. The server checks the role on each one.
  adminPeople: () => get('/v1/admin/people'),
  adminPeopleSearch: (q) => get(`/v1/admin/people/search?${new URLSearchParams({ q }).toString()}`),
  adminPeopleSetRoles: async (oid, roles, reason) => {
    check(UUID.test(oid));
    return send('PUT', `/v1/admin/people/${oid}/roles`, withText({ roles }, 'reason', reason));
  },
  adminWelcomePreview: async (oid) => {
    check(UUID.test(oid));
    return get(`/v1/admin/people/${oid}/welcome`);
  },
  adminWelcomeSend: async (oid, note) => {
    check(UUID.test(oid));
    return send('POST', `/v1/admin/people/${oid}/welcome`, withText({}, 'note', note));
  },
  adminEmployees: () => get('/v1/admin/employees'),
  adminSetManager: async (employeeId, managerId, reason) => {
    check(UUID.test(employeeId) && (managerId === null || UUID.test(managerId)));
    return send(
      'PUT',
      `/v1/admin/employees/${employeeId}/manager`,
      withText({ manager_employee_id: managerId }, 'reason', reason),
    );
  },
  adminActiveDevice: async (employeeId) => {
    check(UUID.test(employeeId));
    return get(`/v1/people/${employeeId}/active-device`);
  },
  adminActiveDeviceSignOut: async (employeeId, deviceId) => {
    check(UUID.test(employeeId) && UUID.test(deviceId));
    return send('POST', `/v1/people/${employeeId}/active-device/sign-out`, {
      device_id: deviceId,
    });
  },
  adminShifts: () => get('/v1/admin/shifts'),
  adminSetShift: async (employeeId, s) => {
    check(UUID.test(employeeId));
    return send('PUT', `/v1/admin/employees/${employeeId}/shift`, {
      days: s.days,
      start: s.start,
      end: s.end,
      tz_iana: s.tzIana,
    });
  },
  holidays: () => get('/v1/holidays'),
  setHoliday: async (date, name) => {
    check(DATE.test(date));
    return send('PUT', `/v1/admin/holidays/${date}`, { name });
  },
  removeHoliday: async (date) => {
    check(DATE.test(date));
    return send('DELETE', `/v1/admin/holidays/${date}`);
  },
  adminDepartments: () => get('/v1/admin/departments'),
  adminPolicyGet: async (scope, id) => get(policyPath(scope, id)),
  adminRetentionPreview: async (p) => {
    const q = Object.entries(p)
      .map(([k, v]) => {
        check(Number.isInteger(v));
        return `${k}=${String(v)}`;
      })
      .join('&');
    return get(`/v1/admin/retention/preview?${q}`);
  },
  adminPolicyHistory: async (scope, id) => get(`${policyPath(scope, id)}/history`),
  adminPersonHistory: async (employeeId) => {
    check(UUID.test(employeeId));
    return get(`/v1/admin/employees/${employeeId}/history`);
  },
  adminPolicyPut: async (scope, id, document, reason) =>
    send('PUT', policyPath(scope, id), withText({ document }, 'reason', reason)),
  adminDevices: () => get('/v1/admin/devices'),
  // Bulk (ADR-0038 §5): the server checks the ids and keeps the answer by key.
  adminBulkManager: async (key, employeeIds, managerId, reason) =>
    send(
      'PUT',
      '/v1/admin/employees/bulk/manager',
      withText(
        { idempotency_key: key, employee_ids: employeeIds, manager_employee_id: managerId },
        'reason',
        reason,
      ),
    ),
  adminBulkRoles: async (key, oids, change, reason) =>
    send(
      'POST',
      '/v1/admin/people/bulk/roles',
      withText(
        { idempotency_key: key, oids, add: change.add, remove: change.remove },
        'reason',
        reason,
      ),
    ),
  // Named shifts (ADR-0038 §6): the same requests as the Rust core.
  adminShiftTemplates: () => get('/v1/admin/shift-templates'),
  adminCreateShiftTemplate: async (t, reason) =>
    send('POST', '/v1/admin/shift-templates', patternBody(t, reason)),
  adminSaveShiftTemplate: async (id, t, effectiveFrom, reason, dryRun = false) => {
    check(UUID.test(id));
    return send('PUT', `/v1/admin/shift-templates/${id}`, {
      ...patternBody(t, reason),
      effective_from: effectiveFrom,
      ...(dryRun ? { dry_run: true } : {}),
    });
  },
  adminRetireShiftTemplate: async (id, reason) => {
    check(UUID.test(id));
    return send('POST', `/v1/admin/shift-templates/${id}/retire`, withText({}, 'reason', reason));
  },
  adminSetNamedShift: async (employeeId, templateId, effectiveFrom) => {
    check(UUID.test(employeeId));
    return send('PUT', `/v1/admin/employees/${employeeId}/shift`, {
      template_id: templateId,
      ...(effectiveFrom ? { effective_from: effectiveFrom } : {}),
    });
  },
  adminBulkShift: async (key, employeeIds, target, effectiveFrom, reason) =>
    send(
      'PUT',
      '/v1/admin/employees/bulk/shift',
      bulkShiftBody(key, employeeIds, target, effectiveFrom, reason),
    ),
  // In-office days (ADR-0039): the same requests as the Rust core.
  adminOfficeDays: async (from, to) => {
    check(DATE.test(from) && DATE.test(to));
    return get(`/v1/admin/office-days?from=${from}&to=${to}`);
  },
  adminSetOfficePattern: async (employeeId, weekdays, effectiveFrom, reason) => {
    check(UUID.test(employeeId));
    return send(
      'PUT',
      `/v1/admin/employees/${employeeId}/office-pattern`,
      officePatternBody(weekdays, effectiveFrom, reason),
    );
  },
  adminSetOfficeDay: async (employeeId, date, inOffice, reason) => {
    check(UUID.test(employeeId) && DATE.test(date));
    return send(
      'PUT',
      `/v1/admin/employees/${employeeId}/office-days/${date}`,
      withText({ in_office: inOffice }, 'reason', reason),
    );
  },
  adminBulkOffice: async (key, employeeIds, weekdays, effectiveFrom, reason) =>
    send('PUT', '/v1/admin/employees/bulk/office-pattern', {
      idempotency_key: key,
      employee_ids: employeeIds,
      ...officePatternBody(weekdays, effectiveFrom, reason),
    }),
  adminUpdatesLatest: () => get('/v1/admin/updates/latest'),
  insights: (status) => get(`/v1/insights?status=${status === 'closed' ? 'closed' : 'live'}`),
  insightHistory: async (id) => {
    check(UUID.test(id));
    return get(`/v1/insights/${id}/history`);
  },
  insightNudge: async (id, message) => {
    check(UUID.test(id));
    return send('POST', `/v1/insights/${id}/nudge`, { message });
  },
  insightDismiss: async (id, reason) => {
    check(UUID.test(id));
    return send('POST', `/v1/insights/${id}/dismiss`, { reason });
  },
  reportDay: async (date) => {
    check(DATE.test(date));
    return get(`/v1/reports/day?date=${date}`);
  },
  reportOverview: async (from, to) => {
    check(DATE.test(from) && DATE.test(to));
    return get(`/v1/reports/overview?from=${from}&to=${to}`);
  },
  reportHabits: async () => get('/v1/reports/habits'),
  // The browser's own download; the name is what it's saved as.
  saveCsv: async (name, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
  },
  adminBulkWelcome: async (key, oids, note) =>
    send(
      'POST',
      '/v1/admin/people/bulk/welcome',
      withText({ idempotency_key: key, oids }, 'note', note),
    ),
};
