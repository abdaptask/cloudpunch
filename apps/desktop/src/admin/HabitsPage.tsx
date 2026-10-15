import { useEffect, useState, type CSSProperties } from 'react';
import { api, type HabitFlag, type HabitsReport, type PersonHabits } from '../api.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { DataTable, type Column } from './DataTable.js';

/**
 * Reports → Habits (ADR-0051): the 30-day habits inspector, live. How
 * everyone usually starts and finishes, how steady that is, the habits
 * worth a look, the company week by week, and who changed since their
 * first week. HR and Administrators; times only.
 */

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: "Your role can't see habits.",
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

export const FLAG_TITLE: Record<HabitFlag, string> = {
  few_days: 'Not enough days yet',
  steady: 'Steady',
  irregular_start: 'Irregular starts',
  irregular_end: 'Irregular finishes',
  often_late: 'Often late',
  late_on_weekday: 'Later on one weekday',
  leaves_clocked_in: 'Leaves clocked in',
  locks_without_clocking_out: 'Locks up without clocking out',
  leaves_early: 'Leaves early',
  split_days: 'Splits the day',
  long_days: 'Long days',
  missed_starts: 'Missed clock-ins',
  starts_from_sign_in: 'Starts from sign-in',
};

/** The flags that need a look, in the order the chips show them. */
export const LOOK_AT: readonly HabitFlag[] = [
  'missed_starts',
  'often_late',
  'leaves_clocked_in',
  'locks_without_clocking_out',
  'late_on_weekday',
  'leaves_early',
  'irregular_start',
  'irregular_end',
  'split_days',
  'long_days',
];

/** "09:05"; "00:30 (+1)" after midnight. */
export function hhmm(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = String(Math.floor(m / 60)).padStart(2, '0');
  return `${h}:${String(m % 60).padStart(2, '0')}${min >= 1440 ? ' (+1)' : ''}`;
}

const pct = (r: number | null): string => (r === null ? '—' : `${Math.round(r * 100)}%`);
const signed = (m: number | null): string =>
  m === null || m === 0 ? '—' : `${m > 0 ? '+' : '−'}${Math.abs(m)} min`;
const needsALook = (p: PersonHabits): boolean => p.flags.some((f) => LOOK_AT.includes(f));
const sortNum = (x: number | null | undefined): string => String(x ?? 99_999).padStart(6, '0');

