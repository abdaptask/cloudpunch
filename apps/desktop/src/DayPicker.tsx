import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { api } from './api.js';
import { shiftDate } from './dayHistory.js';
import {
  cellReadout,
  cellTooltip,
  heatLevel,
  lookbackSummary,
  pickerRange,
  pickerWeeks,
  rangeTitle,
  type CellTooltip,
  type DaysResult,
  type HeatLevel,
  type PickerCell,
} from './dayPickerModel.js';
import { useTheme, type Theme } from './ui/theme.js';

type DaysState =
  | { status: 'loading' }
  | { status: 'ready'; result: DaysResult }
  | { status: 'error'; code: string };

/** The look-back's totals, fetched fresh each time the picker opens. */
function useDays(from: string, to: string): DaysState {
  const [state, setState] = useState<DaysState>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    api.getDays(from, to).then(
      (result) => {
        if (current) setState({ status: 'ready', result });
      },
      (e: unknown) => {
        if (current) setState({ status: 'error', code: typeof e === 'string' ? e : 'internal' });
      },
    );
    return () => {
      current = false;
    };
  }, [from, to]);
  return state;
}

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** `#rrggbb` at `alpha`. */
function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const HEAT_ALPHA: Record<Exclude<HeatLevel, 0>, number> = { 1: 0.2, 2: 0.42, 3: 0.7, 4: 1 };

function heatFill(t: Theme, level: HeatLevel): string {
  return level === 0 ? t.surfaceAlt : withAlpha(t.kind.working, HEAT_ALPHA[level]);
}

/**
 * Heat calendar of today and the previous 30 days (ADR-0016): cells
 * shaded by hours worked, days with nothing tracked disabled. Hover or
 * focus shows the day's hours; a tap opens that day with its details.
 * Arrow keys move, Enter picks, Escape closes.
 */
