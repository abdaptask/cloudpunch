import {
  BrowserAuthError,
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser';

/**
 * Microsoft sign-in for the web dashboard (ADR-0033 §3): the CloudPunch
 * Web SPA registration, PKCE, tokens in memory only. MSAL can't do a
 * full-page redirect with in-memory tokens (`in_mem_redirect_unavailable`),
 * so sign-in is a popup. After a reload, a silent sign-in from the
 * Microsoft session brings the account back; only the sign-in name is
 * kept (sessionStorage) as the hint for that.
 */

/** From `/app/config.json` (the server's env; nothing secret). */
export interface WebConfig {
  tenantId: string;
  clientId: string;
  apiScope: string;
}

export interface Auth {
  readonly account: AccountInfo | null;
  /** The Microsoft popup; resolves with `account` set, or unset if the person closed it. */
  signIn: () => Promise<void>;
  /** Forgets the tokens here; the Microsoft session itself stays. */
  signOut: () => Promise<void>;
  /** An API access token, renewed silently; a popup if Microsoft insists. */
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
  const use = (a: AccountInfo | null): void => {
    account = a;
    pca.setActiveAccount(a);
    writeHint(a?.username ?? null);
  };
  if (account) use(account);

  return {
    get account() {
      return account;
    },
    signIn: async () => {
      try {
        use((await pca.loginPopup({ scopes, prompt: 'select_account' })).account);
      } catch (e) {
        // Closing the popup isn't an error; the button stays there.
        if (e instanceof BrowserAuthError && e.errorCode === 'user_cancelled') return;
        throw e;
      }
    },
    signOut: async () => {
      await pca.clearCache();
      use(null);
    },
    token: async () => {
      if (!account) throw new Error('not signed in');
      try {
        return (await pca.acquireTokenSilent({ scopes, account })).accessToken;
      } catch (e) {
        if (!(e instanceof InteractionRequiredAuthError)) throw e;
        return (await pca.acquireTokenPopup({ scopes, account })).accessToken;
      }
    },
  };
}
