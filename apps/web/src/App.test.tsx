import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App, type AppDeps, type Me } from './App.js';
import { isAuthResponse, type Auth } from './auth.js';

const CONFIG = {
  tenantId: 'a6300e5c-dae4-413c-a6d2-646fbc2aa587',
  clientId: 'c0d42233-0f69-4379-9956-f6f7e48a5278',
  apiScope: 'api://63bca00e-a546-4f0c-a076-e2450e52406e/api.access',
};

const NILESH = { username: 'nilesh@aptask.com', name: 'Nilesh' } as Auth['account'];

/** Like the real one: the popup sets `account`, sign-out clears it. */
function fakeAuth(signedIn: boolean): Auth {
  const auth = {
    account: signedIn ? NILESH : null,
    signIn: vi.fn(async () => {
      auth.account = NILESH;
    }),
    signOut: vi.fn(async () => {
      auth.account = null;
    }),
    token: vi.fn(async () => 'tok'),
  };
  return auth;
}

const ROSHNI = {
  employee_id: '2b9f6c1e-4d1a-4c3e-9a57-0d3c1f2e8a41',
  name: 'Roshni K',
  status: 'working',
  kind: 'working',
  since: new Date(Date.now() - 3_600_000).toISOString(),
  back_by: null,
  worked_ms: 3_600_000,
};

