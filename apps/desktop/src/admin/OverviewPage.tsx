import { useEffect, useState, type ReactNode } from 'react';
import { api, type Overview, type OverviewPerson } from '../api.js';
import { localDateOf } from '../dayHistory.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { DataTable, input, Notice, type Column } from './DataTable.js';
import {
  csvName,
  csvOf,
  hrs,
  mins,
  pct,
  PRESETS,
  rangeIssue,
  rangeOf,
  weekLabel,
  type CsvSection,
  type Preset,
} from './overviewModel.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: "Your role can't see the overview.",
  date_out_of_range: 'Pick up to 3 months within the last year.',
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

const SECTIONS: readonly [CsvSection, string][] = [
  ['hours', 'Hours and attendance'],
  ['lateness', 'Lateness'],
  ['activity', 'Idle, breaks and Away'],
];

const num = (x: number | null): string => String(x ?? -1).padStart(14, '0');

/**
 * Reports → Overview (ADR-0040 §3), for HR and Administrators: a range,
 * the headline numbers, week-by-week charts, a table per area (each a
 * CSV download), and adoption and health.
 */
export function OverviewPage(): JSX.Element {
  const t = useTheme();
  const today = localDateOf(Date.now());
  const [preset, setPreset] = useState<Preset | 'custom'>('last_week');
  const [range, setRange] = useState(() => rangeOf('last_week', today));
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [section, setSection] = useState<CsvSection>('hours');
  const issue = rangeIssue(range.from, range.to);

  useEffect(() => {
    if (issue) return;
    let current = true;
    setData(null);
    setError(null);
    api.reportOverview(range.from, range.to).then(
      (o) => {
        if (current) setData(o);
      },
      (e: unknown) => {
        if (current) setError(errorText(String(e)));
      },
    );
    return () => {
      current = false;
    };
  }, [range.from, range.to, issue]);

  const choose = (p: Preset | 'custom'): void => {
    setPreset(p);
    if (p !== 'custom') setRange(rangeOf(p, today));
  };

  const download = async (o: Overview): Promise<void> => {
    try {
      setSaved(`Saved ${await api.saveCsv(csvName(o, section), csvOf(o, section))}`);
    } catch (e) {
      setError(errorText(String(e)));
    }
  };

  return (
    <section aria-label="overview" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Overview</h2>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          aria-label="overview-range"
          value={preset}
          onChange={(e) => choose(e.target.value as Preset | 'custom')}
          style={input(t)}
        >
          {PRESETS.map(([p, label]) => (
            <option key={p} value={p}>
              {label}
            </option>
          ))}
          <option value="custom">Pick dates</option>
        </select>
        <input
          aria-label="overview-from"
          type="date"
          value={range.from}
          max={today}
          onChange={(e) => {
            setPreset('custom');
            setRange((r) => ({ ...r, from: e.target.value }));
          }}
          style={input(t)}
        />
        <span style={{ color: t.muted }}>to</span>
        <input
          aria-label="overview-to"
          type="date"
          value={range.to}
          max={today}
          onChange={(e) => {
            setPreset('custom');
            setRange((r) => ({ ...r, to: e.target.value }));
          }}
          style={input(t)}
        />
        {issue && <span style={{ fontSize: 13, color: t.danger }}>{issue}</span>}
      </div>
      <Notice
        notice={
          error ? { kind: 'error', text: error } : saved ? { kind: 'saved', text: saved } : null
        }
        onDismiss={() => {
          setError(null);
          setSaved(null);
        }}
      />
      {!data && !error && !issue && (
        <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Working it out…</p>
      )}
      {data && (
        <>
          <Tiles t={t} o={data} />
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Chart
              t={t}
              title="Attendance by week"
              label="attendance-chart"
              max={1}
              bars={data.weeks.map((w) => ({
                key: w.week,
                label: weekLabel(w.week),
                parts: [
                  {
                    value: w.shift_days > 0 ? w.shift_days_worked / w.shift_days : 0,
                    color: t.accent,
                  },
                ],
                text: pct(w.shift_days > 0 ? w.shift_days_worked / w.shift_days : null),
              }))}
            />
            <Chart
              t={t}
              title="Late and missed starts by week"
              label="starts-chart"
              legend={[
                ['Late', t.tint.break],
                ['Missed', t.danger],
              ]}
              max={Math.max(1, ...data.weeks.map((w) => w.late_starts + w.missed_starts))}
              bars={data.weeks.map((w) => ({
                key: w.week,
                label: weekLabel(w.week),
                parts: [
                  { value: w.late_starts, color: t.tint.break },
                  { value: w.missed_starts, color: t.danger },
                ],
                text: `${w.late_starts} / ${w.missed_starts}`,
              }))}
            />
          </div>

          <div role="tablist" aria-label="overview-sections" style={{ display: 'flex', gap: 6 }}>
            {SECTIONS.map(([key, label]) => (
              <Button
                key={key}
                role="tab"
                aria-selected={section === key}
                variant="chip"
                onClick={() => setSection(key)}
                style={
                  section === key
                    ? { background: t.accent, color: t.onAccent, borderColor: t.accent }
                    : undefined
                }
              >
                {label}
              </Button>
            ))}
          </div>
          <DataTable
            key={section}
            label={`overview-${section}`}
            rows={data.people}
            rowKey={(p) => p.employee_id}
            search={(p) => p.name}
            searchPlaceholder="Find a person"
            initialSort={{ key: 'name', dir: 'asc' }}
            empty="Nobody in this range."
            toolbar={
              <Button variant="secondary" onClick={() => void download(data)}>
                Download CSV
              </Button>
            }
            columns={[
              { key: 'name', label: 'Person', render: (p) => p.name, sortText: (p) => p.name },
              ...columnsFor(section, t),
            ]}
          />
          <Health t={t} o={data} />
          <p style={{ margin: 0, fontSize: 11.5, color: t.muted }}>
            Attendance is shift days with a clock-in out of shift days; holidays, office days and
            &quot;not working today&quot; don&apos;t count. Late means after the shift-start grace.
            Worked counts work, calls and Away.
          </p>
        </>
      )}
    </section>
  );
}

