import { useEffect, useState } from 'react';
import { api, type DeviceRow } from '../api.js';
import { Button } from '../ui/Button.js';
import { useTheme } from '../ui/theme.js';
import { computersCsv, computersCsvName, peopleBehind, type Latest } from './computersModel.js';
import { compareVersions, versionSummary } from './versions.js';
import { DataTable, input, Notice } from './DataTable.js';
import { EmailToUpdate } from './EmailToUpdate.js';
import { PushUpdate } from './PushUpdate.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: "Your role can't see computers.",
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/** "12 Oct 14:05", in this computer's zone. */
function seen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/**
 * Computers in the admin console (ADR-0025 §3, ADR-0038 §9): each
 * computer, its owner, system and the CloudPunch version it last sent
 * time with, as a table. "Behind only" shows the ones auto-update
 * hasn't reached (ADR-0022).
 */
export function ComputersPage({ canPush = false }: { canPush?: boolean }): JSX.Element {
  const t = useTheme();
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [os, setOs] = useState<'' | DeviceRow['os']>('');
  const [behindOnly, setBehindOnly] = useState(false);
  const [q, setQ] = useState('');
  const [latest, setLatest] = useState<Latest | null>(null);
  const [emailing, setEmailing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    api.adminUpdatesLatest().then(setLatest, () => setLatest(null));
  }, []);
  useEffect(() => {
    let current = true;
    api.adminDevices().then(
      (r) => {
        if (current) setDevices(r.devices.filter((d) => d.revoked_at === null));
      },
      (e: unknown) => {
        if (current) setError(errorText(String(e)));
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
  const behind = (d: DeviceRow): boolean => !!newest && compareVersions(d.app_version, newest) < 0;
  const rows = (devices ?? []).filter((d) => (!os || d.os === os) && (!behindOnly || behind(d)));
  const searchText = (d: DeviceRow): string => `${d.display_name} ${d.work_email}`;
  // Export CSV: the rows as shown (system, behind only and the search).
  const exportCsv = async (): Promise<void> => {
    const needle = q.trim().toLowerCase();
    const shown = rows
      .filter((d) => !needle || searchText(d).toLowerCase().includes(needle))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
    try {
      setSaved(
        `Saved ${await api.saveCsv(computersCsvName(new Date()), computersCsv(shown, latest))}`,
      );
    } catch (e) {
      setError(errorText(String(e)));
    }
  };
  // Versions sort as numbers: 0.1.9 before 0.1.10.
  const versionKey = (v: string): string =>
    v
      .split('.')
      .map((n) => n.padStart(6, '0'))
      .join('.');

  return (
    <section aria-label="computers" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Computers</h2>
      <Notice
        notice={error ? { kind: 'error', text: error } : null}
        onDismiss={() => setError(null)}
      />
      {!devices && !error && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}
      {devices && <PushUpdate behind={devices.filter(behind).length} canPush={canPush} />}
      {devices && emailing && (
        <EmailToUpdate people={peopleBehind(devices, latest)} onClose={() => setEmailing(false)} />
      )}
      {devices && (
        <>
          <p aria-label="version-summary" style={{ margin: 0, fontSize: 13 }}>
            {devices.length === 0 ? 'No computers yet.' : versionSummary(devices)}
            {devices.some(behind) && (
              <span style={{ color: t.danger }}>
                {' '}
                · {devices.filter(behind).length} behind {newest}
              </span>
            )}
          </p>
          <DataTable
            label="computers-table"
            rows={rows}
            rowKey={(d) => d.device_id}
            search={searchText}
            query={q}
            onQueryChange={setQ}
            searchPlaceholder="Find a person or computer"
            initialSort={{ key: 'version', dir: 'asc' }}
            empty="No computers match."
            toolbar={
              <>
                <select
                  aria-label="filter-os"
                  value={os}
                  onChange={(e) => setOs(e.target.value as '' | DeviceRow['os'])}
                  style={input(t)}
                >
                  <option value="">Windows and Mac</option>
                  <option value="windows">Windows</option>
                  <option value="macos">Mac</option>
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    aria-label="behind-only"
                    checked={behindOnly}
                    onChange={(e) => setBehindOnly(e.target.checked)}
                  />
                  Behind only
                </label>
                <Button variant="chip" onClick={() => void exportCsv()}>
                  Export CSV
                </Button>
                {canPush && (
                  <Button variant="chip" onClick={() => setEmailing(true)}>
                    Email to update
                  </Button>
                )}
              </>
            }
            columns={[
              {
                key: 'name',
                label: 'Person',
                render: (d) => (
                  <>
                    {d.display_name}
                    <span style={{ display: 'block', fontSize: 11.5, color: t.muted }}>
                      {d.work_email}
                    </span>
                  </>
                ),
                sortText: (d) => d.display_name,
              },
              {
                key: 'os',
                label: 'System',
                nowrap: true,
                render: (d) => (d.os === 'windows' ? 'Windows' : 'macOS'),
                sortText: (d) => d.os,
              },
              {
                key: 'version',
                label: 'Version',
                nowrap: true,
                render: (d) => (
                  <span
                    style={{
                      color: behind(d) ? t.danger : t.text,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {d.app_version}
                    {behind(d) && ' · behind'}
                  </span>
                ),
                sortText: (d) => versionKey(d.app_version),
              },
              {
                key: 'seen',
                label: 'Last seen',
                nowrap: true,
                render: (d) => seen(d.last_seen_at),
                sortText: (d) => d.last_seen_at ?? '',
              },
            ]}
          />
          {saved && (
            <p role="status" style={{ margin: 0, fontSize: 12.5 }}>
              {saved}
            </p>
          )}
          <p style={{ margin: 0, fontSize: 11.5, color: t.muted }}>
            The version a computer last sent time events with. An app updates at its next sign-in
            while clocked out, or with Restart to update.
          </p>
        </>
      )}
    </section>
  );
}