const QUEUE = {
  to_approve: [],
  to_endorse: [
    {
      employee_id: ROSHNI.employee_id,
      name: 'Roshni K',
      date: '2026-10-07',
      correction: {
        id: '7d2c0b1e-5f3a-4e8b-9c41-2a6d8e0f1b23',
        from: '2026-10-07T09:00:00.000+05:30',
        to: '2026-10-07T18:00:00.000+05:30',
        kind: 'working',
        reason: 'Forgot to clock in',
        status: 'requested',
        requested_by: 'Roshni K',
        requested_at: '2026-10-07T13:00:00Z',
        decisions: [],
      },
    },
  ],
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const me = (capabilities: string[]): Me => ({
  user: { display_name: 'Nilesh D', work_email: 'nilesh@aptask.com' },
  capabilities,
});

function deps(
  auth: Auth,
  meRes: Response | null,
  configStatus = 200,
): AppDeps & {
  fetch: ReturnType<typeof vi.fn>;
} {
  const fetchFn = vi.fn(async (url: string) => {
    if (url === '/app/config.json') return json(configStatus, CONFIG);
    if (url === '/v1/me' && meRes) return meRes;
    if (url === '/v1/team') return json(200, { people: [ROSHNI] });
    if (url === '/v1/corrections/queue') return json(200, QUEUE);
    if (url === `/v1/corrections/${QUEUE.to_endorse[0]?.correction.id}/decision`)
      return json(200, { correction: { ...QUEUE.to_endorse[0]?.correction, status: 'endorsed' } });
    return json(404, {});
  });
  return {
    fetch: fetchFn as unknown as typeof fetch & ReturnType<typeof vi.fn>,
    startAuth: vi.fn(async () => auth),
  };
}

describe('web dashboard shell (ADR-0033)', () => {
  it('signed out: the Microsoft popup signs a manager in without a reload', async () => {
    const auth = fakeAuth(false);
    const d = deps(auth, json(200, me(['team.timeline.read'])));
    render(<App deps={d} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Microsoft' }));
    expect(auth.signIn).toHaveBeenCalledOnce();
    expect(d.startAuth).toHaveBeenCalledWith(CONFIG);
    expect(await screen.findByText('Roshni K')).toBeInTheDocument();
    expect(d.startAuth).toHaveBeenCalledOnce();
  });

  it('closing the popup leaves the sign-in button', async () => {
    const auth = fakeAuth(false);
    vi.mocked(auth.signIn).mockResolvedValueOnce(undefined);
    render(<App deps={deps(auth, null)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Microsoft' }));
    expect(
      await screen.findByRole('button', { name: 'Sign in with Microsoft' }),
    ).toBeInTheDocument();
  });

  it('a failed sign-in is shown, not swallowed', async () => {
    const auth = fakeAuth(false);
    vi.mocked(auth.signIn).mockRejectedValueOnce(new Error('popup_window_error'));
    render(<App deps={deps(auth, null)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Microsoft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('popup_window_error');
  });

  it("a manager sees the desktop's Team screen, each call carrying the token", async () => {
    const d = deps(fakeAuth(true), json(200, me(['team.timeline.read', 'self.timeline.read'])));
    render(<App deps={d} />);
    const today = await screen.findByRole('list', { name: 'team-today' });
    expect(within(today).getByText('Roshni K')).toBeInTheDocument();
    expect(screen.getByText('Nilesh D')).toBeInTheDocument();
    // Nothing to go back to on the web: no "Done".
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
    for (const path of ['/v1/me', '/v1/team']) {
      const call = d.fetch.mock.calls.find(([u]) => String(u) === path);
      expect((call?.[1] as RequestInit).headers).toEqual({ authorization: 'Bearer tok' });
    }
    // HR (no team.connection.read, no team.correction.review): neither call.
    for (const path of ['/v1/team/connections', '/v1/corrections/queue']) {
      expect(d.fetch.mock.calls.some(([u]) => String(u) === path)).toBe(false);
    }
  });

  it('a manager endorses a correction from the web', async () => {
    const d = deps(fakeAuth(true), json(200, me(['team.timeline.read', 'team.correction.review'])));
    render(<App deps={d} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByLabelText('correction Roshni K')).toHaveTextContent(
      'Forgot to clock in',
    );
    expect(screen.queryByText(/open the CloudPunch app/)).not.toBeInTheDocument();
    const queueCalls = (): number =>
      d.fetch.mock.calls.filter(([u]) => String(u) === '/v1/corrections/queue').length;
    const before = queueCalls();
    await userEvent.click(screen.getByRole('button', { name: 'Endorse' }));
    const post = d.fetch.mock.calls.find(([u]) => String(u).endsWith('/decision'));
    expect(post?.[1]).toEqual({
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'endorse' }),
    });
    // The queue reloads after a decision.
    await vi.waitFor(() => expect(queueCalls()).toBeGreaterThan(before));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('list', { name: 'team-today' })).toBeInTheDocument();
  });

  it('signing out of the dashboard goes back to the sign-in button', async () => {
    const auth = fakeAuth(true);
    render(<App deps={deps(auth, json(200, me(['team.timeline.read'])))} />);
    await screen.findByText('Roshni K');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(auth.signOut).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole('button', { name: 'Sign in with Microsoft' }),
    ).toBeInTheDocument();
  });

  it('an employee without team access is pointed to the app', async () => {
    const auth = fakeAuth(true);
    render(<App deps={deps(auth, json(200, me(['self.timeline.read'])))} />);
    expect(
      await screen.findByText(/CloudPunch on the web is for managers and HR/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Hello/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(auth.signOut).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole('button', { name: 'Sign in with Microsoft' }),
    ).toBeInTheDocument();
  });

  it('someone with no CloudPunch record is told to ask HR', async () => {
    render(<App deps={deps(fakeAuth(true), json(403, { code: 'no_user_for_oid' }))} />);
    expect(await screen.findByText(/isn't set up in CloudPunch yet/)).toBeInTheDocument();
  });

  it('a server without the web settings says so', async () => {
    render(<App deps={deps(fakeAuth(false), null, 503)} />);
    expect(await screen.findByText(/isn't set up on this server yet/)).toBeInTheDocument();
  });

  it('spots Microsoft returning a sign-in', () => {
    expect(isAuthResponse({ hash: '#code=abc&state=xyz', search: '' })).toBe(true);
    expect(isAuthResponse({ hash: '#error=access_denied&state=xyz', search: '' })).toBe(true);
    expect(isAuthResponse({ hash: '', search: '?code=abc&state=xyz' })).toBe(true);
    expect(isAuthResponse({ hash: '', search: '' })).toBe(false);
    expect(isAuthResponse({ hash: '#team', search: '' })).toBe(false);
  });
});
