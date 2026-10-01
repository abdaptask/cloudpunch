import { useEffect, useState, type CSSProperties } from 'react';
import { api, type ConnectionHistory, type TeamConnections } from './api.js';
import { osOf, placeOf, providerOf, seenOf } from './connectionsModel.js';
import { useTheme, type Theme } from './ui/theme.js';

/**
 * Where people connect from (ADR-0029): an IP address's approximate
 * place and provider, worked out on the server. Shown to the person
 * themselves, their manager, and Administrators; the server decides
 * who sees whom and audits each history opened.
 */

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  forbidden: "Your role can't see connections.",
  not_found: "That person isn't on your team.",
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/** A connection history, loaded by `load` (your own or a person's). */
export function ConnectionList({ load }: { load: () => Promise<ConnectionHistory> }): JSX.Element {
  const t = useTheme();
  const [history, setHistory] = useState<ConnectionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setHistory(null);
    setError(null);
    load().then(
      (h) => {
        if (current) setHistory(h);
      },
      (e: unknown) => {
        if (current) setError(String(e));
      },
    );
    return () => {
      current = false;
    };
  }, [load]);
  if (error) return <Note t={t} alert text={errorText(error)} />;
  if (!history) return <Note t={t} text="Loading…" />;
  const now = Date.now();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {!history.recording && <Note t={t} text="Recording is off, so nothing new is added." />}
      {history.connections.length === 0 ? (
        <Note t={t} text={`No connections in the last ${history.keep_days} days.`} />
      ) : (
        <ul aria-label="connections" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {history.connections.map((c) => (
            <li
              key={`${c.ip}-${c.first_seen_at}`}
              style={{ padding: '8px 0', borderBottom: `1px solid ${t.border}`, fontSize: 13 }}
            >
              <span style={{ display: 'block', fontWeight: 600 }}>{placeOf(c)}</span>
              <span style={{ display: 'block', fontSize: 12, color: t.muted }}>
                {providerOf(c)} · {c.ip}
                {osOf(c) && ` · ${osOf(c)}`}
              </span>
              <span style={{ display: 'block', fontSize: 12, color: t.muted }}>
                {seenOf(c, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Footer t={t} keepDays={history.keep_days} attribution={history.attribution} />
    </div>
  );
}

/** Your own history, opened from the account menu. */
export function MyConnections({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useTheme();
  return (
    <section
      aria-label="my-connections"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Where you connect from</h2>
        <button type="button" onClick={onClose} style={link(t)}>
          Done
        </button>
      </div>
      <ConnectionList load={api.myConnections} />
    </section>
  );
}

/**
 * Administrators: everyone's latest connection (Settings → Connections),
 * for when they have no Team tab. Opening a person shows their history.
 */
export function EveryoneConnections(): JSX.Element {
  const t = useTheme();
  const [team, setTeam] = useState<TeamConnections | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let current = true;
    api.teamConnections().then(
      (r) => {
        if (current) setTeam(r);
      },
      (e: unknown) => {
        if (current) setError(String(e));
      },
    );
    return () => {
      current = false;
    };
  }, []);
  if (person) {
    return (
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>{person.name}</h2>
          <button type="button" onClick={() => setPerson(null)} style={link(t)}>
            Back
          </button>
        </div>
        <PersonConnections id={person.id} />
      </section>
    );
  }
  if (error) return <Note t={t} alert text={errorText(error)} />;
  if (!team) return <Note t={t} text="Loading…" />;
  const sorted = [...team.people].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section
      aria-label="everyone-connections"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {!team.recording && (
        <Note t={t} text="Recording is off. Turn it on in Rules, company-wide." />
      )}
      {sorted.length === 0 ? (
        <Note t={t} text="No connections in the last 30 days." />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {sorted.map((p) => (
            <li key={p.employee_id} style={{ borderBottom: `1px solid ${t.border}` }}>
              <button
                type="button"
                onClick={() => setPerson({ id: p.employee_id, name: p.name })}
                style={{
                  width: '100%',
                  padding: '8px 4px',
                  border: 'none',
                  background: 'none',
                  color: t.text,
                  font: 'inherit',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{p.name}</span>
                <span style={{ display: 'block', fontSize: 12, color: t.muted }}>
                  {placeOf(p)} · {providerOf(p)} · {seenOf(p, Date.now())}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Footer t={t} keepDays={30} attribution={team.attribution} />
    </section>
  );
}

/** One person's history; a stable loader so it fetches (and audits) once. */
export function PersonConnections({ id }: { id: string }): JSX.Element {
  const [load] = useState(() => () => api.personConnections(id));
  return <ConnectionList load={load} />;
}

function Footer({
  t,
  keepDays,
  attribution,
}: {
  t: Theme;
  keepDays: number;
  attribution: string;
}): JSX.Element {
  return (
    <p style={{ margin: 0, fontSize: 11, lineHeight: 1.4, color: t.muted }}>
      Approximate, from the internet connection: a VPN or office network shows its own location.
      Kept {keepDays} days. {attribution}.
    </p>
  );
}

function Note({ t, text, alert }: { t: Theme; text: string; alert?: boolean }): JSX.Element {
  return (
    <p
      role={alert ? 'alert' : 'status'}
      style={{ margin: 0, fontSize: 13, lineHeight: 1.4, color: alert ? t.danger : t.muted }}
    >
      {text}
    </p>
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
