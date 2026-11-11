import { useEffect, useRef, type MutableRefObject } from 'react';

/** Which part to open at, from the table's action icons (ADR-0054). */
export type PanelFocus =
  'roles' | 'history' | 'welcome' | 'deactivate' | 'reactivate' | 'tellManager';

const FOCUS_PART: Record<PanelFocus, string> = {
  roles: 'Roles',
  history: 'Time history',
  welcome: 'Welcome email',
  deactivate: 'Leaving ApTask',
  reactivate: 'Reactivate',
  tellManager: 'Tell manager',
};

/** Scrolls the panel's part for `focus` into view once it's there. */
export function useFocusPart(
  focus: PanelFocus | null | undefined,
): MutableRefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!focus || !ref.current) return;
    const part = ref.current.querySelector(`[aria-label="${FOCUS_PART[focus]}"]`);
    if (part instanceof HTMLElement && typeof part.scrollIntoView === 'function') {
      part.scrollIntoView({ block: 'nearest' });
    }
  }, [focus]);
  return ref;
}