function columnsFor(section: CsvSection, t: Theme): Column<OverviewPerson>[] {
  switch (section) {
    case 'hours':
      return [
        {
          key: 'attendance',
          label: 'Attendance',
          nowrap: true,
          render: (p) => (
            <span
              style={{ color: p.attendance !== null && p.attendance < 0.8 ? t.danger : t.text }}
            >
              {pct(p.attendance)}
              <span style={{ color: t.muted }}>
                {' '}
                ({p.shift_days_worked}/{p.shift_days})
              </span>
            </span>
          ),
          sortText: (p) => num(p.attendance === null ? null : Math.round(p.attendance * 1000)),
        },
        {
          key: 'days',
          label: 'Days worked',
          nowrap: true,
          render: (p) => p.days_worked,
          sortText: (p) => num(p.days_worked),
        },
        {
          key: 'worked',
          label: 'Hours worked',
          nowrap: true,
          render: (p) => hrs(p.worked_ms),
          sortText: (p) => num(p.worked_ms),
        },
        {
          key: 'scheduled',
          label: 'Scheduled',
          nowrap: true,
          render: (p) => hrs(p.scheduled_ms),
          sortText: (p) => num(p.scheduled_ms),
        },
      ];
    case 'lateness':
      return [
        {
          key: 'late',
          label: 'Late starts',
          nowrap: true,
          render: (p) => p.late_starts,
          sortText: (p) => num(p.late_starts),
        },
        {
          key: 'avg',
          label: 'Average late',
          nowrap: true,
          render: (p) => (p.avg_minutes_late === null ? '—' : `${p.avg_minutes_late}m`),
          sortText: (p) => num(p.avg_minutes_late),
        },
        {
          key: 'missed',
          label: 'Missed starts',
          nowrap: true,
          render: (p) => (
            <span style={{ color: p.missed_starts > 0 ? t.danger : t.text }}>
              {p.missed_starts}
            </span>
          ),
          sortText: (p) => num(p.missed_starts),
        },
      ];
    case 'activity':
      return [
        {
          key: 'idle',
          label: 'Idle',
          nowrap: true,
          render: (p) => `${hrs(p.idle_ms)} · ${pct(p.idle_share)}`,
          sortText: (p) => num(p.idle_ms),
        },
        {
          key: 'breaks',
          label: 'Breaks a day',
          nowrap: true,
          render: (p) => mins(p.break_ms_per_day),
          sortText: (p) => num(p.break_ms_per_day),
        },
        {
          key: 'over',
          label: 'Over limit',
          nowrap: true,
          render: (p) => p.breaks_over_limit,
          sortText: (p) => num(p.breaks_over_limit),
        },
        {
          key: 'away',
          label: 'Away',
          nowrap: true,
          render: (p) => hrs(p.away_ms),
          sortText: (p) => num(p.away_ms),
        },
      ];
  }
}

