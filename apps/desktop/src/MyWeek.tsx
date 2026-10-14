import { useEffect, useState, type CSSProperties } from 'react';
import { api, type DayMark, type MyWeek as MyWeekData } from './api.js';
import { Button } from './ui/Button.js';
import { useTheme, type Theme } from './ui/theme.js';

/**
 * My week (ADR-0047 §5): the person's own last 14 days as a strip, a few
 * totals, and any finding about them, with what their manager or HR
 * said and a place to add their side. Coaching, not a scorecard; nothing
 * about anyone else (invariant 1).
 */

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  no_employee_for_user: "Your account isn't set up for time tracking yet.",
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

interface MarkStyle {
  label: string;
  icon: string;
  color: (t: Theme) => string;
}

// Status colours are fixed in both themes and always carry an icon and a
// label; "worked" and the quiet days use theme-aware tones.
const MARKS: Record<DayMark, MarkStyle> = {
  on_time: { label: 'On time', icon: '✓', color: () => '#0ca30c' },
  late: { label: 'Late', icon: '!', color: () => '#fab219' },
  missed: { label: 'No clock-in', icon: '✕', color: () => '#d03b3b' },
  short: { label: 'Short day', icon: '◐', color: () => '#ec835a' },
  worked: {
    label: 'Worked, no shift',
    icon: '•',
    color: (t) => (t.mode === 'dark' ? '#3987e5' : '#2a78d6'),
  },
  office: {
    label: 'In office',
    icon: '–',
    color: (t) => (t.mode === 'dark' ? '#383835' : '#c3c2b7'),
  },
  holiday: {
    label: 'Holiday',
    icon: '–',
    color: (t) => (t.mode === 'dark' ? '#383835' : '#c3c2b7'),
  },
  not_working: {
    label: 'Not working',
    icon: '–',
    color: (t) => (t.mode === 'dark' ? '#383835' : '#c3c2b7'),
  },
  off: { label: 'Off', icon: '–', color: (t) => (t.mode === 'dark' ? '#383835' : '#c3c2b7') },
};

/** "8h 05m", "45m". */
export function hm(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "Mon 12 Oct". */
export function dayText(date: string): string {
  return new Date(`${date}T12:00:00Z`)
    .toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    })
    .replace(',', '');
}

/** "15 Oct, 10:05" in this computer's zone. */
const whenText = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

type Day = MyWeekData['strip'][number];

/** What a day's tooltip says. */
export function dayDetail(d: Day): string {
  const parts = [`${dayText(d.date)}: ${MARKS[d.mark].label}`];
  if (d.mark === 'late' && d.minutes_late) parts.push(`${d.minutes_late} min late`);
  if (d.worked_ms > 0) {
    parts.push(d.shift_ms > 0 ? `${hm(d.worked_ms)} of ${hm(d.shift_ms)}` : hm(d.worked_ms));
  }
  if (d.idle_ms >= 60_000) parts.push(`idle ${hm(d.idle_ms)}`);
  return parts.join(' · ');
}

