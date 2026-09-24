import { useCallback, useEffect, useState } from 'react';
import { api, type StateView } from './api.js';

/**
 * Current agent state: fetched once on mount, then kept fresh from
 * `cp://state`. `run` invokes a command and adopts the view it
 * returns; a rejection lands in `error` instead.
 */
export function useAgentState(): {
  view: StateView | null;
  error: string | null;
  run: (command: () => Promise<StateView>) => void;
} {
  const [view, setView] = useState<StateView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const adopt = (v: StateView): void => {
      if (active) setView(v);
    };
    api.getState().then(adopt, (e: unknown) => active && setError(String(e)));
    const unlisten = api.onState(adopt);
    return () => {
      active = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  const run = useCallback((command: () => Promise<StateView>): void => {
    setError(null);
    command().then(setView, (e: unknown) => setError(String(e)));
  }, []);

  return { view, error, run };
}
