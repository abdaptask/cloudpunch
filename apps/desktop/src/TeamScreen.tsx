import { useEffect, useState, type CSSProperties } from 'react';
import { api, type TeamDay, type TeamException, type TeamPerson } from './api.js';
import { PersonConnections } from './ConnectionsView.js';
import { CorrectionForm, DayCorrections } from './Corrections.js';
import { placeOf } from './connectionsModel.js';
import { dayLabel, localDateOf, LOOKBACK_DAYS, shiftDate } from './dayHistory.js';
import { dayRows, exceptionText, hm, overdue, statusText } from './teamModel.js';
import { formatClock, type SegmentKind } from './timelineModel.js';
import { Button } from './ui/Button.js';
import { useTheme, type Theme } from './ui/theme.js';

/** Team today refreshes this often while open (ADR-0025). */
const REFRESH_MS = 30_000;
/** Exceptions look back this many days, today included. */
const EXCEPTION_DAYS = 7;

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: "Your role can't see team members.",
  not_found: "That person isn't on your team.",
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/**
 * The Team tab for Managers and HR (ADR-0025): who's doing what now, a
 * person's day, and exceptions. The server decides who is on the
 * caller's team and audits each day opened.
 */
export function TeamScreen({
  onClose,
  canSeeConnections = false,
  canCorrect = false,
}: {
  onClose: () => void;
  /** Managers and Administrators (ADR-0029 §5); not HR. The server checks again. */
  canSeeConnections?: boolean;
  /** Offer "Correct this day" (ADR-0030; only a direct manager succeeds). */
  canCorrect?: boolean;
}): JSX.Element {
  const t = useTheme();
  const [tab, setTab] = useState<'today' | 'exceptions'>('today');
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  return (
    <section aria-label="team" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>
          {person ? person.name : 'Team'}
        </h2>
        <button type="button" onClick={person ? () => setPerson(null) : onClose} style={link(t)}>
          {person ? 'Back' : 'Done'}
        </button>
      </div>
      {person ? (
        <Person id={person.id} canSeeConnections={canSeeConnections} canCorrect={canCorrect} />
      ) : (
        <>
          <div role="tablist" aria-label="team-tabs" style={{ display: 'flex', gap: 6 }}>
            {(
              [
                ['today', 'Today'],
                ['exceptions', 'Exceptions'],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                role="tab"
                aria-selected={tab === key}
                variant="chip"
                onClick={() => setTab(key)}
                style={
                  tab === key ? { borderColor: t.accent, color: t.accent, fontWeight: 650 } : {}
                }
              >
                {label}
              </Button>
            ))}
          </div>
          {tab === 'today' ? (
            <TeamToday
              canSeeConnections={canSeeConnections}
              onOpen={(p) => setPerson({ id: p.employee_id, name: p.name })}
            />
          ) : (
            <Exceptions onOpen={(e) => setPerson({ id: e.employee_id, name: e.name })} />
          )}
        </>
      )}
    </section>
  );
}

