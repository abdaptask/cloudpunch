import { useEffect, useState } from 'react';

/** Below this width the admin console stacks for a phone (owner item 6, 2026-10-14). */
export const NARROW_PX = 720;

const query = (px: number): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(`(max-width: ${px}px)`)
    : null;

/**
 * True while the window is at most `px` wide: the web on a phone. The
 * desktop's admin window is wider, so it keeps its layout; without
 * `matchMedia` (tests) it's false.
 */
export function useNarrow(px: number = NARROW_PX): boolean {
  const [narrow, setNarrow] = useState(() => query(px)?.matches ?? false);
  useEffect(() => {
    const mq = query(px);
    if (!mq) return;
    const on = (): void => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [px]);
  return narrow;
}
