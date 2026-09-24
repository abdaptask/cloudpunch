import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AuthStatus } from './api.js';

/**
 * Sign-in state: fetched on mount, kept fresh from `cp://auth` (the
 * silent start-up restore may finish after the window opens).
 *
 * Signing in again while a sign-in is waiting (e.g. the browser tab was
 * closed) restarts it: the agent cancels the old attempt, and its
 * "cancelled" result is ignored here — only the newest attempt's result
 * counts.
 */
export function useAuth(): {
  auth: AuthStatus | null;
  busy: boolean;
  error: string | null;
  signIn: () => void;
  cancelSignIn: () => void;
  signOut: () => void;
} {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

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
    const id = ++latest.current;
    setError(null);
    setBusy(true);
    command().then(
      (s) => {
        if (id !== latest.current) return;
        setAuth(s);
        setBusy(false);
      },
      (e: unknown) => {
        if (id !== latest.current) return;
        const code = String(e);
        setError(code === 'cancelled' ? null : code);
        setBusy(false);
      },
    );
  }, []);

  const cancelSignIn = useCallback((): void => {
    latest.current++;
    setBusy(false);
    setError(null);
    void api.cancelSignIn();
  }, []);

  return {
    auth,
    busy,
    error,
    signIn: useCallback(() => act(api.signIn), [act]),
    cancelSignIn,
    signOut: useCallback(() => act(api.signOut), [act]),
  };
}
