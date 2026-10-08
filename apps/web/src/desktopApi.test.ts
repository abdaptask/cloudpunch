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
});
