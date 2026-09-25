import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { DayResult } from './dayHistory.js';

export type DayState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: DayResult }
  | { status: 'error'; code: string };

/** A past working day from the agent (ADR-0016); idle when `date` is null. */
export function useDay(date: string | null): DayState {
  const [state, setState] = useState<DayState>({ status: 'idle' });
  useEffect(() => {
    if (date === null) {
      setState({ status: 'idle' });
      return;
    }
    let current = true;
    setState({ status: 'loading' });
    api.getDay(date).then(
      (result) => {
        if (current) setState({ status: 'ready', result });
      },
      (e: unknown) => {
        if (current) setState({ status: 'error', code: typeof e === 'string' ? e : 'internal' });
      },
    );
    return () => {
      current = false;
    };
  }, [date]);
  return state;
}
