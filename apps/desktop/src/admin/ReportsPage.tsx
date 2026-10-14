import { useEffect, useState } from 'react';
import { api, type DayReport, type DayReportRow } from '../api.js';
import { localDateOf, LOOKBACK_DAYS, shiftDate } from '../dayHistory.js';
import { EarlierDay } from '../TeamScreen.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { DataTable, input, Notice } from './DataTable.js';
import {
  axisOf,
  linkedDate,
  endText,
  FILTER_LABEL,
  hours,
  matches,
  shiftText,
  sortRows,
  startText,
  STATUS_ORDER,
  workedText,
  ZONES,
  type ReportFilter,
  type SortKey,
} from './dayReportModel.js';
import { chartColors, DayTimeline, StatusChip, TimelineLegend } from './DayTimeline.js';
import { OverviewPage } from './OverviewPage.js';
import { InsightsInbox } from './InsightsPage.js';
import type { InsightFilter } from './insightsModel.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: "Your role can't see reports.",
  date_out_of_range: `Pick a day in the last ${LOOKBACK_DAYS} days.`,
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

const FILTERS: readonly ReportFilter[] = [
  'all',
  'attention',
  'not_clocked_in',
  'late',
  'still_in',
  'long_idle',
  'breaks_over',
  'short',
  'long',
  'in_office',
];

const selectedStyle = (t: Theme, on: boolean) =>
  on ? { background: t.accent, color: t.onAccent, borderColor: t.accent } : undefined;

/**
 * Reports → Day summary (ADR-0040 §2; owner, 2026-10-14: "a good visual
 * report that is interactive"): the day's headline numbers, a status
 * bar, filters for what needs attention, and everyone's day as a
 * timeline on one clock (or as a table). A Manager sees their team, HR
 * and Administrators everyone; the server decides. A click opens the
 * person's day (for those who can see Team).
 */
