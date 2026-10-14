import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { DayReportRow } from '../api.js';
import type { Theme } from '../ui/theme.js';
import { along, hours, STATUS_LABEL, timeIn, type Axis } from './dayReportModel.js';

/**
 * Everyone's day on one clock (owner, 2026-10-14): a row per person, the
 * shift as a pale band, worked / break / idle as spans on top, a tick at
 * the shift start. Hover a span for its times; click a row for the day.
 * Colours: the validated categorical slots 1–3 (work, idle, break), with
 * a legend and a table view, since light-mode aqua is under 3:1.
 */

export interface ChartColors {
  work: string;
  idle: string;
  break: string;
  band: string;
  grid: string;
  good: string;
  warning: string;
  critical: string;
}

export function chartColors(t: Theme): ChartColors {
  const dark = t.mode === 'dark';
  return {
    work: dark ? '#3987e5' : '#2a78d6',
    idle: dark ? '#d95926' : '#eb6834',
    break: dark ? '#199e70' : '#1baf7a',
    band: dark ? '#2c2c2a' : '#ecebe6',
    grid: dark ? '#2c2c2a' : '#e1e0d9',
    good: '#0ca30c',
    warning: '#fab219',
    critical: '#d03b3b',
  };
}

const KIND_LABEL = { work: 'Worked', break: 'Break', idle: 'Idle' } as const;

/** The status as an icon + label (never colour alone). */
export function StatusChip({ r, c }: { r: DayReportRow; c: ChartColors }): JSX.Element {
  const [icon, color] =
    r.status === 'not_clocked_in'
      ? ['✕', c.critical]
      : r.status === 'late'
        ? ['!', c.warning]
        : r.status === 'worked'
          ? ['✓', c.good]
          : ['–', '#898781'];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
      <span
        aria-hidden
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          background: color,
          color: '#fff',
          fontSize: 10,
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </span>
      {r.status === 'late' && r.minutes_late
        ? `Late +${hours(r.minutes_late * 60_000)}`
        : r.status === 'holiday' && r.holiday
          ? r.holiday
          : STATUS_LABEL[r.status]}
    </span>
  );
}

interface Tip {
  x: number;
  y: number;
  body: ReactNode;
}

