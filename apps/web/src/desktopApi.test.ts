import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRefusal, connectApi } from './desktopApi.js';

/** The rejection the screens see: `String(e)` is the code. */
const code = (c: string): ApiRefusal => new ApiRefusal(c);

const ID = '2b9f6c1e-4d1a-4c3e-9a57-0d3c1f2e8a41';

function connect(res: Response | Error): ReturnType<typeof vi.fn> {
  const fetchFn = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res.clone();
  });
  connectApi({ fetch: fetchFn as unknown as typeof fetch, token: async () => 'tok' });
  return fetchFn;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the browser api for the desktop screens (ADR-0033 §5)', () => {
  afterEach(() => connectApi(null));

  it('makes the same /v1 requests as the desktop core, with the token', async () => {
    const f = connect(json(200, { ok: true }));
    await api.teamNow();
    await api.teamDay(ID, '2026-10-08');
    await api.teamDays(ID, '2026-09-01', '2026-10-07');
    await api.teamExceptions('2026-10-02', '2026-10-08');
    await api.teamExceptions('2026-10-02', '2026-10-08', ID);
    await api.teamConnections();
    await api.personConnections(ID);
    await api.myConnections();
    await api.correctionsQueue();
    expect(f.mock.calls.map(([u]) => u as string)).toEqual([
      '/v1/team',
      `/v1/team/${ID}/days/2026-10-08`,
      `/v1/team/${ID}/days?from=2026-09-01&to=2026-10-07`,
      '/v1/team/exceptions?from=2026-10-02&to=2026-10-08',
      `/v1/team/exceptions?from=2026-10-02&to=2026-10-08&employee_id=${ID}`,
      '/v1/team/connections',
      `/v1/team/${ID}/connections`,
      '/v1/me/connections',
      '/v1/corrections/queue',
    ]);
    expect(f.mock.calls[0]?.[1]).toEqual({ headers: { authorization: 'Bearer tok' } });
  });

  it('refuses a bad id or date before sending', async () => {
    const f = connect(json(200, {}));
    await expect(api.teamDay('../admin', '2026-10-08')).rejects.toThrow(code('invalid_argument'));
    await expect(api.teamDays(ID, '2026-10-08', 'x')).rejects.toThrow(code('invalid_argument'));
    await expect(api.personConnections('1 OR 1')).rejects.toThrow(code('invalid_argument'));
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects with the desktop's codes", async () => {
    connect(json(404, { code: 'not_found' }));
    await expect(api.teamNow()).rejects.toThrow(code('not_found'));
    connect(json(403, {}));
    await expect(api.teamNow()).rejects.toThrow(code('http_403'));
    connect(json(401, {}));
    await expect(api.teamNow()).rejects.toThrow(code('sign_in_again'));
    connect(json(503, {}));
    await expect(api.teamNow()).rejects.toThrow(code('offline'));
    connect(new TypeError('Failed to fetch'));
    await expect(api.teamNow()).rejects.toThrow(code('offline'));
    connectApi(null);
    await expect(api.teamNow()).rejects.toThrow(code('sign_in_again'));
  });

  it('String() of a refusal is its code, as the screens read it', () => {
    expect(String(new ApiRefusal('not_found'))).toBe('not_found');
  });

  it('sends a decision as the desktop core does, note trimmed and optional', async () => {
    const f = connect(json(200, { correction: {} }));
    await api.decideCorrection(ID, 'reject', '  wrong day ');
    await api.decideCorrection(ID, 'approve', '   ');
    expect(
      (f.mock.calls as [string, RequestInit][]).map(([u, init]) => [u, init.method, init.body]),
    ).toEqual([
      [
        `/v1/corrections/${ID}/decision`,
        'POST',
        JSON.stringify({ decision: 'reject', note: 'wrong day' }),
      ],
      [`/v1/corrections/${ID}/decision`, 'POST', JSON.stringify({ decision: 'approve' })],
    ]);
    connect(json(409, { code: 'already_decided' }));
    await expect(api.decideCorrection(ID, 'endorse')).rejects.toThrow(code('already_decided'));
    await expect(api.decideCorrection('x', 'endorse')).rejects.toThrow(code('invalid_argument'));
  });

  it('asking for a correction stays in the app: refused without a request', async () => {
    const f = connect(json(200, {}));
    await expect(
      api.requestCorrection({
        employeeId: ID,
        from: '2026-10-08T09:00:00+05:30',
        to: '2026-10-08T18:00:00+05:30',
        tzIana: 'Asia/Kolkata',
        kind: 'working',
        reason: 'x',
      }),
    ).rejects.toThrow(code('view_only'));
    expect(f).not.toHaveBeenCalled();
  });

  it("makes the admin console's requests as the Rust core does (ADR-0038 §2)", async () => {
    const f = connect(json(200, {}));
    const DEV = '0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
    await api.adminPeople();
    await api.adminPeopleSearch('priya s&x');
    await api.adminPeopleSetRoles(ID, ['Employee', 'Manager'], '  new lead ');
    await api.adminWelcomePreview(ID);
    await api.adminWelcomeSend(ID, '');
    await api.adminEmployees();
    await api.adminSetManager(ID, DEV, '');
    await api.adminSetManager(ID, null, 'left');
    await api.adminActiveDevice(ID);
    await api.adminActiveDeviceSignOut(ID, DEV);
    await api.adminShifts();
    await api.adminSetShift(ID, {
      days: [1, 2],
      start: '09:00',
      end: '18:00',
      tzIana: 'Asia/Kolkata',
    });
    await api.holidays();
    await api.setHoliday('2026-10-20', 'Diwali');
    await api.removeHoliday('2026-10-20');
    await api.adminDepartments();
    await api.adminPolicyGet('global', null);
    await api.adminPolicyPut('department', DEV, { idle: {} }, 'pilot');
    await api.adminDevices();
    expect(
      (f.mock.calls as [string, RequestInit][]).map(([u, init]) => [
        init.method ?? 'GET',
        u,
        init.body ?? null,
      ]),
    ).toEqual([
      ['GET', '/v1/admin/people', null],
      ['GET', '/v1/admin/people/search?q=priya+s%26x', null],
      [
        'PUT',
        `/v1/admin/people/${ID}/roles`,
        JSON.stringify({ roles: ['Employee', 'Manager'], reason: 'new lead' }),
      ],
      ['GET', `/v1/admin/people/${ID}/welcome`, null],
      ['POST', `/v1/admin/people/${ID}/welcome`, JSON.stringify({})],
      ['GET', '/v1/admin/employees', null],
      ['PUT', `/v1/admin/employees/${ID}/manager`, JSON.stringify({ manager_employee_id: DEV })],
      [
        'PUT',
        `/v1/admin/employees/${ID}/manager`,
        JSON.stringify({ manager_employee_id: null, reason: 'left' }),
      ],
      ['GET', `/v1/people/${ID}/active-device`, null],
      ['POST', `/v1/people/${ID}/active-device/sign-out`, JSON.stringify({ device_id: DEV })],
      ['GET', '/v1/admin/shifts', null],
      [
        'PUT',
        `/v1/admin/employees/${ID}/shift`,
        JSON.stringify({ days: [1, 2], start: '09:00', end: '18:00', tz_iana: 'Asia/Kolkata' }),
      ],
      ['GET', '/v1/holidays', null],
      ['PUT', '/v1/admin/holidays/2026-10-20', JSON.stringify({ name: 'Diwali' })],
      ['DELETE', '/v1/admin/holidays/2026-10-20', null],
      ['GET', '/v1/admin/departments', null],
      ['GET', '/v1/admin/policy/global', null],
      [
        'PUT',
        `/v1/admin/policy/departments/${DEV}`,
        JSON.stringify({ document: { idle: {} }, reason: 'pilot' }),
      ],
      ['GET', '/v1/admin/devices', null],
    ]);
  });

  it('refuses bad admin ids, dates and scopes before sending', async () => {
    const f = connect(json(200, {}));
    const bad = code('invalid_argument');
    await expect(api.adminPeopleSetRoles('../x', [], '')).rejects.toThrow(bad);
    await expect(api.adminSetManager(ID, 'nobody', '')).rejects.toThrow(bad);
    await expect(api.adminActiveDeviceSignOut(ID, '1 OR 1')).rejects.toThrow(bad);
    await expect(api.removeHoliday('20 Oct')).rejects.toThrow(bad);
    await expect(api.adminPolicyGet('global', ID)).rejects.toThrow(bad);
    await expect(api.adminPolicyGet('department', null)).rejects.toThrow(bad);
    expect(f).not.toHaveBeenCalled();
  });

  it('an empty answer (204) is null, as in the desktop', async () => {
    connect(new Response(null, { status: 204 }));
    await expect(api.adminActiveDevice(ID)).resolves.toBeNull();
    await expect(api.removeHoliday('2026-10-20')).resolves.toBeNull();
  });

  it('sends the bulk changes with their key (ADR-0038 §5)', async () => {
    const f = connect(json(200, {}));
    const KEY = '22222222-2222-4222-8222-222222222222';
    await api.adminBulkManager(KEY, [ID], null, ' left ');
    await api.adminBulkRoles(KEY, [ID], { add: ['Manager'], remove: [] }, '');
    await api.adminBulkWelcome(KEY, [ID], 'Hi');
    expect(
      (f.mock.calls as [string, RequestInit][]).map(([u, init]) => [init.method, u, init.body]),
    ).toEqual([
      [
        'PUT',
        '/v1/admin/employees/bulk/manager',
        JSON.stringify({
          idempotency_key: KEY,
          employee_ids: [ID],
          manager_employee_id: null,
          reason: 'left',
        }),
      ],
      [
        'POST',
        '/v1/admin/people/bulk/roles',
        JSON.stringify({ idempotency_key: KEY, oids: [ID], add: ['Manager'], remove: [] }),
      ],
      [
        'POST',
        '/v1/admin/people/bulk/welcome',
        JSON.stringify({ idempotency_key: KEY, oids: [ID], note: 'Hi' }),
      ],
    ]);
  });

  it('named shifts: the same requests as the Rust core (ADR-0038 §6)', async () => {
    const f = connect(json(200, {}));
    const KEY = '22222222-2222-4222-8222-222222222222';
    const t = {
      name: 'India day',
      days: [1, 2],
      start: '09:00',
      end: '18:00',
      tzIana: 'Asia/Kolkata',
    };
    const body = {
      name: 'India day',
      days: [1, 2],
      start: '09:00',
      end: '18:00',
      tz_iana: 'Asia/Kolkata',
    };
    await api.adminShiftTemplates();
    await api.adminCreateShiftTemplate(t, ' new ');
    await api.adminSaveShiftTemplate(ID, t, '2026-10-19', '', true);
    await api.adminRetireShiftTemplate(ID, '');
    await api.adminSetNamedShift(ID, ID, null);
    await api.adminBulkShift(KEY, [ID], { templateId: ID }, '2026-10-19', '');
    expect(
      (f.mock.calls as [string, RequestInit][]).map(([u, init]) => [
        init.method ?? 'GET',
        u,
        init.body ?? null,
      ]),
    ).toEqual([
      ['GET', '/v1/admin/shift-templates', null],
      ['POST', '/v1/admin/shift-templates', JSON.stringify({ ...body, reason: 'new' })],
      [
        'PUT',
        `/v1/admin/shift-templates/${ID}`,
        JSON.stringify({ ...body, effective_from: '2026-10-19', dry_run: true }),
      ],
      ['POST', `/v1/admin/shift-templates/${ID}/retire`, JSON.stringify({})],
      ['PUT', `/v1/admin/employees/${ID}/shift`, JSON.stringify({ template_id: ID })],
      [
        'PUT',
        '/v1/admin/employees/bulk/shift',
        JSON.stringify({
          idempotency_key: KEY,
          employee_ids: [ID],
          template_id: ID,
          effective_from: '2026-10-19',
        }),
      ],
    ]);
    await expect(api.adminSaveShiftTemplate('../x', t, '2026-10-19', '')).rejects.toThrow(
      code('invalid_argument'),
    );
  });
});
