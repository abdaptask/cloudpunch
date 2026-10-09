import { useEffect, useState, type CSSProperties } from 'react';
import { api, type TeamDay, type TeamException, type TeamPerson } from './api.js';
import { PersonConnections } from './ConnectionsView.js';
import { CorrectionForm, DayCorrections } from './Corrections.js';
import { placeOf } from './connectionsModel.js';
import { dayLabel, localDateOf, LOOKBACK_DAYS, shiftDate } from './dayHistory.js';
import type { DaySummary } from './dayPickerModel.js';
import {
  dayRows,
  exceptionText,
  hm,
  overdue,
  startsText,
  statusText,
  type DayRow,
} from './teamModel.js';
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
  /** "Done" back to the dashboard; the web has nothing to go back to (ADR-0033). */
  onClose?: () => void;
  /** Managers and Administrators (ADR-0029 §5); not HR. The server checks again. */
  canSeeConnections?: boolean;
  /** Offer "Correct this day" (ADR-0030; only a direct manager succeeds). */
  canCorrect?: boolean;
}): JSX.Element {
  const t = useTheme();
  const [tab, setTab] = useState<'today' | 'exceptions'>('today');
  const [person, setPerson] = useState<{
    id: string;
    name: string;
    subtitle: string | null;
    starts?: string | null;
  } | null>(null);
  return (
    <section aria-label="team" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>
          {person ? person.name : 'Team'}
        </h2>
        {(person || onClose) && (
          <button type="button" onClick={person ? () => setPerson(null) : onClose} style={link(t)}>
            {person ? 'Back' : 'Done'}
          </button>
        )}
      </div>
      {person ? (
        <Person
          id={person.id}
          subtitle={person.subtitle}
          starts={person.starts ?? null}
          canSeeConnections={canSeeConnections}
          canCorrect={canCorrect}
        />
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
              onOpen={(p, place) =>
                setPerson({
                  id: p.employee_id,
                  name: p.name,
                  subtitle: place ? `${statusText(p)} · ${place}` : statusText(p),
                  starts: startsText(p),
                })
              }
            />
          ) : (
            <Exceptions
              onOpen={(e) => setPerson({ id: e.employee_id, name: e.name, subtitle: null })}
            />
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
  onOpen: (p: TeamPerson, place: string | undefined) => void;
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
        // In their shift and not clocked in (ADR-0031): amber.
        const missing = p.status === 'shift_not_started';
        const color = missing
          ? t.kind.meal_break
          : p.kind && p.kind in t.kind
            ? t.kind[p.kind as SegmentKind]
            : t.muted;
        const late = overdue(p, now);
        return (
          <li key={p.employee_id}>
            <button
              type="button"
              onClick={() => onOpen(p, places.get(p.employee_id))}
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
                <span
                  style={{
                    display: 'block',
                    fontSize: 12,
                    color: late ? t.danger : missing ? t.warnText : t.muted,
                  }}
                >
                  {statusText(p)}
                  {late && ' · late'}
                  {p.starts?.regular && ` · ${p.starts.missed} missed starts`}
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

/**
 * A person, summary first (owner request): today as a card that opens
 * in place, the earlier days of the look-back the same way, and for
 * Managers and Administrators where they connect from, as one line at
 * the bottom. No arrows, no tabs.
 */
function Person({
  id,
  subtitle,
  starts,
  canSeeConnections,
  canCorrect,
}: {
  id: string;
  subtitle: string | null;
  /** Missed starts lately (ADR-0037 §4), or null. */
  starts: string | null;
  canSeeConnections: boolean;
  canCorrect: boolean;
}): JSX.Element {
  const t = useTheme();
  const today = localDateOf(Date.now());
  const [open, setOpen] = useState<string | null>(null);
  const [connections, setConnections] = useState(false);
  const toggle = (date: string): void => setOpen((o) => (o === date ? null : date));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {subtitle && (
        <span aria-label="person-status" style={{ fontSize: 13, color: t.muted, marginTop: -8 }}>
          {subtitle}
        </span>
      )}
      {starts && (
        <span aria-label="person-starts" style={{ fontSize: 13, color: t.warnText, marginTop: -8 }}>
          {starts}
        </span>
      )}
      <TodayCard
        id={id}
        date={today}
        open={open === today}
        onToggle={() => toggle(today)}
        canCorrect={canCorrect}
      />
      <Earlier id={id} today={today} open={open} onToggle={toggle} canCorrect={canCorrect} />
      {canSeeConnections && (
        <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 10 }}>
          <button
            type="button"
            aria-expanded={connections}
            onClick={() => setConnections((c) => !c)}
            style={link(t)}
          >
            {connections ? 'Hide where they connect from' : 'Where they connect from ›'}
          </button>
          {connections && (
            <div style={{ marginTop: 10 }}>
              <PersonConnections id={id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One person's working day, loaded on demand (audited server-side). */
function useTeamDay(
  id: string,
  date: string,
): { day: TeamDay | null; error: string | null; reload: () => void } {
  const [day, setDay] = useState<TeamDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
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
  }, [id, date, n]);
  return { day, error, reload: () => setN((x) => x + 1) };
}

/** Today: worked, a bar of the day, in-time · breaks · idle; opens to the rows. */
function TodayCard({
  id,
  date,
  open,
  onToggle,
  canCorrect,
}: {
  id: string;
  date: string;
  open: boolean;
  onToggle: () => void;
  canCorrect: boolean;
}): JSX.Element {
  const t = useTheme();
  const { day, error, reload } = useTeamDay(id, date);
  const rows = day ? dayRows(day) : [];
  const first = rows[0];
  const canOpen = day !== null && rows.length > 0;
  return (
    <section
      aria-label="today-card"
      style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 12 }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label="today"
        onClick={onToggle}
        disabled={!canOpen}
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 0,
          border: 'none',
          background: 'none',
          color: t.text,
          font: 'inherit',
          textAlign: 'left',
          cursor: canOpen ? 'pointer' : 'default',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 650, color: t.muted }}>TODAY</span>
          <span style={{ flex: 1 }} />
          {canOpen && (
            <span aria-hidden style={{ fontSize: 12, color: t.muted }}>
              {open ? '▴' : '▾'}
            </span>
          )}
        </span>
        {error && <Note t={t} alert text={errorText(error)} />}
        {!day && !error && <Note t={t} text="Loading…" />}
        {day && rows.length === 0 && <Note t={t} text="Nothing tracked yet today." />}
        {day && first && (
          <>
            <span
              aria-label="today-worked"
              style={{ fontSize: 22, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}
            >
              {hm(day.totals.worked_ms / 60_000)}
            </span>
            <DayBar rows={rows} />
            <span aria-label="today-summary" style={{ fontSize: 12, color: t.muted }}>
              In {formatClock(first.from)} · Breaks {hm(day.totals.breaks_ms / 60_000)}
              {day.totals.idle_ms > 0 && <> · Idle {hm(day.totals.idle_ms / 60_000)}</>}
            </span>
          </>
        )}
      </button>
      {open && day && (
        <div style={{ marginTop: 12 }}>
          <DayDetail id={id} date={date} day={day} canCorrect={canCorrect} onChanged={reload} />
        </div>
      )}
    </section>
  );
}

/** The day as one bar from the first clock-in to the last stop, by kind. */
function DayBar({ rows }: { rows: readonly DayRow[] }): JSX.Element | null {
  const t = useTheme();
  const start = rows[0]?.from;
  const end = Math.max(...rows.map((r) => r.to));
  if (start === undefined || end <= start) return null;
  const span = end - start;
  return (
    <span
      aria-hidden
      style={{
        position: 'relative',
        display: 'block',
        height: 8,
        borderRadius: 4,
        background: t.border,
        overflow: 'hidden',
      }}
    >
      {rows.map((r, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${((r.from - start) / span) * 100}%`,
            width: `${((r.to - r.from) / span) * 100}%`,
            background: r.kind in t.kind ? t.kind[r.kind as SegmentKind] : t.muted,
          }}
        />
      ))}
    </span>
  );
}

/** The earlier days of the look-back with time on them, newest first. */
function Earlier({
  id,
  today,
  open,
  onToggle,
  canCorrect,
}: {
  id: string;
  today: string;
  open: string | null;
  onToggle: (date: string) => void;
  canCorrect: boolean;
}): JSX.Element {
  const t = useTheme();
  const [days, setDays] = useState<DaySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setDays(null);
    setError(null);
    api.teamDays(id, shiftDate(today, -LOOKBACK_DAYS), shiftDate(today, -1)).then(
      (r) => {
        if (!current) return;
        setDays(
          r.days
            .filter((d) => d.sessions > 0 || d.worked_ms > 0)
            .sort((a, b) => b.date.localeCompare(a.date)),
        );
      },
      (e: unknown) => {
        if (current) setError(String(e));
      },
    );
    return () => {
      current = false;
    };
  }, [id, today]);
  return (
    <section aria-label="earlier" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 650, color: t.muted }}>EARLIER</span>
      {error && <Note t={t} alert text={errorText(error)} />}
      {!days && !error && <Note t={t} text="Loading…" />}
      {days && days.length === 0 && (
        <Note t={t} text={`Nothing tracked in the last ${LOOKBACK_DAYS} days.`} />
      )}
      {days && days.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {days.map((d) => (
            <li key={d.date} style={{ borderBottom: `1px solid ${t.border}` }}>
              <button
                type="button"
                aria-expanded={open === d.date}
                aria-label={`day ${d.date}`}
                onClick={() => onToggle(d.date)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  padding: '8px 2px',
                  border: 'none',
                  background: 'none',
                  color: t.text,
                  font: 'inherit',
                  fontSize: 13,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span style={{ flex: 1 }}>{dayLabel(d.date, today)}</span>
                <span style={{ color: t.muted, fontSize: 12 }}>
                  {d.sessions === 1 ? '1 session' : `${d.sessions} sessions`}
                </span>
                <span style={{ width: 56, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {hm(d.worked_ms / 60_000)}
                </span>
              </button>
              {open === d.date && <EarlierDay id={id} date={d.date} canCorrect={canCorrect} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EarlierDay({
  id,
  date,
  canCorrect,
}: {
  id: string;
  date: string;
  canCorrect: boolean;
}): JSX.Element {
  const t = useTheme();
  const { day, error, reload } = useTeamDay(id, date);
  return (
    <div style={{ padding: '4px 2px 12px' }}>
      {error && <Note t={t} alert text={errorText(error)} />}
      {!day && !error && <Note t={t} text="Loading…" />}
      {day && (
        <DayDetail id={id} date={date} day={day} canCorrect={canCorrect} onChanged={reload} />
      )}
    </div>
  );
}

/** A day opened: totals, its rows, its corrections, and "Correct this day". */
function DayDetail({
  id,
  date,
  day,
  canCorrect,
  onChanged,
}: {
  id: string;
  date: string;
  day: TeamDay;
  canCorrect: boolean;
  onChanged: () => void;
}): JSX.Element {
  const t = useTheme();
  const [correcting, setCorrecting] = useState(false);
  const rows = dayRows(day);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
              onChanged();
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
