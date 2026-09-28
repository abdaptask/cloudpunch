import { AppRole } from '@cloudpunch/shared';
import { exportPKCS8, generateKeyPair, decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { createGraph, GraphError } from './graph.js';
import { graphTokenOnBehalfOf, OboError } from './obo.js';

const API_APP = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const SP = 'sp-1';
const ROLE_IDS = { Employee: 'r-emp', Administrator: 'r-adm' };

/** A fetch that answers from a route table and records calls. */
function fakeFetch(routes: Record<string, (init: RequestInit) => [number, unknown]>) {
  const calls: { method: string; url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ method, url, init });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    const [status, body] = key ? routes[key]!(init) : [404, { error: { code: 'nope' } }];
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

const BASE = 'https://graph.test/v1.0';
const spRoute = {
  [`GET ${BASE}/servicePrincipals(appId='${API_APP}')`]: (): [number, unknown] => [
    200,
    {
      id: SP,
      appRoles: [
        { id: ROLE_IDS.Employee, value: 'Employee' },
        { id: ROLE_IDS.Administrator, value: 'Administrator' },
        { id: 'r-old', value: 'Retired' },
      ],
    },
  ],
};

describe('Graph client (ADR-0020)', () => {
  it('lists user assignments with role values, following pages', async () => {
    const { fn } = fakeFetch({
      ...spRoute,
      [`GET ${BASE}/servicePrincipals/${SP}/appRoleAssignedTo?$top=999`]: () => [
        200,
        {
          value: [
            {
              id: 'a1',
              principalId: 'u1',
              principalType: 'User',
              principalDisplayName: 'A',
              appRoleId: ROLE_IDS.Employee,
            },
            {
              id: 'g1',
              principalId: 'grp',
              principalType: 'Group',
              principalDisplayName: 'G',
              appRoleId: ROLE_IDS.Employee,
            },
            {
              id: 'a2',
              principalId: 'u2',
              principalType: 'User',
              principalDisplayName: 'B',
              appRoleId: 'r-old',
            },
          ],
          '@odata.nextLink': `${BASE}/servicePrincipals/${SP}/appRoleAssignedTo?$skiptoken=x`,
        },
      ],
      [`GET ${BASE}/servicePrincipals/${SP}/appRoleAssignedTo?$skiptoken=x`]: () => [
        200,
        {
          value: [
            {
              id: 'a3',
              principalId: 'u3',
              principalType: 'User',
              principalDisplayName: 'C',
              appRoleId: ROLE_IDS.Administrator,
            },
          ],
        },
      ],
    });
    const g = createGraph({ token: 't', apiAppId: API_APP, fetch: fn, base: BASE });
    expect(await g.listAssignments()).toEqual([
      { id: 'a1', oid: 'u1', name: 'A', role: AppRole.Employee },
      { id: 'a3', oid: 'u3', name: 'C', role: AppRole.Administrator },
    ]);
  });

  it('assigns by role id and removes by assignment id, with the bearer token', async () => {
    const { fn, calls } = fakeFetch({
      ...spRoute,
      [`POST ${BASE}/servicePrincipals/${SP}/appRoleAssignedTo`]: () => [201, { id: 'new' }],
      [`DELETE ${BASE}/servicePrincipals/${SP}/appRoleAssignedTo/a1`]: () => [204, null],
    });
    const g = createGraph({ token: 'user-graph-token', apiAppId: API_APP, fetch: fn, base: BASE });
    await g.assign('u9', AppRole.Administrator);
    await g.unassign('a1');
    const post = calls.find((c) => c.method === 'POST');
    expect(JSON.parse(post?.init.body as string)).toEqual({
      principalId: 'u9',
      resourceId: SP,
      appRoleId: ROLE_IDS.Administrator,
    });
    expect((post?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer user-graph-token',
    );
    await expect(g.assign('u9', AppRole.Payroll)).rejects.toMatchObject({ code: 'unknown_role' });
  });

  it('searches with ConsistencyLevel and strips quotes; Graph errors carry status', async () => {
    const { fn, calls } = fakeFetch({
      [`GET ${BASE}/users?$search=`]: () => [
        200,
        {
          value: [
            {
              id: 'u1',
              displayName: 'Farheen Khanam',
              givenName: 'Farheen',
              surname: 'Khanam',
              mail: 'farheen@aptask.com',
            },
          ],
        },
      ],
      [`GET ${BASE}/users/missing`]: () => [404, { error: { code: 'Request_ResourceNotFound' } }],
      [`GET ${BASE}/users/denied`]: () => [403, { error: { code: 'Authorization_RequestDenied' } }],
    });
    const g = createGraph({ token: 't', apiAppId: API_APP, fetch: fn, base: BASE });
    expect(await g.searchUsers('Far"heen')).toEqual([
      {
        oid: 'u1',
        name: 'Farheen Khanam',
        email: 'farheen@aptask.com',
        givenName: 'Farheen',
        surname: 'Khanam',
      },
    ]);
    expect(calls[0]?.url).not.toContain('%22heen');
    expect((calls[0]?.init.headers as Record<string, string>)['ConsistencyLevel']).toBe('eventual');
    expect(await g.getUser('missing')).toBeNull();
    await expect(g.getUser('denied')).rejects.toBeInstanceOf(GraphError);
    expect(await g.searchUsers(' a ')).toEqual([]);
  });
});

describe('on-behalf-of exchange (ADR-0020 §2)', () => {
  it('signs a certificate assertion and trades the user token for a Graph token', async () => {
    const kp = await generateKeyPair('RS256', { extractable: true });
    const pem = await exportPKCS8(kp.privateKey);
    let form: URLSearchParams | null = null;
    const fn = (async (_url: string | URL, init: RequestInit = {}) => {
      form = new URLSearchParams(init.body as string);
      return new Response(JSON.stringify({ access_token: 'graph-token' }), { status: 200 });
    }) as typeof fetch;
    const token = await graphTokenOnBehalfOf(
      {
        tenantId: 'tid',
        clientId: API_APP,
        privateKeyPem: pem,
        thumbprint: 'thumb',
        fetch: fn,
        authority: 'https://login.test',
      },
      'user-token',
    );
    expect(token).toBe('graph-token');
    const f = form as unknown as URLSearchParams;
    expect(f.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(f.get('requested_token_use')).toBe('on_behalf_of');
    expect(f.get('assertion')).toBe('user-token');
    expect(f.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(f.get('client_secret')).toBeNull();
    const assertion = f.get('client_assertion') ?? '';
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: 'RS256', x5t: 'thumb' });
    const { payload } = await jwtVerify(assertion, kp.publicKey, {
      audience: 'https://login.test/tid/oauth2/v2.0/token',
      issuer: API_APP,
    });
    expect(payload.sub).toBe(API_APP);
  });

  it('names missing consent', async () => {
    const kp = await generateKeyPair('RS256', { extractable: true });
    const fn = (async () =>
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS65001: consent' }),
        { status: 400 },
      )) as typeof fetch;
    await expect(
      graphTokenOnBehalfOf(
        {
          tenantId: 't',
          clientId: 'c',
          privateKeyPem: await exportPKCS8(kp.privateKey),
          thumbprint: 'x',
          fetch: fn,
        },
        'u',
      ),
    ).rejects.toEqual(
      new OboError('consent_required', 'admin consent for Microsoft Graph is missing'),
    );
  });
});
