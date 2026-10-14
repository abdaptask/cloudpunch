import type { Page, Route } from '@playwright/test';

/**
 * A stand-in for the CloudPunch API (item 9): enough data for each
 * screen the browser tests open. Anything not answered here is a 404
 * problem, which the screens show as an error rather than crash on.
 */

export const ADMIN = [
  'team.timeline.read',
  'team.correction.review',
  'hr.employee.read',
  'hr.employee.write',
  'hr.holiday.write',
  'hr.policy.write',
  'admin.role.assign',
  'admin.shift.write',
  'admin.policy.write',
  'admin.device.read',
  'admin.connection.read',
];

const iso = (d: Date): string => d.toISOString();
const ago = (min: number): string => iso(new Date(Date.now() - min * 60_000));
const today = (): string => new Date().toISOString().slice(0, 10);

const SHIFT = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', tz_iana: 'Asia/Kolkata' };

const PEOPLE = [
  { id: 'e-roshni', oid: 'o-roshni', name: 'Roshni Sahani' },
  { id: 'e-farheen', oid: 'o-farheen', name: 'Farheen Khanam' },
  { id: 'e-nilesh', oid: 'o-nilesh', name: 'Nilesh Darekar' },
];

const dayRow = (
  p: (typeof PEOPLE)[number],
  status: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  employee_id: p.id,
  name: p.name,
  manager_id: null,
  date: today(),
  status,
  shift: { start: `${today()}T03:30:00.000Z`, end: `${today()}T12:30:00.000Z` },
  tz: 'Asia/Kolkata',
  clock_in: status === 'not_clocked_in' ? null : `${today()}T03:40:00.000Z`,
  clock_out: status === 'not_clocked_in' ? null : `${today()}T12:30:00.000Z`,
  still_in: false,
  minutes_late: status === 'late' ? 40 : 10,
  worked_ms: status === 'not_clocked_in' ? 0 : 8 * 3_600_000,
  shift_ms: 9 * 3_600_000,
  idle_ms: 20 * 60_000,
  breaks_ms: 30 * 60_000,
  breaks_over_limit: 0,
  away_ms: 0,
  corrections_waiting: 0,
  ...over,
});

const person = {
  worked_ms: 32 * 3_600_000,
  days_worked: 4,
  shift_days: 5,
  shift_days_worked: 4,
  attendance: 0.8,
  scheduled_ms: 45 * 3_600_000,
  late_starts: 1,
  avg_minutes_late: 25,
  missed_starts: 1,
  idle_ms: 2 * 3_600_000,
  idle_share: 0.06,
  breaks_ms: 2 * 3_600_000,
  break_ms_per_day: 30 * 60_000,
  breaks_over_limit: 1,
  away_ms: 3_600_000,
};

