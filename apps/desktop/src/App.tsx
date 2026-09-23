import { getVersion } from '@tauri-apps/api/app';
import { useEffect, useState } from 'react';

/**
 * Phase 2b.1 scaffold. Just proves the round-trip:
 *   - React renders inside the Tauri webview
 *   - Tauri API call succeeds (returns the app version from the Rust
 *     side of the process)
 *
 * Real UI (login, clock-in tray flow, idle prompt window) lands in
 * later slices.
 */
export function App(): JSX.Element {
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then((v) => setVersion(v))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <main
      style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        padding: 24,
        color: '#111',
      }}
    >
      <h1 style={{ marginTop: 0 }}>CloudPunch</h1>
      <p>Phase 2b.1 scaffold — desktop agent shell.</p>
      {version && (
        <p>
          Version reported by Tauri: <code>{version}</code>
        </p>
      )}
      {error && (
        <p style={{ color: 'crimson' }}>
          Failed to read version: <code>{error}</code>
        </p>
      )}
    </main>
  );
}