export function DayPicker({
  today,
  selected,
  onPick,
  onClose,
}: {
  today: string;
  selected: string;
  onPick: (date: string) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTheme();
  const { from, to } = pickerRange(today);
  const state = useDays(from, to);
  const summaries = state.status === 'ready' ? state.result.days.days : [];
  const weeks = pickerWeeks(today, summaries);
  const cells = weeks.flat().filter((c) => !c.outside);
  // The hovered or focused day, and where its tooltip goes (px in the grid).
  const [tip, setTip] = useState<{ date: string; x: number; y: number } | null>(null);
  const showTip = (date: string, el: HTMLElement): void =>
    setTip({ date, x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop });
  const hideTip = (date: string): void => setTip((p) => (p?.date === date ? null : p));
  const gridRef = useRef<HTMLDivElement>(null);

  // Offline or still loading: every day stays pickable (the day view
  // explains what it can); only a loaded range greys out empty days.
  const loaded = state.status === 'ready';
  const pickable = (c: PickerCell): boolean =>
    !c.outside &&
    (!loaded || c.date === today || c.date === selected || (c.summary?.worked_ms ?? 0) > 0);

  const focusDate = (date: string): void => {
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)?.focus();
  };
  useEffect(() => focusDate(selected), [selected]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    const current = (e.target as HTMLElement).dataset['date'];
    if (step === undefined || current === undefined) return;
    e.preventDefault();
    // Skip greyed days in the direction of travel.
    for (let d = shiftDate(current, step); d >= from && d <= to; d = shiftDate(d, step)) {
      const cell = cells.find((c) => c.date === d);
      if (cell && pickable(cell)) {
        focusDate(d);
        return;
      }
    }
  };

  const tipCell = tip ? (cells.find((c) => c.date === tip.date) ?? null) : null;
  const note =
    state.status === 'error'
      ? state.code === 'offline'
        ? "Offline · hours show when you're online"
        : `Couldn't load hours (${state.code})`
      : state.status === 'ready' && state.result.stale
        ? 'Offline · showing what was loaded earlier'
        : null;

  return (
    <div aria-label="day-picker" role="dialog" style={{ padding: '4px 2px 2px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 650, color: t.text }}>{rangeTitle(today)}</span>
        <button
          type="button"
          aria-label="Close day picker"
          onClick={onClose}
          style={{
            width: 24,
            height: 24,
            border: 'none',
            borderRadius: 999,
            background: 'none',
            color: t.muted,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>
      <div style={gridStyle}>
        {WEEKDAYS.map((d, i) => (
          <span
            key={i}
            aria-hidden
            style={{ fontSize: 10, fontWeight: 600, color: t.muted, textAlign: 'center' }}
          >
            {d}
          </span>
        ))}
      </div>
      <div
        ref={gridRef}
        role="group"
        aria-label="Days"
        aria-busy={state.status === 'loading'}
        onKeyDown={onKeyDown}
        style={{ ...gridStyle, marginTop: 4, position: 'relative' }}
      >
        {weeks
          .flat()
          .map((c) =>
            c.outside ? (
              <span key={c.date} aria-hidden style={{ height: 30 }} />
            ) : (
              <DayCell
                key={c.date}
                cell={c}
                today={today}
                selected={c.date === selected}
                enabled={pickable(c)}
                loading={state.status === 'loading'}
                onShowTip={(el) => showTip(c.date, el)}
                onHideTip={() => hideTip(c.date)}
                onPick={() => onPick(c.date)}
              />
            ),
          )}
        {tip && tipCell && state.status !== 'loading' && (
          <DayTooltip
            tip={cellTooltip(tipCell, today, loaded)}
            x={tip.x}
            y={tip.y}
            width={gridRef.current?.offsetWidth ?? 0}
            clickable={pickable(tipCell)}
          />
        )}
      </div>
      <div
        style={{
          marginTop: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          fontSize: 11,
          color: t.muted,
        }}
      >
        <span aria-label="lookback-summary">
          {note ?? (state.status === 'ready' ? lookbackSummary(summaries) : 'Loading…')}
        </span>
        <span aria-hidden style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          Less
          {([1, 2, 3, 4] as const).map((l) => (
            <span
              key={l}
              style={{ width: 9, height: 9, borderRadius: 2, background: heatFill(t, l) }}
            />
          ))}
          More
        </span>
      </div>
    </div>
  );
}

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(7, 1fr)',
  gap: 4,
};

function DayCell({
  cell,
  today,
  selected,
  enabled,
  loading,
  onShowTip,
  onHideTip,
  onPick,
}: {
  cell: PickerCell;
  today: string;
  selected: boolean;
  enabled: boolean;
  loading: boolean;
  onShowTip: (el: HTMLElement) => void;
  onHideTip: () => void;
  onPick: () => void;
}): JSX.Element {
  const t = useTheme();
  const level = heatLevel(cell.summary?.worked_ms ?? 0);
  const strong = level >= 3;
  const isToday = cell.date === today;
  return (
    <button
      type="button"
      data-date={cell.date}
      aria-label={cellReadout(cell, today)}
      aria-current={selected ? 'date' : undefined}
      // aria-disabled, not disabled: an empty day still shows its tooltip.
      aria-disabled={!enabled}
      // Roving focus: only the selected day is in the tab order.
      tabIndex={selected ? 0 : -1}
      onClick={() => enabled && onPick()}
      onFocus={(e) => onShowTip(e.currentTarget)}
      onBlur={onHideTip}
      onMouseEnter={(e) => onShowTip(e.currentTarget)}
      onMouseLeave={onHideTip}
      style={{
        height: 30,
        padding: 0,
        borderRadius: 7,
        border: isToday ? `1.5px solid ${t.text}` : '1.5px solid transparent',
        background: loading ? t.surfaceAlt : heatFill(t, level),
        color: !enabled ? t.border : strong && !loading ? t.onAccent : t.text,
        fontFamily: t.font,
        fontSize: 11,
        fontWeight: isToday || selected ? 700 : 500,
        fontVariantNumeric: 'tabular-nums',
        cursor: enabled ? 'pointer' : 'default',
        boxShadow: selected ? `0 0 0 2px ${t.surface}, 0 0 0 4px ${t.accent}` : 'none',
        transition: 'background 160ms',
      }}
    >
      {cell.dayOfMonth}
    </button>
  );
}

const TIP_HALF = 80;

/** Floating card above a day: its hours, a breakdown, and "Click for details". */
function DayTooltip({
  tip,
  x,
  y,
  width,
  clickable,
}: {
  tip: CellTooltip;
  x: number;
  y: number;
  /** Grid width, to keep the card inside it. */
  width: number;
  clickable: boolean;
}): JSX.Element {
  const t = useTheme();
  const left = width > 2 * TIP_HALF ? Math.min(Math.max(x, TIP_HALF), width - TIP_HALF) : x;
  return (
    <div
      role="tooltip"
      aria-label="day-tooltip"
      style={{
        position: 'absolute',
        left,
        top: y - 6,
        transform: 'translate(-50%, -100%)',
        zIndex: 2,
        pointerEvents: 'none',
        padding: '7px 10px',
        borderRadius: 8,
        background: t.text,
        color: t.bg,
        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.22)',
        whiteSpace: 'nowrap',
        textAlign: 'left',
        fontSize: 11,
        lineHeight: 1.35,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <div style={{ fontWeight: 700 }}>{tip.title}</div>
      <div style={{ fontSize: 13, fontWeight: 650 }}>{tip.worked}</div>
      {tip.detail && <div style={{ opacity: 0.8 }}>{tip.detail}</div>}
      {clickable && <div style={{ opacity: 0.65, marginTop: 2 }}>Click for details</div>}
    </div>
  );
}