export function MyWeek({ onClose }: { onClose?: () => void }): JSX.Element {
  const t = useTheme();
  const [data, setData] = useState<MyWeekData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.myInsights().then(
      (d) => {
        if (current) setData(d);
      },
      (e: unknown) => {
        if (current) setError(errorText(String(e)));
      },
    );
    return () => {
      current = false;
    };
  }, [loads]);

  const shown = data?.strip.find((d) => d.date === hover) ?? null;
  const marks = data ? [...new Set(data.strip.map((d) => d.mark))] : [];
  const open = data?.findings.filter((f) => f.status === 'open' || f.status === 'nudged') ?? [];
  const closed =
    data?.findings.filter((f) => f.status === 'resolved' || f.status === 'dismissed') ?? [];

  return (
    <section aria-label="my-week" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>My week</h2>
        {onClose && (
          <button type="button" onClick={onClose} style={link(t)}>
            Done
          </button>
        )}
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger }}>
          {error}
        </p>
      )}
      {!data && !error && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}
      {data && (
        <>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>
            Here&apos;s your last two weeks, {dayText(data.from)} to {dayText(data.to)}.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div
              role="list"
              aria-label="my-days"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(14, 1fr)', gap: 2 }}
            >
              {data.strip.map((d) => {
                const m = MARKS[d.mark];
                return (
                  <button
                    key={d.date}
                    type="button"
                    role="listitem"
                    aria-label={dayDetail(d)}
                    onMouseEnter={() => setHover(d.date)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(d.date)}
                    onBlur={() => setHover(null)}
                    style={{
                      height: 30,
                      border: 'none',
                      borderRadius: 4,
                      padding: 0,
                      background: m.color(t),
                      color: d.mark === 'late' ? '#0b0b0b' : '#ffffff',
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: 'default',
                      outlineOffset: 2,
                    }}
                  >
                    {m.icon}
                  </button>
                );
              })}
            </div>
            <div
              aria-hidden
              style={{ display: 'grid', gridTemplateColumns: 'repeat(14, 1fr)', gap: 2 }}
            >
              {data.strip.map((d) => (
                <span key={d.date} style={{ fontSize: 10, color: t.muted, textAlign: 'center' }}>
                  {dayText(d.date).slice(0, 1)}
                </span>
              ))}
            </div>
            <p
              aria-live="polite"
              style={{ margin: 0, minHeight: 18, fontSize: 12.5, color: t.muted }}
            >
              {shown ? dayDetail(shown) : 'Point at a day for its details.'}
            </p>
            <div
              aria-label="my-days-legend"
              style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12, color: t.muted }}
            >
              {marks.map((k) => (
                <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      background: MARKS[k].color(t),
                      color: k === 'late' ? '#0b0b0b' : '#ffffff',
                      fontSize: 9,
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {MARKS[k].icon}
                  </span>
                  {MARKS[k].label}
                </span>
              ))}
            </div>
          </div>

          <div aria-label="my-totals" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Total
              t={t}
              label="On time"
              value={
                data.totals.shift_days ? `${data.totals.on_time} of ${data.totals.shift_days}` : '—'
              }
              note="shift days"
            />
            <Total
              t={t}
              label="Hours"
              value={hm(data.totals.worked_ms)}
              note={
                data.totals.scheduled_ms ? `of ${hm(data.totals.scheduled_ms)} scheduled` : 'worked'
              }
            />
            <Total t={t} label="Idle" value={hm(data.totals.idle_ms)} note="logged idle" />
          </div>

          {open.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>
              Nothing needs your attention. Keep it up.
            </p>
          ) : (
            open.map((f) => (
              <Finding key={f.id} f={f} t={t} onAdded={() => setLoads((n) => n + 1)} />
            ))
          )}
          {closed.length > 0 && (
            <p style={{ margin: 0, fontSize: 12, color: t.muted }}>
              Closed in the last 30 days: {closed.map((f) => f.headline).join(' · ')}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Total({
  t,
  label,
  value,
  note,
}: {
  t: Theme;
  label: string;
  value: string;
  note: string;
}): JSX.Element {
  return (
    <div
      style={{
        flex: '1 1 110px',
        padding: '8px 10px',
        borderRadius: 10,
        border: `1px solid ${t.border}`,
        background: t.surface,
      }}
    >
      <div style={{ fontSize: 11.5, color: t.muted }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 650 }}>{value}</div>
      <div style={{ fontSize: 11, color: t.muted }}>{note}</div>
    </div>
  );
}

function Finding({
  f,
  t,
  onAdded,
}: {
  f: MyWeekData['findings'][number];
  t: Theme;
  onAdded: () => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null);
  const add = (): void => {
    setBusy(true);
    setStatus(null);
    api.addInsightContext(f.id, text.trim()).then(
      () => {
        setBusy(false);
        setText('');
        setStatus({ kind: 'saved', text: 'Added. Your manager and HR will see it.' });
        onAdded();
      },
      (e: unknown) => {
        setBusy(false);
        setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };
  return (
    <article
      aria-label={`finding ${f.headline}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        borderRadius: 10,
        border: `1px solid ${t.border}`,
        background: t.surface,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 650 }}>{f.headline}</div>
      {f.dates.length > 0 && (
        <div style={{ fontSize: 12.5, color: t.muted }}>{f.dates.map(dayText).join(' · ')}</div>
      )}
      {f.nudges.map((n, i) => (
        <blockquote
          key={`n${i}`}
          style={{
            margin: 0,
            padding: '8px 10px',
            borderRadius: 8,
            background: t.surfaceAlt,
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          }}
        >
          <div style={{ fontSize: 11.5, color: t.muted, marginBottom: 4 }}>
            {n.by ?? 'CloudPunch'} · {whenText(n.at)}
          </div>
          {n.message}
        </blockquote>
      ))}
      {f.context.map((c, i) => (
        <div key={`c${i}`} style={{ fontSize: 13, lineHeight: 1.5 }}>
          <span style={{ color: t.muted }}>You · {whenText(c.at)}: </span>
          {c.text}
        </div>
      ))}
      <textarea
        aria-label={`context for ${f.headline}`}
        placeholder="Add your side (for example, a bus timing changed)"
        value={text}
        maxLength={1000}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        style={input(t)}
      />
      <Button
        variant="secondary"
        disabled={busy || text.trim().length < 3}
        onClick={add}
        style={{ alignSelf: 'flex-start' }}
      >
        {busy ? 'Adding…' : 'Add context'}
      </Button>
      {status && (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          style={{ margin: 0, fontSize: 12.5, color: status.kind === 'error' ? t.danger : t.text }}
        >
          {status.text}
        </p>
      )}
    </article>
  );
}

function input(t: Theme): CSSProperties {
  return {
    font: 'inherit',
    fontSize: 13,
    padding: '7px 9px',
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.bg,
    color: t.text,
    resize: 'vertical',
  };
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
