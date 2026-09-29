import { useEffect, useState, type CSSProperties } from 'react';
import { api, type DeviceRow } from './api.js';
import { useTheme, type Theme } from './ui/theme.js';

/** a > b for `x.y.z` versions; anything unparseable sorts first. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** "0.1.4 × 3 · 0.1.2 × 1", newest first. */
export function versionSummary(devices: readonly DeviceRow[]): string {
  const counts = new Map<string, number>();
  for (const d of devices) counts.set(d.app_version, (counts.get(d.app_version) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => compareVersions(b, a))
    .map(([v, n]) => `${v} × ${n}`)
    .join(' · ');
}

/**
 * Versions (ADR-0025 §3): which CloudPunch each computer runs, from the
 * events it sends. Useful to see auto-update reach everyone (ADR-0022).
 */
export function VersionsScreen({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useTheme();
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    api.adminDevices().then(
      (r) => {
        if (current) setDevices(r.devices.filter((d) => d.revoked_at === null));
      },
      (e: unknown) => {
        if (current) setError(String(e));
      },
    );
    return () => {
      current = false;
    };
  }, []);
  const newest = devices?.reduce<string | null>(
    (m, d) => (m === null || compareVersions(d.app_version, m) > 0 ? d.app_version : m),
    null,
  );
  const sorted = devices
    ? [...devices].sort(
        (a, b) =>
          compareVersions(a.app_version, b.app_version) ||
          a.display_name.localeCompare(b.display_name),
      )
    : [];
  return (
    <section aria-label="versions" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Versions</h2>
        <button type="button" onClick={onClose} style={link(t)}>
          Done
        </button>
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger }}>
          {error === 'offline'
            ? "Can't reach CloudPunch right now."
            : `Something went wrong (${error}).`}
        </p>
      )}
      {!devices && !error && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}
      {devices && (
        <>
          <p aria-label="version-summary" style={{ margin: 0, fontSize: 13 }}>
            {devices.length === 0 ? 'No computers yet.' : versionSummary(devices)}
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {sorted.map((d) => {
              const behind =
                newest !== null &&
                newest !== undefined &&
                compareVersions(d.app_version, newest) < 0;
              return (
                <li
                  key={d.device_id}
                  style={{
                    display: 'flex',
                    gap: 8,
                    padding: '6px 0',
                    borderBottom: `1px solid ${t.border}`,
                    fontSize: 13,
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {d.display_name}
                    <span style={{ display: 'block', fontSize: 11, color: t.muted }}>
                      {d.os === 'windows' ? 'Windows' : 'macOS'}
                      {d.last_seen_at &&
                        ` · last seen ${new Date(d.last_seen_at).toLocaleString()}`}
                    </span>
                  </span>
                  <span
                    style={{
                      color: behind ? t.danger : t.text,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {d.app_version}
                    {behind && ' · behind'}
                  </span>
                </li>
              );
            })}
          </ul>
          <p style={{ margin: 0, fontSize: 11, color: t.muted }}>
            The version a computer last sent time events with. An app updates at its next sign-in
            while clocked out, or with Restart to update.
          </p>
        </>
      )}
    </section>
  );
}

function link(t: Theme): CSSProperties {
  return {
    padding: 0,
    border: 'none',
    background: 'none',
    color: t.accent,
    font: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
  };
}
