import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useTheme } from '../ui/theme.js';
import { AdminConsole } from './AdminConsole.js';

/**
 * The desktop's admin window (ADR-0038 §2): the console, with the
 * signed-in person's capabilities. The agent closes this window at
 * sign-out; "Done" closes it too.
 */
export function AdminWindow(): JSX.Element {
  const t = useTheme();
  // undefined: loading; null: couldn't ask.
  const [capabilities, setCapabilities] = useState<string[] | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    api.myCapabilities().then(
      (c) => {
        if (current) setCapabilities(c);
      },
      () => {
        if (current) setCapabilities(null);
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const close = (): void => {
    api.closeAdminWindow().catch(() => undefined);
  };

  if (capabilities === undefined || capabilities === null) {
    return (
      <p role={capabilities === null ? 'alert' : 'status'} style={{ margin: 24, fontSize: 13 }}>
        {capabilities === null ? (
          <span style={{ color: t.danger }}>
            Can&apos;t load your CloudPunch role. Check you&apos;re signed in, then open the admin
            console again.
          </span>
        ) : (
          <span style={{ color: t.muted }}>Loading…</span>
        )}
      </p>
    );
  }
  return <AdminConsole capabilities={capabilities} onClose={close} />;
}
