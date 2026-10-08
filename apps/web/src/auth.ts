import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser';

/**
 * Microsoft sign-in for the web dashboard (ADR-0033 §3): the CloudPunch
 * Web SPA registration, redirect flow with PKCE, tokens in memory only.
 * After a reload, a silent sign-in from the Microsoft session brings
 * the account back; only the sign-in name is kept (sessionStorage) as
 * the hint for that.
 */

/** From `/app/config.json` (the server's env; nothing secret). */
export interface WebConfig {
  tenantId: string;
  clientId: string;
  apiScope: string;
}

export interface Auth {
  account: AccountInfo | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** An API access token, renewed silently; a redirect if Microsoft insists. */
  token: () => Promise<string>;
}

const HINT = 'cloudpunch.web.signin';

function readHint(): string | null {
  try {
    return sessionStorage.getItem(HINT);
  } catch {
    return null;
  }
}

function writeHint(name: string | null): void {
  try {
    if (name) sessionStorage.setItem(HINT, name);
    else sessionStorage.removeItem(HINT);
  } catch {
    // Storage blocked: the person signs in again after a reload.
  }
}

/** True when this page load is Microsoft returning a sign-in response. */
export function isAuthResponse(loc: Pick<Location, 'hash' | 'search'>): boolean {
  const params = new URLSearchParams(loc.hash.replace(/^#/, '') || loc.search);
  return params.has('state') && (params.has('code') || params.has('error'));
}

export async function startAuth(cfg: WebConfig): Promise<Auth> {
  const home = `${window.location.origin}/app/`;
  const pca = new PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: home,
      postLogoutRedirectUri: home,
    },
    cache: { cacheLocation: 'memoryStorage' },
  });
  await pca.initialize();
  const scopes = [cfg.apiScope];

  const result = await pca.handleRedirectPromise();
  let account: AccountInfo | null = result?.account ?? pca.getAllAccounts()[0] ?? null;
  const hint = readHint();
  if (!account && hint) {
    try {
      account = (await pca.ssoSilent({ scopes, loginHint: hint })).account;
    } catch {
      writeHint(null);
    }
  }
  if (account) {
    pca.setActiveAccount(account);
    writeHint(account.username);
  }

  return {
    account,
    signIn: () => pca.loginRedirect({ scopes, prompt: 'select_account' }),
    signOut: () => {
      writeHint(null);
      return pca.logoutRedirect({ account });
    },
    token: async () => {
      if (!account) throw new Error('not signed in');
      try {
        return (await pca.acquireTokenSilent({ scopes, account })).accessToken;
      } catch (e) {
        if (e instanceof InteractionRequiredAuthError) {
          await pca.acquireTokenRedirect({ scopes, account });
        }
        throw e;
      }
    },
  };
}
