import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api, type InsightKind, type Overview, type OverviewPerson } from '../api.js';
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
  refusalText,
  rangeIssue,
  rangeOf,
  weekLabel,
  type CsvSection,
  type Preset,
} from './overviewModel.js';
import { byTeam, delta, previousRange, type Delta, type InsightFilter } from './insightsModel.js';

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
 * Reports → Trends (ADR-0040 §3, redesigned by ADR-0047 §4), for HR and
 * Administrators: each headline against the previous period of the same
 * length, by team, late and missed starts week by week, a table per area
 * (each a CSV download), and adoption and health. The numbers that
 * point at people open the matching findings in Insights.
 */
export function OverviewPage({
  onShowInsights,
}: {
  /** Open Insights filtered to these findings. */
  onShowInsights?: (filter: Partial<InsightFilter>) => void;
} = {}): JSX.Element {
  const t = useTheme();
  const today = localDateOf(Date.now());
  const [preset, setPreset] = useState<Preset | 'custom'>('last_week');
  const [range, setRange] = useState(() => rangeOf('last_week', today));
  const [data, setData] = useState<Overview | null>(null);
  // The period of the same length just before, for "up 6 on …".
  const [prev, setPrev] = useState<Overview | null>(null);
  // Who reports to whom, for the team breakdown.
  const [managerOf, setManagerOf] = useState<Map<string, string | null> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [section, setSection] = useState<CsvSection>('hours');
  const issue = rangeIssue(range.from, range.to);

  useEffect(() => {
    if (issue) return;
    let current = true;
    setData(null);
    setError(null);
    setPrev(null);
    api.reportOverview(range.from, range.to).then(
      (o) => {
        if (current) setData(o);
      },
      (e: unknown) => {
        if (current) setError(errorText(String(e)));
      },
    );
    const before = previousRange(range.from, range.to);
    api.reportOverview(before.from, before.to).then(
      (o) => {
        if (current) setPrev(o);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [range.from, range.to, issue]);

  useEffect(() => {
    api.adminEmployees().then(
      (r) => {
        const names = new Map(r.employees.map((e) => [e.id, e.name]));
        setManagerOf(
          new Map(
            r.employees.map((e) => [
              e.id,
              e.reporting_manager_id ? (names.get(e.reporting_manager_id) ?? null) : null,
            ]),
          ),
        );
      },
      () => setManagerOf(new Map()),
    );
  }, []);

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
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Trends</h2>
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
          <Tiles
            t={t}
            o={data}
            prev={prev}
            days={periodDays(range.from, range.to)}
            {...(onShowInsights ? { onShow: onShowInsights } : {})}
          />
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }}>
            {managerOf && (
              <Teams
                t={t}
                rows={byTeam(data, managerOf)}
                {...(onShowInsights ? { onShow: onShowInsights } : {})}
              />
            )}
            <Chart
              t={t}
              title="Late and missed starts by week"
              label="starts-chart"
              legend={[
                ['Late', STATUS_WARNING],
                ['Missed', STATUS_CRITICAL],
              ]}
              max={Math.max(1, ...data.weeks.map((w) => w.late_starts + w.missed_starts))}
              bars={data.weeks.map((w) => ({
                key: w.week,
                label: weekLabel(w.week),
                parts: [
                  { value: w.late_starts, color: STATUS_WARNING },
                  { value: w.missed_starts, color: STATUS_CRITICAL },
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

/** Reserved status colours (dataviz): late = warning, missed = critical. */
const STATUS_WARNING = '#fab219';
const STATUS_CRITICAL = '#d03b3b';
const STATUS_GOOD = '#0ca30c';

const periodDays = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** "on the previous 7 days". */
const versus = (days: number): string =>
  days === 7 ? 'on the week before' : `on the previous ${days} days`;

function Tiles({
  t,
  o,
  prev,
  days,
  onShow,
}: {
  t: Theme;
  o: Overview;
  prev: Overview | null;
  days: number;
  onShow?: (filter: Partial<InsightFilter>) => void;
}): JSX.Element {
  const s = o.totals;
  const p = prev?.totals ?? null;
  const tiles: {
    label: string;
    value: string;
    note: string;
    change: Delta;
    kind?: InsightKind;
  }[] = [
    {
      label: 'Attendance',
      value: pct(s.attendance),
      note: `${s.shift_days_worked} of ${s.shift_days} shift days`,
      change: delta(s.attendance, p?.attendance ?? null, true, true),
      kind: 'missed_starts',
    },
    {
      label: 'Late starts',
      value: String(s.late_starts),
      note: s.avg_minutes_late === null ? 'none' : `${s.avg_minutes_late} min late on average`,
      change: delta(s.late_starts, p?.late_starts ?? null, false),
      kind: 'late_starts',
    },
    {
      label: 'Missed starts',
      value: String(s.missed_starts),
      note: 'shift days with no clock-in',
      change: delta(s.missed_starts, p?.missed_starts ?? null, false),
      kind: 'missed_starts',
    },
    {
      label: 'Hours worked',
      value: hrs(s.worked_ms),
      note: `of ${hrs(s.scheduled_ms)} scheduled`,
      change: delta(s.worked_ms / 3_600_000, p ? p.worked_ms / 3_600_000 : null, true),
      kind: 'short_days',
    },
    {
      label: 'Idle',
      value: pct(s.idle_share),
      note: `${hrs(s.idle_ms)} of tracked time`,
      change: delta(s.idle_share, p?.idle_share ?? null, false, true),
      kind: 'long_idle',
    },
  ];
  const toneColor = (d: Delta): string =>
    d.tone === 'good' ? STATUS_GOOD : d.tone === 'bad' ? t.danger : t.muted;
  return (
    <div aria-label="overview-totals" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {tiles.map((x) => {
        const body = (
          <>
            <div style={{ fontSize: 12, color: t.muted }}>{x.label}</div>
            <div style={{ fontSize: 22, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>
              {x.value}
            </div>
            <div style={{ fontSize: 11.5, color: t.muted }}>{x.note}</div>
            {x.change.text && (
              <div aria-label={`${x.label} change`} style={{ fontSize: 11.5, marginTop: 2 }}>
                <span style={{ color: toneColor(x.change), fontWeight: 600 }}>
                  {x.change.tone === 'good' ? '▲ ' : x.change.tone === 'bad' ? '▼ ' : ''}
                  {x.change.text}
                </span>{' '}
                <span style={{ color: t.muted }}>{versus(days)}</span>
              </div>
            )}
          </>
        );
        const box: CSSProperties = {
          flex: '1 1 150px',
          padding: '10px 12px',
          borderRadius: 10,
          border: `1px solid ${t.border}`,
          background: t.surface,
          color: t.text,
          font: 'inherit',
          textAlign: 'left',
        };
        return onShow && x.kind ? (
          <button
            key={x.label}
            type="button"
            title={`See the people behind ${x.label.toLowerCase()} in Insights`}
            onClick={() => onShow({ kind: x.kind ?? '' })}
            style={{ ...box, cursor: 'pointer' }}
          >
            {body}
          </button>
        ) : (
          <div key={x.label} style={box}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** Per team: attendance as a bar, late and missed as numbers that open Insights. */
function Teams({
  t,
  rows,
  onShow,
}: {
  t: Theme;
  rows: readonly ReturnType<typeof byTeam>[number][];
  onShow?: (filter: Partial<InsightFilter>) => void;
}): JSX.Element {
  const bar = t.mode === 'dark' ? '#3987e5' : '#2a78d6';
  const count = (n: number, team: string, kind: InsightKind, label: string): JSX.Element =>
    onShow && n > 0 ? (
      <button
        type="button"
        aria-label={`${n} ${label} in ${team}`}
        onClick={() => onShow({ kind, manager: team })}
        style={{
          padding: 0,
          border: 'none',
          background: 'none',
          color: t.accent,
          font: 'inherit',
          cursor: 'pointer',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {n}
      </button>
    ) : (
      <span style={{ color: n > 0 ? t.text : t.muted, fontVariantNumeric: 'tabular-nums' }}>
        {n}
      </span>
    );
  return (
    <figure
      aria-label="teams"
      style={{
        flex: '1 1 320px',
        margin: 0,
        padding: 12,
        borderRadius: 10,
        border: `1px solid ${t.border}`,
        background: t.surface,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <figcaption style={{ fontSize: 13, fontWeight: 600 }}>By team</figcaption>
      <div
        aria-hidden
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(110px, 1.2fr) 2fr 44px 52px',
          gap: 8,
          fontSize: 11.5,
          color: t.muted,
        }}
      >
        <span>Team</span>
        <span>Attendance</span>
        <span>Late</span>
        <span>Missed</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.team}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(110px, 1.2fr) 2fr 44px 52px',
            gap: 8,
            alignItems: 'center',
            fontSize: 12.5,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.team === 'No manager' ? r.team : `${r.team}'s team`}
            <span style={{ color: t.muted }}> · {r.people}</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                flex: 1,
                height: 8,
                borderRadius: 4,
                background: t.surfaceAlt,
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${Math.round((r.attendance ?? 0) * 100)}%`,
                  background: bar,
                  borderRadius: 4,
                }}
              />
            </span>
            <span style={{ width: 34, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {pct(r.attendance)}
            </span>
          </span>
          {count(r.late, r.team, 'late_starts', 'late starts')}
          {count(r.missed, r.team, 'missed_starts', 'missed starts')}
        </div>
      ))}
    </figure>
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
        {(h.refused ?? []).length > 0 && (
          <div
            aria-label="uploads-refused"
            style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            <span style={{ fontSize: 13, color: t.danger }}>Uploads refused</span>
            {(h.refused ?? []).map((r) => (
              <span
                key={`${r.employee_id}-${r.reason}-${r.os ?? ''}`}
                style={{ fontSize: 12.5, lineHeight: 1.4 }}
              >
                <strong style={{ fontWeight: 600 }}>{r.name}</strong>
                {r.os ? ` (${r.os === 'macos' ? 'Mac' : 'Windows'})` : ''}:{' '}
                {refusalText(r.reason, r.ahead_seconds)}
                <span style={{ color: t.muted }}>
                  {' '}
                  · {r.events} event{r.events === 1 ? '' : 's'} · last{' '}
                  {new Date(r.last_at).toLocaleString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </span>
            ))}
          </div>
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