export function DayTimeline({
  rows,
  axis,
  tz,
  now,
  t,
  open,
  onOpen,
}: {
  rows: readonly DayReportRow[];
  axis: Axis;
  /** The clock the axis is drawn on. */
  tz: string;
  now: number;
  t: Theme;
  /** The row whose day is open. */
  open: string | null;
  onOpen?: (r: DayReportRow) => void;
}): JSX.Element {
  const c = chartColors(t);
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: React.MouseEvent, body: ReactNode): void => {
    const b = box.current?.getBoundingClientRect();
    if (!b) return;
    setTip({ x: e.clientX - b.left, y: e.clientY - b.top, body });
  };
  const NAME_W = 190;
  const STATUS_W = 120;
  const pos = (iso: string): number => along(axis, Date.parse(iso));
  const track: CSSProperties = { position: 'relative', flex: 1, minWidth: 240, height: 20 };

  return (
    <div
      ref={box}
      role="figure"
      aria-label="day-timeline"
      onMouseLeave={() => setTip(null)}
      style={{ position: 'relative', fontSize: 12.5 }}
    >
      {/* Hour axis */}
      <div style={{ display: 'flex', alignItems: 'flex-end', height: 22 }}>
        <span style={{ width: NAME_W, flexShrink: 0 }} />
        <span style={{ ...track, height: 22 }}>
          {axis.ticks.map((tk) => (
            <span
              key={tk}
              style={{
                position: 'absolute',
                left: `${along(axis, tk)}%`,
                bottom: 2,
                transform: 'translateX(-50%)',
                color: t.muted,
                fontSize: 11,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {timeIn(tz, tk)}
            </span>
          ))}
        </span>
        <span style={{ width: STATUS_W, flexShrink: 0 }} />
      </div>
      <ul aria-label="timeline-rows" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((r) => {
          const selected = open === r.employee_id;
          return (
            <li key={r.employee_id}>
              <button
                type="button"
                aria-label={`${r.name}: ${STATUS_LABEL[r.status]}, ${hours(r.worked_ms)} worked`}
                aria-expanded={onOpen ? selected : undefined}
                onClick={onOpen ? () => onOpen(r) : undefined}
                onMouseMove={(e) =>
                  show(
                    e,
                    <>
                      <strong>{r.name}</strong>
                      <div>
                        {r.shift
                          ? `Shift ${timeIn(tz, Date.parse(r.shift.start))}–${timeIn(tz, Date.parse(r.shift.end))}`
                          : 'No shift'}
                      </div>
                      <div>
                        Worked {hours(r.worked_ms)} · breaks {hours(r.breaks_ms)} · idle{' '}
                        {hours(r.idle_ms)}
                      </div>
                    </>,
                  )
                }
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '5px 0',
                  border: 'none',
                  borderTop: `1px solid ${c.grid}`,
                  background: selected ? t.surfaceAlt : 'none',
                  color: t.text,
                  font: 'inherit',
                  textAlign: 'left',
                  cursor: onOpen ? 'pointer' : 'default',
                }}
              >
                <span
                  style={{
                    width: NAME_W,
                    flexShrink: 0,
                    paddingRight: 10,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontWeight: 550,
                  }}
                >
                  {r.name}
                </span>
                <span style={track}>
                  {/* Hour gridlines */}
                  {axis.ticks.map((tk) => (
                    <span
                      key={tk}
                      aria-hidden
                      style={{
                        position: 'absolute',
                        left: `${along(axis, tk)}%`,
                        top: -5,
                        bottom: -5,
                        width: 1,
                        background: c.grid,
                      }}
                    />
                  ))}
                  {r.shift && (
                    <>
                      <span
                        aria-hidden
                        style={{
                          position: 'absolute',
                          left: `${pos(r.shift.start)}%`,
                          width: `${pos(r.shift.end) - pos(r.shift.start)}%`,
                          top: 2,
                          bottom: 2,
                          borderRadius: 4,
                          background: c.band,
                        }}
                      />
                      <span
                        aria-hidden
                        style={{
                          position: 'absolute',
                          left: `${pos(r.shift.start)}%`,
                          top: -2,
                          bottom: -2,
                          width: 2,
                          background: t.muted,
                          borderRadius: 1,
                        }}
                      />
                    </>
                  )}
                  {(r.segments ?? []).map((s, i) => {
                    const to = s.to;
                    const left = pos(s.from);
                    const width = Math.max(0.3, pos(to) - left);
                    return (
                      <span
                        key={i}
                        aria-hidden
                        onMouseMove={(e) => {
                          e.stopPropagation();
                          show(
                            e,
                            <>
                              <strong>{r.name}</strong>
                              <div>
                                {KIND_LABEL[s.kind]} {timeIn(tz, Date.parse(s.from))}–
                                {timeIn(tz, Date.parse(to))} (
                                {hours(Date.parse(to) - Date.parse(s.from))})
                              </div>
                            </>,
                          );
                        }}
                        style={{
                          position: 'absolute',
                          left: `${left}%`,
                          width: `${width}%`,
                          top: 4,
                          bottom: 4,
                          // A 2px surface gap between neighbours.
                          boxShadow: `0 0 0 1px ${t.surface}`,
                          borderRadius: 3,
                          background: c[s.kind],
                        }}
                      />
                    );
                  })}
                  {r.still_in && (
                    <span
                      aria-hidden
                      title="Still clocked in"
                      style={{
                        position: 'absolute',
                        left: `${along(axis, now)}%`,
                        top: 1,
                        bottom: 1,
                        width: 3,
                        borderRadius: 2,
                        background: c.warning,
                      }}
                    />
                  )}
                </span>
                <span style={{ width: STATUS_W, flexShrink: 0, paddingLeft: 10, fontSize: 12 }}>
                  <StatusChip r={r} c={c} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {tip && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            left: Math.min(tip.x + 12, (box.current?.clientWidth ?? 600) - 230),
            top: tip.y + 14,
            width: 220,
            padding: '8px 10px',
            borderRadius: 8,
            background: t.surface,
            border: `1px solid ${t.border}`,
            boxShadow: '0 6px 18px rgba(0,0,0,0.14)',
            fontSize: 12,
            lineHeight: 1.45,
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          {tip.body}
        </div>
      )}
    </div>
  );
}

/** The legend: identity is never colour alone. */
export function TimelineLegend({ t }: { t: Theme }): JSX.Element {
  const c = chartColors(t);
  const item = (color: string, label: string, swatch?: CSSProperties): JSX.Element => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        aria-hidden
        style={{ width: 14, height: 10, borderRadius: 3, background: color, ...swatch }}
      />
      {label}
    </span>
  );
  return (
    <div
      aria-label="timeline-legend"
      style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: t.muted }}
    >
      {item(c.work, 'Worked (incl. calls, Away)')}
      {item(c.break, 'Break')}
      {item(c.idle, 'Idle')}
      {item(c.band, 'Shift')}
      {item(t.muted, 'Shift start', { width: 2 })}
      {item(c.warning, 'Still clocked in', { width: 3 })}
    </div>
  );
}
