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
 * Managers decide corrections here too (ADR-0033, amended 2026-10-08);
 * everything else that changes data refuses with `view_only` before
 * sending anything.
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
  | 'requestCorrection'
  | 'correctionsQueue'
  | 'decideCorrection'
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

async function send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
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
        ? { headers: { authorization: `Bearer ${token}` } }
        : {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
  } catch {
    throw refuse('offline');
  }
  if (res.ok) return (await res.json()) as T;
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
};
