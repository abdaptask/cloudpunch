import { render, screen } from '@testing-library/react';
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
    expect(await screen.findByText('Hello, Nilesh D')).toBeInTheDocument();
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

  it('a manager gets in, and the API call carries the token', async () => {
    const d = deps(fakeAuth(true), json(200, me(['team.timeline.read', 'self.timeline.read'])));
    render(<App deps={d} />);
    expect(await screen.findByText('Hello, Nilesh D')).toBeInTheDocument();
    const call = d.fetch.mock.calls.find(([u]) => String(u) === '/v1/me');
    expect((call?.[1] as RequestInit).headers).toEqual({ authorization: 'Bearer tok' });
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
