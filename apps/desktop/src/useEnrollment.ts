import { useEffect, useState } from 'react';
import { api, type EnrollmentStatus } from './api.js';

/**
 * Device enrollment state (2b.4 F3b): fetched on mount, kept fresh
 * from `cp://enrollment` (enrollment runs after sign-in, off the UI
 * thread, and retries while offline).
 */
export function useEnrollment(): EnrollmentStatus | null {
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);

  useEffect(() => {
    let active = true;
    const adopt = (s: EnrollmentStatus): void => {
      if (active) setStatus(s);
    };
    api.enrollmentStatus().then(adopt, () => undefined);
    const unlisten = api.onEnrollment(adopt);
    return () => {
      active = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  return status;
}
