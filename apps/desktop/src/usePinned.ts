import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * Whether the main window is the pinned mini strip (ADR-0017). Rust
 * owns the state: minimising pins it too, and sign-out unpins it, so
 * the page follows `cp://pinned` rather than keeping its own copy.
 */
export function usePinned(): {
  pinned: boolean;
  pin: () => void;
  unpin: () => void;
} {
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    let current = true;
    api.pinStatus().then(
      (p) => {
        if (current) setPinned(p);
      },
      () => undefined,
    );
    const off = api.onPinned((p) => setPinned(p));
    return () => {
      current = false;
      void off.then((fn) => fn());
    };
  }, []);
  const pin = useCallback(() => {
    api.pinWindow().then(setPinned, () => undefined);
  }, []);
  const unpin = useCallback(() => {
    api.unpinWindow().then(setPinned, () => undefined);
  }, []);
  return { pinned, pin, unpin };
}