/** "15 Oct". */
function short(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T12:00:00Z`));
}

type Filter = 'all' | 'look' | 'steady' | HabitFlag;

const selected = (t: Theme, on: boolean): CSSProperties | undefined =>
  on ? { background: t.accent, color: t.onAccent, borderColor: t.accent } : undefined;

export function HabitsPage(): JSX.Element {
  const t = useTheme();
  const [data, setData] = useState<HabitsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    let current = true;
    api.reportHabits().then(
      (r) => current && setData(r),
      (e: unknown) => current && setError(typeof e === 'string' ? e : 'internal'),
    );
    return () => {
      current = false;
    };
  }, []);

  if (error) {
    return (
      <p role="alert" style={{ margin: 0, color: t.danger, fontSize: 13 }}>
        {errorText(error)}
      </p>
    );
  }
  if (!data) return <p style={{ margin: 0, color: t.muted, fontSize: 13 }}>Loading habits…</p>;

  const c = data.company;
  const shown = data.people.filter((p) =>
    filter === 'all'
      ? true
      : filter === 'look'
        ? needsALook(p)
        : filter === 'steady'
          ? p.flags.includes('steady')
          : p.flags.includes(filter),
  );
  const chips: [Filter, string, number][] = [
    ['all', 'Everyone', data.people.length],
    ['look', 'Needs a look', data.people.filter(needsALook).length],
    ['steady', 'Steady', c.flags.steady ?? 0],
    ...LOOK_AT.filter((f) => (c.flags[f] ?? 0) > 0).map((f): [Filter, string, number] => [
      f,
      FLAG_TITLE[f],
      c.flags[f] ?? 0,
    ]),
  ];

  const columns: Column<PersonHabits>[] = [
    { key: 'name', label: 'Person', render: (p) => p.name, sortText: (p) => p.name },
    {
      key: 'label',
      label: 'Pattern',
      render: (p) => (
        <span>
          {p.label}
          {p.notes.length > 0 && (
            <span style={{ display: 'block', fontSize: 11.5, color: t.muted }}>
              {p.notes.join(' · ')}
            </span>
          )}
        </span>
      ),
      sortText: (p) => p.label,
    },
    {
      key: 'in',
      label: 'Usually in',
      nowrap: true,
      render: (p) => <Typical t={t} time={p.start} />,
      sortText: (p) => sortNum(p.start?.median),
    },
    {
      key: 'out',
      label: 'Usually out',
      nowrap: true,
      render: (p) => <Typical t={t} time={p.end} />,
      sortText: (p) => sortNum(p.end?.median),
    },
    {
      key: 'days',
      label: 'Days',
      nowrap: true,
      render: (p) => String(p.days_worked),
      sortText: (p) => sortNum(p.days_worked),
    },
    {
      key: 'ontime',
      label: 'On time',
      nowrap: true,
      render: (p) => pct(p.on_time_rate),
      sortText: (p) => sortNum(p.on_time_rate === null ? null : Math.round(p.on_time_rate * 100)),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 650 }}>
          Habits · {short(data.from)} – {short(data.to)}
        </div>
        <div style={{ fontSize: 12.5, color: t.muted }}>
          CloudPunch is watching 30 days of clock-ins and clock-outs. Administrators get an email
          every Monday and the full report at the end. Ranges are the middle half of each
          person&apos;s days, in their own time zone.
        </div>
      </div>

      <div
        aria-label="habits-headline"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: 8,
        }}
      >
        <Tile t={t} value={String(c.people)} note="people tracked" />
        <Tile t={t} value={pct(c.on_time_rate)} note="shift days on time" />
        <Tile t={t} value={hhmm(c.median_start)} note="usual start" />
        <Tile t={t} value={hhmm(c.median_end)} note="usual finish" />
      </div>

      <Hours t={t} label="Clock-ins by hour" counts={c.start_hours} />
      <Hours t={t} label="Clock-outs by hour" counts={c.end_hours} />

      {c.weeks.length > 0 && (
        <section aria-label="habits-weeks">
          <h3 style={h3}>Week by week</h3>
          <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
            <thead>
              <tr style={{ color: t.muted, textAlign: 'left' }}>
                {[
                  'Week of',
                  'Days worked',
                  'On time',
                  'Usual start',
                  'Usual finish',
                  'Late',
                  'Left clocked in',
                ].map((h) => (
                  <th key={h} style={{ ...cell(t), fontWeight: 600 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {c.weeks.map((w) => (
                <tr key={w.week_start}>
                  <td style={cell(t)}>{short(w.week_start)}</td>
                  <td style={cell(t)}>{w.days_worked}</td>
                  <td style={cell(t)}>{pct(w.on_time_rate)}</td>
                  <td style={cell(t)}>{hhmm(w.median_start)}</td>
                  <td style={cell(t)}>{hhmm(w.median_end)}</td>
                  <td style={cell(t)}>{w.late_days}</td>
                  <td style={cell(t)}>{w.left_clocked_in}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section aria-label="habits-changed">
        <h3 style={h3}>Who changed since their first week</h3>
        {c.changed.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: t.muted }}>
            Nobody&apos;s start or finish has moved by half an hour or more yet.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
            {c.changed.map((ch) => (
              <li key={ch.employee_id}>
                <b>{ch.name}</b>: start {hhmm(ch.first_start)} → {hhmm(ch.last_start)} (
                {signed(ch.start_shift)}), finish {hhmm(ch.first_end)} → {hhmm(ch.last_end)} (
                {signed(ch.end_shift)})
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-label="habits-people"
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        <div
          role="group"
          aria-label="habit-filters"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
        >
          {chips.map(([key, label, n]) => (
            <Button
              key={key}
              variant="chip"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              style={selected(t, filter === key)}
            >
              {label} · {n}
            </Button>
          ))}
        </div>
        <DataTable
          label="habits"
          rows={shown}
          columns={columns}
          rowKey={(p) => p.employee_id}
          search={(p) => `${p.name} ${p.label} ${p.notes.join(' ')}`}
          searchPlaceholder="Find a person or habit"
          empty="Nobody here."
        />
      </section>
    </div>
  );
}

const h3: CSSProperties = { margin: '0 0 6px', fontSize: 13.5, fontWeight: 650 };
const cell = (t: Theme): CSSProperties => ({
  padding: '5px 8px',
  borderTop: `1px solid ${t.border}`,
  whiteSpace: 'nowrap',
});

function Typical({ t, time }: { t: Theme; time: PersonHabits['start'] }): JSX.Element {
  if (!time) return <span style={{ color: t.muted }}>—</span>;
  return (
    <span>
      {hhmm(time.median)}
      <span style={{ display: 'block', fontSize: 11, color: t.muted }}>
        {hhmm(time.low)}–{hhmm(time.high)}
      </span>
    </span>
  );
}

function Tile({ t, value, note }: { t: Theme; value: string; note: string }): JSX.Element {
  return (
    <div
      style={{
        padding: '10px 12px',
        border: `1px solid ${t.border}`,
        borderRadius: 10,
        background: t.surface,
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 650 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: t.muted }}>{note}</div>
    </div>
  );
}

/** Counts by local hour as small bars, from the first busy hour to the last. */
function Hours({
  t,
  label,
  counts,
}: {
  t: Theme;
  label: string;
  counts: number[];
}): JSX.Element | null {
  const busy = counts.map((n, h) => (n > 0 ? h : -1)).filter((h) => h >= 0);
  if (busy.length === 0) return null;
  const first = Math.min(...busy);
  const last = Math.max(...busy);
  const max = Math.max(...counts);
  const hours = counts.slice(first, last + 1);
  return (
    <section aria-label={label}>
      <h3 style={h3}>{label}</h3>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 56 }}>
        {hours.map((n, i) => (
          <div
            key={first + i}
            title={`${String(first + i).padStart(2, '0')}:00 · ${n}`}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
            }}
          >
            <div
              style={{
                width: '100%',
                height: Math.max(n > 0 ? 3 : 0, Math.round((n / max) * 40)),
                background: t.accent,
                borderRadius: '3px 3px 0 0',
              }}
            />
            <span style={{ fontSize: 10, color: t.muted }}>
              {String(first + i).padStart(2, '0')}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