export function ReportsPage({
  canOpenDays,
  canSetOffice = false,
}: {
  canOpenDays: boolean;
  /** HR and Administrators: mark someone in the office that day (ADR-0039). */
  canSetOffice?: boolean;
}): JSX.Element {
  const t = useTheme();
  const c = chartColors(t);
  const today = localDateOf(Date.now());
  const [date, setDate] = useState(() => linkedDate(today) ?? shiftDate(today, -1));
  const [report, setReport] = useState<DayReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReportFilter>('all');
  const [sort, setSort] = useState<SortKey>('problems');
  const [view, setView] = useState<'timeline' | 'table'>('timeline');
  const [tz, setTz] = useState(ZONES[0]?.[0] ?? 'Asia/Kolkata');
  const [open, setOpen] = useState<string | null>(null);
  // Bumped to reload the day after a change made from here.
  const [reloads, setReloads] = useState(0);
  const [officeStatus, setOfficeStatus] = useState<{
    kind: 'saved' | 'error';
    text: string;
  } | null>(null);
  const [officeBusy, setOfficeBusy] = useState(false);
  const now = Date.now();

  useEffect(() => {
    let current = true;
    setReport(null);
    setError(null);
    setOpen(null);
    api.reportDay(date).then(
      (r) => {
        if (current) setReport(r);
      },
      (e: unknown) => {
        if (current) setError(errorText(String(e)));
      },
    );
    return () => {
      current = false;
    };
  }, [date, reloads]);

  // In the office that day, or not after all (ADR-0039): they leave the
  // timeline for the "In office" chip, and come back if undone.
  const setOffice = (r: DayReportRow, inOffice: boolean): void => {
    setOfficeBusy(true);
    setOfficeStatus(null);
    api.adminSetOfficeDay(r.employee_id, date, inOffice, 'From the day summary').then(
      () => {
        setOfficeBusy(false);
        setOfficeStatus({
          kind: 'saved',
          text: inOffice
            ? `${r.name} was in the office on ${date}. They're listed under In office now.`
            : `${r.name} is back on the day summary for ${date}.`,
        });
        setReloads((n) => n + 1);
      },
      (e: unknown) => {
        setOfficeBusy(false);
        setOfficeStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };

  const people = report?.people ?? [];
  const rows = sortRows(
    people.filter((r) => matches(r, filter)),
    sort,
  );
  const opened = people.find((r) => r.employee_id === open) ?? null;
  const counts = report?.counts;
  const onShift = counts ? counts.worked + counts.late + counts.not_clocked_in : 0;
  const clockedIn = counts ? counts.worked + counts.late : 0;
  const worked = people.filter(
    (r) => (r.status === 'worked' || r.status === 'late') && r.shift_ms > 0,
  );
  const avg = (f: (r: DayReportRow) => number): number =>
    worked.length ? worked.reduce((s, r) => s + f(r), 0) / worked.length : 0;
  const late = people.filter((r) => r.status === 'late');
  const avgLate = late.length
    ? late.reduce((s, r) => s + (r.minutes_late ?? 0), 0) / late.length
    : 0;
  const axis = axisOf(rows, tz, now);
  const zoneName = ZONES.find(([z]) => z === tz)?.[1] ?? tz;
  const order = (r: DayReportRow): string =>
    `${STATUS_ORDER.indexOf(r.status)}${r.name.toLowerCase()}`;
  const step = (n: number): void => {
    const d = shiftDate(date, n);
    if (d <= today && d >= shiftDate(today, -LOOKBACK_DAYS)) setDate(d);
  };
  const pct = (n: number): number => (onShift > 0 ? (n / onShift) * 100 : 0);
  const canOpen = canOpenDays || canSetOffice;
  const openRow = canOpen
    ? { onOpen: (r: DayReportRow) => setOpen(open === r.employee_id ? null : r.employee_id) }
    : {};

  return (
    <section aria-label="reports" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650, marginRight: 8 }}>Day summary</h2>
        <Button variant="chip" aria-label="previous day" onClick={() => step(-1)}>
          ‹
        </Button>
        <input
          aria-label="report-date"
          type="date"
          value={date}
          min={shiftDate(today, -LOOKBACK_DAYS)}
          max={today}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          style={input(t)}
        />
        <Button
          variant="chip"
          aria-label="next day"
          disabled={date >= today}
          onClick={() => step(1)}
        >
          ›
        </Button>
        <span style={{ flex: 1 }} />
        <div role="tablist" aria-label="report-view" style={{ display: 'flex', gap: 4 }}>
          {(
            [
              ['timeline', 'Timeline'],
              ['table', 'Table'],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              role="tab"
              aria-selected={view === key}
              variant="chip"
              onClick={() => setView(key)}
              style={selectedStyle(t, view === key)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <Notice
        notice={error ? { kind: 'error', text: error } : null}
        onDismiss={() => setError(null)}
      />
      {officeStatus && (
        <p
          role={officeStatus.kind === 'error' ? 'alert' : 'status'}
          style={{
            margin: 0,
            fontSize: 13,
            color: officeStatus.kind === 'error' ? t.danger : t.text,
          }}
        >
          {officeStatus.text}
        </p>
      )}
      {!report && !error && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}
      {report && counts && (
        <>
          <div aria-label="report-tiles" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Tile
              t={t}
              dot={c.good}
              label="Clocked in"
              value={`${clockedIn} / ${onShift}`}
              note={
                onShift ? `${Math.round(pct(clockedIn))}% of those on shift` : 'nobody on shift'
              }
              onClick={() => setFilter('all')}
            />
            <Tile
              t={t}
              dot={c.warning}
              label="Late"
              value={String(counts.late)}
              note={counts.late ? `${hours(avgLate * 60_000)} late on average` : 'none'}
              onClick={() => setFilter('late')}
            />
            <Tile
              t={t}
              dot={c.critical}
              label="Not clocked in"
              value={String(counts.not_clocked_in)}
              note="had a shift, no clock-in"
              onClick={() => setFilter('not_clocked_in')}
            />
            <Tile
              t={t}
              label="Hours worked"
              value={worked.length ? hours(avg((r) => r.worked_ms)) : '—'}
              note={
                worked.length
                  ? `average, of ${hours(avg((r) => r.shift_ms))} scheduled`
                  : 'nothing worked'
              }
            />
            <Tile
              t={t}
              dot={c.idle}
              label="Idle"
              value={worked.length ? hours(avg((r) => r.idle_ms)) : '—'}
              note="average per person who worked"
              onClick={() => setFilter('long_idle')}
            />
          </div>

          {onShift > 0 && (
            <div
              aria-label="status-bar"
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <div
                style={{
                  display: 'flex',
                  height: 12,
                  borderRadius: 6,
                  overflow: 'hidden',
                  background: t.surfaceAlt,
                  gap: 2,
                }}
              >
                {(
                  [
                    ['all', counts.worked, c.good, 'On time'],
                    ['late', counts.late, c.warning, 'Late'],
                    ['not_clocked_in', counts.not_clocked_in, c.critical, 'Not clocked in'],
                  ] as const
                )
                  .filter(([, n]) => n > 0)
                  .map(([f, n, color, label]) => (
                    <button
                      key={label}
                      type="button"
                      aria-label={`${label}: ${n}`}
                      title={`${label}: ${n}`}
                      onClick={() => setFilter(f)}
                      style={{
                        width: `${pct(n)}%`,
                        border: 'none',
                        padding: 0,
                        background: color,
                        cursor: 'pointer',
                      }}
                    />
                  ))}
              </div>
              <div
                style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: t.muted }}
              >
                <span>
                  <span style={{ color: c.good }}>●</span> On time {counts.worked}
                </span>
                <span>
                  <span style={{ color: c.warning }}>●</span> Late {counts.late}
                </span>
                <span>
                  <span style={{ color: c.critical }}>●</span> Not clocked in{' '}
                  {counts.not_clocked_in}
                </span>
                {counts.not_working + counts.in_office + counts.holiday > 0 && (
                  <span>
                    Also {counts.not_working} not working · {counts.in_office} in office ·{' '}
                    {counts.holiday} on holiday
                  </span>
                )}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <div
              role="tablist"
              aria-label="report-filters"
              style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
            >
              {FILTERS.map((f) => {
                const n = people.filter((r) => matches(r, f)).length;
                if (n === 0 && f !== 'all' && f !== filter) return null;
                return (
                  <Button
                    key={f}
                    role="tab"
                    aria-selected={filter === f}
                    variant="chip"
                    onClick={() => setFilter(f)}
                    style={selectedStyle(t, filter === f)}
                  >
                    {FILTER_LABEL[f]} {n}
                  </Button>
                );
              })}
            </div>
            <span style={{ flex: 1 }} />
            {view === 'timeline' && (
              <>
                <select
                  aria-label="report-sort"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  style={input(t)}
                >
                  <option value="problems">Problems first</option>
                  <option value="start">By start time</option>
                  <option value="hours">Most hours first</option>
                  <option value="name">By name</option>
                </select>
                <select
                  aria-label="report-zone"
                  value={tz}
                  onChange={(e) => setTz(e.target.value)}
                  style={input(t)}
                >
                  {ZONES.map(([z, label]) => (
                    <option key={label} value={z}>
                      {label}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>

          {view === 'timeline' ? (
            rows.length === 0 || !axis ? (
              <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Nobody matches.</p>
            ) : (
              <div
                style={{
                  padding: 12,
                  border: `1px solid ${t.border}`,
                  borderRadius: 10,
                  background: t.surface,
                  overflowX: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <TimelineLegend t={t} />
                <DayTimeline
                  rows={rows}
                  axis={axis}
                  tz={tz}
                  now={now}
                  t={t}
                  open={open}
                  {...openRow}
                />
                <span style={{ fontSize: 11.5, color: t.muted }}>
                  On {zoneName}. Hover for times
                  {canOpen ? '; click a person for their day' : ''}.
                </span>
              </div>
            )
          ) : (
            <DataTable
              label="day-report"
              rows={rows}
              rowKey={(r) => r.employee_id}
              search={(r) => r.name}
              searchPlaceholder="Find a person"
              initialSort={{ key: 'status', dir: 'asc' }}
              empty={people.length === 0 ? 'Nobody to show.' : 'Nobody matches.'}
              selected={open}
              {...(canOpen ? { onRowClick: openRow.onOpen } : {})}
              columns={[
                { key: 'name', label: 'Person', render: (r) => r.name, sortText: (r) => r.name },
                {
                  key: 'status',
                  label: 'Status',
                  nowrap: true,
                  render: (r) => <StatusChip r={r} c={c} />,
                  sortText: order,
                },
                { key: 'shift', label: 'Shift', nowrap: true, render: shiftText },
                {
                  key: 'in',
                  label: 'In',
                  nowrap: true,
                  render: startText,
                  sortText: (r) => String(r.minutes_late ?? -1).padStart(5, '0'),
                },
                { key: 'out', label: 'Out', nowrap: true, render: endText },
                {
                  key: 'worked',
                  label: 'Worked',
                  nowrap: true,
                  render: workedText,
                  sortText: (r) => String(r.worked_ms).padStart(12, '0'),
                },
                {
                  key: 'idle',
                  label: 'Idle',
                  nowrap: true,
                  render: (r) => hours(r.idle_ms),
                  sortText: (r) => String(r.idle_ms).padStart(12, '0'),
                },
                {
                  key: 'breaks',
                  label: 'Breaks',
                  nowrap: true,
                  render: (r) => (
                    <>
                      {hours(r.breaks_ms)}
                      {r.breaks_over_limit > 0 && (
                        <span style={{ color: t.danger }}> · {r.breaks_over_limit} over</span>
                      )}
                    </>
                  ),
                  sortText: (r) => String(r.breaks_ms).padStart(12, '0'),
                },
                {
                  key: 'corrections',
                  label: 'Corrections',
                  nowrap: true,
                  render: (r) =>
                    r.corrections_waiting > 0 ? `${r.corrections_waiting} waiting` : '',
                  sortText: (r) => String(r.corrections_waiting).padStart(4, '0'),
                },
              ]}
            />
          )}
          {opened && (
            <div
              aria-label="report-person-day"
              style={{ display: 'flex', flexDirection: 'column' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h3 style={{ margin: '8px 0 4px', fontSize: 14 }}>
                  {opened.name} · {date}
                </h3>
                {canSetOffice && opened.status === 'in_office' && (
                  <Button
                    variant="chip"
                    disabled={officeBusy}
                    onClick={() => setOffice(opened, false)}
                  >
                    Not in office after all
                  </Button>
                )}
                {canSetOffice &&
                  (opened.status === 'not_clocked_in' ||
                    opened.status === 'not_working' ||
                    opened.status === 'off') && (
                    <Button
                      variant="chip"
                      disabled={officeBusy}
                      onClick={() => setOffice(opened, true)}
                    >
                      Mark in office on this day
                    </Button>
                  )}
                {canSetOffice && (opened.status === 'worked' || opened.status === 'late') && (
                  <span style={{ fontSize: 12, color: t.muted }}>
                    Clocked in that day, so it counts as worked even if they were in the office.
                  </span>
                )}
              </div>
              {canOpenDays && <EarlierDay id={opened.employee_id} date={date} canCorrect={false} />}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** A headline number; a click filters to it. */
function Tile({
  t,
  label,
  value,
  note,
  dot,
  onClick,
}: {
  t: Theme;
  label: string;
  value: string;
  note: string;
  dot?: string;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      style={{
        flex: '1 1 150px',
        textAlign: 'left',
        padding: '10px 12px',
        borderRadius: 10,
        border: `1px solid ${t.border}`,
        background: t.surface,
        color: t.text,
        font: 'inherit',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{ fontSize: 12, color: t.muted }}>
        {dot && <span style={{ color: dot }}>● </span>}
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 650 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: t.muted }}>{note}</div>
    </button>
  );
}

/**
 * Reports in the console: Insights first (ADR-0047 §4), the day summary
 * and Trends (ADR-0040 §2, §3). A number in Trends opens Insights
 * filtered to the people behind it.
 */
export function Reports({
  canOpenDays,
  canSetOffice = false,
}: {
  canOpenDays: boolean;
  canSetOffice?: boolean;
}): JSX.Element {
  const t = useTheme();
  const [tab, setTab] = useState<'insights' | 'day' | 'trends'>('insights');
  // The filter Trends asked for, and a counter so each click starts fresh.
  const [shown, setShown] = useState<{ filter: Partial<InsightFilter>; n: number }>({
    filter: {},
    n: 0,
  });
  const tabs: [typeof tab, string][] = [
    ['insights', 'Insights'],
    ['day', 'Day summary'],
    ['trends', 'Trends'],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div role="tablist" aria-label="report-tabs" style={{ display: 'flex', gap: 6 }}>
        {tabs.map(([key, label]) => (
          <Button
            key={key}
            role="tab"
            aria-selected={tab === key}
            variant="chip"
            onClick={() => setTab(key)}
            style={selectedStyle(t, tab === key)}
          >
            {label}
          </Button>
        ))}
      </div>
      {tab === 'insights' ? (
        <InsightsInbox key={shown.n} initial={shown.filter} />
      ) : tab === 'day' ? (
        <ReportsPage canOpenDays={canOpenDays} canSetOffice={canSetOffice} />
      ) : (
        <OverviewPage
          onShowInsights={(filter) => {
            setShown((s) => ({ filter, n: s.n + 1 }));
            setTab('insights');
          }}
        />
      )}
    </div>
  );
}
