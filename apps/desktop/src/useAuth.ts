import { useCallback, useEffect, useState } from 'react';
import { api, type AuthStatus } from './api.js';

/**
 * Sign-in state: fetched on mount, kept fresh from `cp://auth` (the
 * silent start-up restore may finish after the window opens).
 */
export function useAuth(): {
  auth: AuthStatus | null;
  busy: boolean;
  error: string | null;
  signIn: () => void;
  signOut: () => void;
} {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const adopt = (s: AuthStatus): void => {
      if (active) setAuth(s);
    };
    api.authStatus().then(adopt, (e: unknown) => active && setError(String(e)));
    const unlisten = api.onAuth(adopt);
    return () => {
      active = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  const act = useCallback((command: () => Promise<AuthStatus>): void => {
    setError(null);
    setBusy(true);
    command()
      .then(setAuth, (e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  }, []);

  return {
    auth,
    busy,
    error,
    signIn: useCallback(() => act(api.signIn), [act]),
    signOut: useCallback(() => act(api.signOut), [act]),
  };
}
