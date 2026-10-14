import { useEffect, useState, type CSSProperties } from 'react';
import { api, type TeamConnections } from '../api.js';
import { PersonConnections } from '../ConnectionsView.js';
import { placeOf, providerOf, seenOf } from '../connectionsModel.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { DataTable, Notice } from './DataTable.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: "Your role can't see connections.",
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

type Row = TeamConnections['people'][number];

/**
 * Connections in the admin console (ADR-0029 §5, ADR-0038 §9):
 * everyone's latest connection as a table; a row opens that person's
 * history beside it. The server decides who sees whom and audits each
 * history opened.
 */
export function ConnectionsPage(): JSX.Element {
  const t = useTheme();
  const [team, setTeam] = useState<TeamConnections | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Row | null>(null);
  useEffect(() => {
    let current = true;
    api.teamConnections().then(
      (r) => {
        if (current) setTeam(r);
      },
      (e: unknown) => {
        if (current) setError(errorText(String(e)));
      },
    );
    return () => {
      current = false;
    };
  }, []);
  const now = Date.now();

  return (
    <section aria-label="connections" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Connections</h2>
      <Notice
        notice={error ? { kind: 'error', text: error } : null}
        onDismiss={() => setError(null)}
      />
      {!team && !error && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}
      {team && !team.recording && (
        <p style={{ margin: 0, fontSize: 13, color: t.warnText }}>
          Recording is off. Turn it on in Rules, company-wide.
        </p>
      )}
      {team && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 480px', minWidth: 0 }}>
            <DataTable
              label="connections-table"
              rows={team.people}
              rowKey={(p) => p.employee_id}
              search={(p) => `${p.name} ${placeOf(p)} ${providerOf(p)}`}
              searchPlaceholder="Find a person, place or provider"
              initialSort={{ key: 'name', dir: 'asc' }}
              empty="No connections in the last 30 days."
              selected={open?.employee_id ?? null}
              onRowClick={(p) => setOpen(p)}
              columns={[
                {
                  key: 'name',
                  label: 'Name',
                  render: (p) => <strong style={{ fontWeight: 600 }}>{p.name}</strong>,
                  sortText: (p) => p.name,
                },
                {
                  key: 'place',
                  label: 'Place',
                  render: (p) => placeOf(p),
                  sortText: (p) => placeOf(p),
                },
                {
                  key: 'provider',
                  label: 'Provider',
                  render: (p) => providerOf(p),
                  sortText: (p) => providerOf(p),
                },
                {
                  key: 'seen',
                  label: 'Last seen',
                  render: (p) => (
                    <span style={{ fontSize: 12, color: t.muted }}>{seenOf(p, now)}</span>
                  ),
                  // Newest first when sorted down.
                  sortText: (p) => p.last_seen_at,
                },
              ]}
            />
            <p style={{ margin: '8px 0 0', fontSize: 11.5, color: t.muted }}>
              Kept 30 days. {team.attribution}
            </p>
          </div>
          {open && (
            <aside aria-label={`connections of ${open.name}`} style={panel(t)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong style={{ flex: 1, fontSize: 15, fontWeight: 650 }}>{open.name}</strong>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setOpen(null)}
                  style={{ border: 'none', background: 'none', color: t.accent, cursor: 'pointer' }}
                >
                  ✕
                </button>
              </div>
              <PersonConnections key={open.employee_id} id={open.employee_id} />
            </aside>
          )}
        </div>
      )}
    </section>
  );
}

function panel(t: Theme): CSSProperties {
  return {
    // 320 beside the table; under it, and no wider than the screen, on a phone.
    flex: '0 1 320px',
    minWidth: 0,
    maxWidth: '100%',
    alignSelf: 'flex-start',
    position: 'sticky',
    top: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: 14,
    border: `1px solid ${t.border}`,
    borderRadius: 12,
    background: t.surface,
    boxSizing: 'border-box',
    maxHeight: 'calc(100vh - 140px)',
    overflowY: 'auto',
  };
}