function Tiles({ t, o }: { t: Theme; o: Overview }): JSX.Element {
  const s = o.totals;
  const tiles: [string, string, string][] = [
    ['Attendance', pct(s.attendance), `${s.shift_days_worked} of ${s.shift_days} shift days`],
    ['Hours worked', hrs(s.worked_ms), `of ${hrs(s.scheduled_ms)} scheduled`],
    [
      'Late starts',
      String(s.late_starts),
      s.avg_minutes_late === null ? 'none' : `${s.avg_minutes_late} min on average`,
    ],
    ['Missed starts', String(s.missed_starts), 'no clock-in on a shift day'],
    ['Idle', pct(s.idle_share), `${hrs(s.idle_ms)} of tracked time`],
  ];
  return (
    <div aria-label="overview-totals" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {tiles.map(([label, value, note]) => (
        <div
          key={label}
          style={{
            flex: '1 1 140px',
            padding: '10px 12px',
            borderRadius: 10,
            border: `1px solid ${t.border}`,
            background: t.surface,
          }}
        >
          <div style={{ fontSize: 12, color: t.muted }}>{label}</div>
          <div style={{ fontSize: 22, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>
            {value}
          </div>
          <div style={{ fontSize: 11.5, color: t.muted }}>{note}</div>
        </div>
      ))}
    </div>
  );
}

interface Bar {
  key: string;
  label: string;
  parts: { value: number; color: string }[];
  /** The number shown over the bar. */
  text: string;
}

/** Vertical bars, stacked when a bar has more than one part. */
function Chart({
  t,
  title,
  label,
  bars,
  max,
  legend,
}: {
  t: Theme;
  title: string;
  label: string;
  bars: readonly Bar[];
  max: number;
  legend?: readonly [string, string][];
}): JSX.Element {
  const HEIGHT = 120;
  return (
    <figure
      aria-label={label}
      style={{
        flex: '1 1 300px',
        margin: 0,
        padding: 12,
        borderRadius: 10,
        border: `1px solid ${t.border}`,
        background: t.surface,
      }}
    >
      <figcaption style={{ display: 'flex', gap: 12, fontSize: 13, marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        {legend?.map(([name, color]) => (
          <span
            key={name}
            style={{ display: 'flex', alignItems: 'center', gap: 4, color: t.muted }}
          >
            <span
              aria-hidden
              style={{ width: 10, height: 10, borderRadius: 2, background: color }}
            />
            {name}
          </span>
        ))}
      </figcaption>
      {bars.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: t.muted }}>No weeks in this range.</p>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: HEIGHT + 34 }}>
          {bars.map((b) => (
            <div
              key={b.key}
              role="img"
              aria-label={`${b.label}: ${b.text}`}
              style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}
            >
              <span
                style={{ fontSize: 11, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
              >
                {b.text}
              </span>
              <div
                style={{
                  height: HEIGHT,
                  display: 'flex',
                  flexDirection: 'column-reverse',
                  background: t.surfaceAlt,
                  borderRadius: 4,
                  overflow: 'hidden',
                }}
              >
                {b.parts.map((p, i) => (
                  <div
                    key={i}
                    style={{
                      height: `${Math.min(100, (p.value / max) * 100)}%`,
                      background: p.color,
                    }}
                  />
                ))}
              </div>
              <span style={{ fontSize: 11, color: t.muted, textAlign: 'center' }}>{b.label}</span>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}

function Health({ t, o }: { t: Theme; o: Overview }): JSX.Element {
  const h = o.health;
  const most = Math.max(1, ...h.versions.map((v) => v.computers));
  const line = (label: string, value: ReactNode): JSX.Element => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
      <span style={{ color: t.muted }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{value}</span>
    </div>
  );
  return (
    <section
      aria-label="overview-health"
      style={{
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        padding: 12,
        borderRadius: 10,
        border: `1px solid ${t.border}`,
        background: t.surface,
      }}
    >
      <div style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Adoption and health</h3>
        {line('People', h.active_people)}
        {line('With the app signed in', `${h.with_app} of ${h.active_people}`)}
        {line('Clocked in this range', `${h.clocked_in} of ${h.active_people}`)}
        {line(
          'Corrections waiting',
          <span style={{ color: h.corrections_waiting > 0 ? t.danger : t.text }}>
            {h.corrections_waiting}
          </span>,
        )}
        {h.never_clocked_in.length > 0 &&
          line(
            'Had shifts, never clocked in',
            <span style={{ color: t.danger }}>
              {h.never_clocked_in.map((p) => p.name).join(', ')}
            </span>,
          )}
      </div>
      <div style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>
          App versions{' '}
          <span style={{ fontWeight: 400, fontSize: 12, color: t.muted }}>
            (computers seen in 30 days
            {h.computers_behind > 0 ? `; ${h.computers_behind} behind ${h.newest_version}` : ''})
          </span>
        </h3>
        {h.versions.map((v) => (
          <div
            key={v.version}
            role="img"
            aria-label={`${v.version}: ${v.computers}`}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
          >
            <span style={{ width: 56, fontVariantNumeric: 'tabular-nums' }}>{v.version}</span>
            <span
              style={{
                height: 10,
                borderRadius: 3,
                width: `${(v.computers / most) * 70}%`,
                minWidth: 4,
                background: v.version === h.newest_version ? t.accent : t.muted,
              }}
            />
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v.computers}</span>
          </div>
        ))}
        {h.versions.length === 0 && (
          <span style={{ fontSize: 13, color: t.muted }}>No computers seen.</span>
        )}
      </div>
    </section>
  );
}