/** The JSON for a GET, or null for "not found". */
function answer(path: string, capabilities: readonly string[]): unknown {
  const url = new URL(path, 'http://x');
  const p = url.pathname;
  if (p === '/v1/me') {
    return {
      user: { display_name: 'Abdulla Sheikh (E2E)', work_email: 'e2e@aptask.com' },
      capabilities,
    };
  }
  if (p === '/v1/team') {
    return {
      people: [
        {
          employee_id: 'e-roshni',
          name: 'Roshni Sahani',
          status: 'working',
          kind: 'working',
          since: ago(90),
          back_by: null,
          worked_ms: 5 * 3_600_000,
        },
        {
          employee_id: 'e-farheen',
          name: 'Farheen Khanam',
          status: 'on_break',
          kind: 'meal_break',
          since: ago(12),
          back_by: ago(-18),
          worked_ms: 4 * 3_600_000,
        },
        {
          employee_id: 'e-nilesh',
          name: 'Nilesh Darekar',
          status: 'shift_not_started',
          kind: null,
          since: ago(60),
          back_by: null,
          worked_ms: 0,
        },
      ],
    };
  }
  if (p === '/v1/team/connections') return { people: [] };
  if (p === '/v1/team/exceptions') return { from: today(), to: today(), exceptions: [] };
  if (/^\/v1\/team\/[^/]+\/days$/.test(p)) return { name: 'x', days: [] };
  if (/^\/v1\/team\/[^/]+\/days\/\d{4}-\d{2}-\d{2}$/.test(p)) {
    const date = p.slice(-10);
    return {
      name: 'Roshni Sahani',
      date,
      sessions: [
        {
          session_id: 's1',
          device_id: 'd1',
          tz_iana: 'Asia/Kolkata',
          clock_in: `${date}T09:10:00.000+05:30`,
          clock_out: `${date}T18:00:00.000+05:30`,
          close_reason: 'user_clock_out',
          reconstructed: false,
          open: false,
          started_from_sign_in: false,
          segments: [
            {
              kind: 'working',
              started_at: `${date}T09:10:00.000+05:30`,
              ended_at: `${date}T13:00:00.000+05:30`,
            },
            {
              kind: 'meal_break',
              started_at: `${date}T13:00:00.000+05:30`,
              ended_at: `${date}T13:30:00.000+05:30`,
            },
            {
              kind: 'working',
              started_at: `${date}T13:30:00.000+05:30`,
              ended_at: `${date}T18:00:00.000+05:30`,
            },
          ],
        },
      ],
      totals: {
        worked_ms: 8.33 * 3_600_000,
        calls_ms: 0,
        meetings_ms: 0,
        breaks_ms: 1_800_000,
        paid_break_ms: 0,
        unpaid_break_ms: 1_800_000,
        prompt_ms: 0,
        idle_ms: 0,
      },
      corrections: [],
    };
  }
  if (p.startsWith('/v1/team/') && p.endsWith('/connections')) return { connections: [] };
  if (p === '/v1/reports/day') {
    const [roshni, farheen, nilesh] = PEOPLE;
    if (!roshni || !farheen || !nilesh) return null;
    return {
      date: url.searchParams.get('date'),
      counts: {
        worked: 1,
        late: 1,
        not_clocked_in: 1,
        not_working: 0,
        holiday: 0,
        in_office: 0,
        off: 0,
      },
      people: [dayRow(nilesh, 'not_clocked_in'), dayRow(farheen, 'late'), dayRow(roshni, 'worked')],
    };
  }
  if (p === '/v1/reports/overview') {
    return {
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      totals: { people: 3, ...person },
      people: PEOPLE.map((x) => ({ employee_id: x.id, name: x.name, ...person })),
      weeks: [
        {
          week: today(),
          shift_days: 15,
          shift_days_worked: 12,
          late_starts: 3,
          missed_starts: 3,
          worked_ms: 96 * 3_600_000,
          idle_ms: 6 * 3_600_000,
        },
      ],
      health: {
        active_people: 3,
        with_app: 3,
        clocked_in: 3,
        never_clocked_in: [],
        versions: [{ version: '0.1.40', computers: 3 }],
        newest_version: '0.1.40',
        computers_behind: 0,
        corrections_waiting: 0,
        refused: [],
      },
    };
  }
  if (p === '/v1/corrections/queue') return { to_endorse: [], to_approve: [] };
  if (p === '/v1/admin/people') {
    return {
      people: PEOPLE.map((x) => ({
        oid: x.oid,
        name: x.name,
        roles: ['Employee'],
        has_employee_record: true,
      })),
    };
  }
  if (p === '/v1/admin/employees') {
    return {
      employees: PEOPLE.map((x) => ({
        id: x.id,
        name: x.name,
        email: `${x.id}@aptask.com`,
        reporting_manager_id: null,
        oid: x.oid,
      })),
    };
  }
  if (p === '/v1/admin/shifts') {
    return {
      people: PEOPLE.map((x, i) => ({
        employee_id: x.id,
        name: x.name,
        shift: i === 2 ? null : SHIFT,
        ...(i === 0 ? { template: { id: 't-india', name: 'India day' } } : {}),
      })),
    };
  }
  if (p === '/v1/admin/shift-templates') {
    return {
      templates: [
        {
          id: 't-india',
          name: 'India day',
          ...SHIFT,
          effective_from: '2026-10-01',
          retired: false,
          next: null,
          people: 14,
        },
        {
          id: 't-us',
          name: 'US Eastern overlap with a long name',
          days: [1, 2, 3, 4, 5],
          start: '18:30',
          end: '03:30',
          tz_iana: 'Asia/Kolkata',
          effective_from: '2026-10-01',
          retired: false,
          next: null,
          people: 9,
        },
      ],
      custom: 3,
      none: 2,
    };
  }
  if (p === '/v1/admin/office-days')
    return { people: PEOPLE.map((x) => ({ employee_id: x.id, weekdays: [], days: [] })) };
  if (p === '/v1/admin/departments') return { departments: [] };
  if (p === '/v1/admin/policy/global') return { override: null, effective: { policy: {} } };
  if (p === '/v1/admin/devices') return { devices: [] };
  if (p === '/v1/holidays') return { holidays: [] };
  return null;
}

/** Answer the app's config and every `/v1/…` call for this page. */
export async function mockApi(page: Page, capabilities: readonly string[] = ADMIN): Promise<void> {
  await page.route('**/app/config.json', (r: Route) =>
    r.fulfill({ json: { tenantId: 'e2e', clientId: 'e2e', apiScope: 'api://e2e/api.access' } }),
  );
  await page.route('**/brand/**', (r: Route) => r.fulfill({ status: 404, body: '' }));
  await page.route('**/v1/**', (r: Route) => {
    const req = r.request();
    if (req.method() !== 'GET') return r.fulfill({ json: {} });
    const body = answer(new URL(req.url()).pathname + new URL(req.url()).search, capabilities);
    return body === null
      ? r.fulfill({
          status: 404,
          contentType: 'application/problem+json',
          json: { code: 'not_found', message: 'not in the test API' },
        })
      : r.fulfill({ json: body });
  });
}

/** True when the page itself scrolls sideways (item 6: it never should). */
export async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}