function TeamToday({
  onOpen,
  canSeeConnections,
}: {
  onOpen: (p: TeamPerson) => void;
  canSeeConnections: boolean;
}): JSX.Element {
  const t = useTheme();
  const [people, setPeople] = useState<TeamPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // Each person's latest place (ADR-0029); left out if it can't load.
  const [places, setPlaces] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let current = true;
    const load = (): void => {
      if (canSeeConnections) {
        api.teamConnections().then(
          (r) => {
            if (current) setPlaces(new Map(r.people.map((p) => [p.employee_id, placeOf(p)])));
          },
          () => undefined,
        );
      }
      api.teamNow().then(
        (r) => {
          if (!current) return;
          setPeople(r.people);
          setError(null);
          setNow(Date.now());
        },
        (e: unknown) => {
          if (current) setError(String(e));
        },
      );
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [canSeeConnections]);
  if (error && !people) return <Note t={t} alert text={errorText(error)} />;
  if (!people) return <Note t={t} text="Loading…" />;
  if (people.length === 0) {
    return (
      <Note
        t={t}
        text="No one reports to you in CloudPunch yet. HR sets reporting lines in Settings → People."
      />
    );
  }
  return (
    <ul aria-label="team-today" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {people.map((p) => {
        const color = p.kind && p.kind in t.kind ? t.kind[p.kind as SegmentKind] : t.muted;
        const late = overdue(p, now);
        return (
          <li key={p.employee_id}>
            <button
              type="button"
              onClick={() => onOpen(p)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 4px',
                border: 'none',
                borderBottom: `1px solid ${t.border}`,
                background: 'none',
                color: t.text,
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: color,
                  flex: 'none',
                }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{p.name}</span>
                <span style={{ display: 'block', fontSize: 12, color: late ? t.danger : t.muted }}>
                  {statusText(p)}
                  {late && ' · late'}
                  {places.has(p.employee_id) && ` · ${places.get(p.employee_id)}`}
                </span>
              </span>
              <span style={{ fontSize: 12, color: t.muted, fontVariantNumeric: 'tabular-nums' }}>
                {p.worked_ms > 0 ? hm(p.worked_ms / 60_000) : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** A person: their day, and for Managers and Administrators, their connections. */
function Person({
  id,
  canSeeConnections,
  canCorrect,
}: {
  id: string;
  canSeeConnections: boolean;
  canCorrect: boolean;
}): JSX.Element {
  const t = useTheme();
  const [tab, setTab] = useState<'day' | 'connections'>('day');
  if (!canSeeConnections) return <PersonDay id={id} canCorrect={canCorrect} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div role="tablist" aria-label="person-tabs" style={{ display: 'flex', gap: 6 }}>
        {(
          [
            ['day', 'Day'],
            ['connections', 'Connections'],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            role="tab"
            aria-selected={tab === key}
            variant="chip"
            onClick={() => setTab(key)}
            style={tab === key ? { borderColor: t.accent, color: t.accent, fontWeight: 650 } : {}}
          >
            {label}
          </Button>
        ))}
      </div>
      {tab === 'day' ? (
        <PersonDay id={id} canCorrect={canCorrect} />
      ) : (
        <PersonConnections id={id} />
      )}
    </div>
  );
}

function PersonDay({ id, canCorrect }: { id: string; canCorrect: boolean }): JSX.Element {
  const t = useTheme();
  const today = localDateOf(Date.now());
  const [date, setDate] = useState(today);
  const [day, setDay] = useState<TeamDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setCorrecting(false);
  }, [id, date]);
  useEffect(() => {
    let current = true;
    setDay(null);
    setError(null);
    api.teamDay(id, date).then(
      (d) => {
        if (current) setDay(d);
      },
      (e: unknown) => {
        if (current) setError(String(e));
      },
    );
    return () => {
      current = false;
    };
  }, [id, date, reload]);
  const earliest = shiftDate(today, -LOOKBACK_DAYS);
  const rows = day ? dayRows(day) : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Button
          variant="chip"
          aria-label="previous day"
          disabled={date <= earliest}
          onClick={() => setDate((d) => shiftDate(d, -1))}
        >
          ‹
        </Button>
        <span aria-label="team-day-date" style={{ fontSize: 13, fontWeight: 600 }}>
          {dayLabel(date, today)}
        </span>
        <Button
          variant="chip"
          aria-label="next day"
          disabled={date >= today}
          onClick={() => setDate((d) => shiftDate(d, 1))}
        >
          ›
        </Button>
      </div>
      {error && <Note t={t} alert text={errorText(error)} />}
      {!day && !error && <Note t={t} text="Loading…" />}
      {day && (
        <>
          <p aria-label="team-day-totals" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            Worked {hm(day.totals.worked_ms / 60_000)} · Breaks {hm(day.totals.breaks_ms / 60_000)}{' '}
            <span style={{ color: t.muted }}>
              (paid {hm(day.totals.paid_break_ms / 60_000)}, unpaid{' '}
              {hm(day.totals.unpaid_break_ms / 60_000)})
            </span>
            {day.totals.idle_ms > 0 && <> · Idle {hm(day.totals.idle_ms / 60_000)}</>}
          </p>
          {rows.length === 0 ? (
            <Note t={t} text="Nothing was tracked on this day." />
          ) : (
            <ul aria-label="team-day" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {rows.map((r, i) => (
                <li
                  key={i}
                  style={{
                    display: 'flex',
                    gap: 10,
                    padding: '6px 0',
                    borderBottom: `1px solid ${t.border}`,
                    fontSize: 13,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 4,
                      alignSelf: 'stretch',
                      borderRadius: 2,
                      background: r.kind in t.kind ? t.kind[r.kind as SegmentKind] : t.muted,
                    }}
                  />
                  <span style={{ width: 92, color: t.muted, fontVariantNumeric: 'tabular-nums' }}>
                    {formatClock(r.from)}–{formatClock(r.to)}
                  </span>
                  <span style={{ flex: 1 }}>
                    {r.label}
                    {r.detail && (
                      <span
                        style={{
                          display: 'block',
                          fontSize: 12,
                          color: r.late ? t.danger : t.muted,
                        }}
                      >
                        {r.detail}
                      </span>
                    )}
                  </span>
                  <span style={{ color: t.muted, fontVariantNumeric: 'tabular-nums' }}>
                    {hm((r.to - r.from) / 60_000)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <DayCorrections corrections={day.corrections} />
          {canCorrect &&
            (correcting ? (
              <CorrectionForm
                date={date}
                defaultTz={day.sessions[0]?.tz_iana ?? null}
                submitLabel="Send for approval"
                onSubmit={(c) => api.requestCorrection({ ...c, employeeId: id })}
                onDone={() => {
                  setCorrecting(false);
                  setReload((n) => n + 1);
                }}
                onCancel={() => setCorrecting(false)}
              />
            ) : (
              <Button
                variant="chip"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => setCorrecting(true)}
              >
                Correct this day
              </Button>
            ))}
        </>
      )}
    </div>
  );
}

function Exceptions({ onOpen }: { onOpen: (e: TeamException) => void }): JSX.Element {
  const t = useTheme();
  const today = localDateOf(Date.now());
  const from = shiftDate(today, -(EXCEPTION_DAYS - 1));
  const [items, setItems] = useState<TeamException[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    api.teamExceptions(from, today).then(
      (r) => {
        if (current) setItems(r.exceptions);
      },
      (e: unknown) => {
        if (current) setError(String(e));
      },
    );
    return () => {
      current = false;
    };
  }, [from, today]);
  if (error) return <Note t={t} alert text={errorText(error)} />;
  if (!items) return <Note t={t} text="Loading…" />;
  if (items.length === 0)
    return <Note t={t} text={`Nothing unusual in the last ${EXCEPTION_DAYS} days.`} />;
  return (
    <ul aria-label="team-exceptions" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((e, i) => {
        const { text, said } = exceptionText(e);
        return (
          <li key={i} style={{ borderBottom: `1px solid ${t.border}` }}>
            <button
              type="button"
              onClick={() => onOpen(e)}
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
              <span style={{ display: 'block', fontSize: 12, color: t.muted }}>
                {e.name} · {dayLabel(e.date, today)}
              </span>
              <span style={{ display: 'block', fontSize: 13 }}>{text}</span>
              {said && (
                <span style={{ display: 'block', fontSize: 12, color: t.muted }}>{said}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
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
