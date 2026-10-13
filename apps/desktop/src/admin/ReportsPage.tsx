import { useEffect, useState } from 'react';
import { api, type DayReport, type DayReportRow, type DayReportStatus } from '../api.js';
import { localDateOf, LOOKBACK_DAYS, shiftDate } from '../dayHistory.js';
import { EarlierDay } from '../TeamScreen.js';
import { useTheme } from '../ui/theme.js';
import { DataTable, input, Notice } from './DataTable.js';
import {
  endText,
  headline,
  hours,
  shiftText,
  startText,
  STATUS_LABEL,
  STATUS_ORDER,
  workedText,
} from './dayReportModel.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: "Your role can't see reports.",
  date_out_of_range: `Pick a day in the last ${LOOKBACK_DAYS} days.`,
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

const PROBLEMS: ReadonlySet<DayReportStatus> = new Set(['not_clocked_in', 'late']);

/**
 * Reports → Day summary (ADR-0040 §2): each person's day, problems
 * first, the same as the morning email. A Manager sees their team, HR
 * and Administrators everyone; the server decides. A click opens the
 * person's day (for those who can see Team).
 */
export function ReportsPage({ canOpenDays }: { canOpenDays: boolean }): JSX.Element {
  const t = useTheme();
  const today = localDateOf(Date.now());
  const [date, setDate] = useState(() => shiftDate(today, -1));
  const [report, setReport] = useState<DayReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'' | 'problems' | DayReportStatus>('');
  const [open, setOpen] = useState<string | null>(null);

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
  }, [date]);

  const rows = (report?.people ?? []).filter(
    (r) =>
      (status === '' && r.status !== 'off') ||
      (status === 'problems' && PROBLEMS.has(r.status)) ||
      r.status === status,
  );
  const opened = report?.people.find((r) => r.employee_id === open) ?? null;
  const order = (r: DayReportRow): string =>
    `${STATUS_ORDER.indexOf(r.status)}${r.name.toLowerCase()}`;

  return (
    <section aria-label="reports" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Day summary</h2>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          aria-label="report-date"
          type="date"
          value={date}
          min={shiftDate(today, -LOOKBACK_DAYS)}
          max={today}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          style={input(t)}
        />
        {report && (
          <span aria-label="report-headline" style={{ fontSize: 13 }}>
            {headline(report.counts)}
          </span>
        )}
      </div>
      <Notice
        notice={error ? { kind: 'error', text: error } : null}
        onDismiss={() => setError(null)}
      />
      {!report && !error && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}
      {report && (
        <>
          <DataTable
            label="day-report"
            rows={rows}
            rowKey={(r) => r.employee_id}
            search={(r) => r.name}
            searchPlaceholder="Find a person"
            initialSort={{ key: 'status', dir: 'asc' }}
            empty={report.people.length === 0 ? 'Nobody to show.' : 'Nobody matches.'}
            selected={open}
            {...(canOpenDays
              ? {
                  onRowClick: (r: DayReportRow) =>
                    setOpen(open === r.employee_id ? null : r.employee_id),
                }
              : {})}
            toolbar={
              <select
                aria-label="filter-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as typeof status)}
                style={input(t)}
              >
                <option value="">Everyone on shift or working</option>
                <option value="problems">Not clocked in or late</option>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]} ({report.counts[s] ?? 0})
                  </option>
                ))}
              </select>
            }
            columns={[
              { key: 'name', label: 'Person', render: (r) => r.name, sortText: (r) => r.name },
              {
                key: 'status',
                label: 'Status',
                nowrap: true,
                render: (r) => (
                  <span style={{ color: PROBLEMS.has(r.status) ? t.danger : t.text }}>
                    {r.status === 'holiday' && r.holiday ? r.holiday : STATUS_LABEL[r.status]}
                  </span>
                ),
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
          <p style={{ margin: 0, fontSize: 11.5, color: t.muted }}>
            Times are on each shift&apos;s clock. Worked counts work, calls and Away; late means
            after the shift-start grace. {canOpenDays && 'Click a person to see their day.'}
          </p>
          {opened && (
            <div
              aria-label="report-person-day"
              style={{ display: 'flex', flexDirection: 'column' }}
            >
              <h3 style={{ margin: '8px 0 4px', fontSize: 14 }}>
                {opened.name} · {date}
              </h3>
              <EarlierDay id={opened.employee_id} date={date} canCorrect={false} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
