import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { api, type StateView } from './api.js';
import { callName, type BreakKind } from './BreakOnCallDialog.js';
import { formatTimer } from './timelineModel.js';
import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

/** Hover panel stays this long after the mouse leaves (ms). */
const CLOSE_DELAY = 400;

/** Pixels the mouse must travel with the button down before a drag starts. */
const DRAG_SLOP = 4;

/** "6h 12m", "45m". */
function hm(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
}

/**
 * The pinned mini strip (ADR-0017): status light, live timer and one
 * contextual action, always on top. Hover shows today's totals, the
 * break choices and In a meeting. Drag anywhere to move it; double-click or ⤢ to go
 * back to the full window. Clock out is not offered here: it asks
 * first, in the full window.
 */
export function Strip({
  view,
  now,
  label,
  color,
  worked,
  breaks,
  run,
  onUnpin,
}: {
  view: StateView;
  now: number;
  /** Status text, as on the dial. */
  label: string;
  /** Status colour, as on the dial. */
  color: string;
  /** Today's worked and break time (ms). */
  worked: number;
  breaks: number;
  run: (command: () => Promise<StateView>) => void;
  onUnpin: () => void;
}): JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  // A break during a call asks first, inline (owner request).
  const [confirm, setConfirm] = useState<BreakKind | null>(null);
  useEffect(() => {
    if (view.status !== 'on_call') setConfirm(null);
  }, [view.status]);
  const startBreak = (kind: BreakKind): void => {
    if (view.status === 'on_call') setConfirm(kind);
    else run(() => api.startBreak(kind));
  };
  const led = useRef<HTMLSpanElement>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const keepOpen = (): void => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const closeSoon = (): void => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY);
  };
  const attention = view.status === 'idle_pending' || view.longShift;

  // Amber pulse while the idle prompt waits or the shift runs long.
  // Web Animations API: the CSP blocks <style>, so no CSS keyframes.
  useEffect(() => {
    const el = led.current;
    if (!attention || !el || typeof el.animate !== 'function') return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (reduce) return;
    const anim = el.animate(
      [
        { transform: 'scale(1)', boxShadow: `0 0 0 0 ${t.kind.meal_break}` },
        { transform: 'scale(1.25)', boxShadow: `0 0 0 6px transparent` },
      ],
      { duration: 1100, iterations: Infinity, easing: 'ease-out' },
    );
    return () => anim.cancel();
  }, [attention, t.kind.meal_break]);

  const onButton = (e: MouseEvent): boolean => (e.target as HTMLElement).closest('button') !== null;
  const onMouseDown = (e: MouseEvent): void => {
    press.current = e.button === 0 && !onButton(e) ? { x: e.screenX, y: e.screenY } : null;
  };
  const onMouseMove = (e: MouseEvent): void => {
    const p = press.current;
    if (!p || (e.buttons & 1) === 0) {
      press.current = null;
      return;
    }
    if (Math.abs(e.screenX - p.x) + Math.abs(e.screenY - p.y) >= DRAG_SLOP) {
      press.current = null;
      api.startDragging().catch(() => undefined);
    }
  };

  const running = view.sessionStartedAt !== null;
  const ledColor = attention ? t.kind.meal_break : color;

  return (
    <div
      role="region"
      aria-label="pinned-strip"
      title="Drag to move · double-click to open CloudPunch"
      onMouseEnter={keepOpen}
      onMouseLeave={closeSoon}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={() => (press.current = null)}
      onDoubleClick={(e) => {
        if (!onButton(e)) onUnpin();
      }}
      style={{
        boxSizing: 'border-box',
        padding: '10px 10px 10px 14px',
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderLeft: `4px solid ${ledColor}`,
        fontFamily: t.font,
        color: t.text,
        cursor: 'default',
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          ref={led}
          aria-hidden
          style={{ width: 10, height: 10, borderRadius: 999, background: ledColor, flex: 'none' }}
        />
        <div style={{ flex: 1, minWidth: 0, lineHeight: 1.15 }}>
          <div
            aria-label="strip-timer"
            style={{ fontSize: 18, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}
          >
            {running ? formatTimer(now - (view.sessionStartedAt ?? now)) : hm(worked)}
          </div>
          <div
            aria-label="strip-status"
            style={{
              fontSize: 11,
              color: attention ? t.warnText : t.muted,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {view.longShift && view.status !== 'idle_pending'
              ? 'Long shift · open to confirm'
              : running
                ? label
                : `${label} · worked today`}
          </div>
        </div>
        <StripAction view={view} run={run} onOpen={() => setOpen((o) => !o)} />
        <button
          type="button"
          aria-label="Unpin"
          title="Back to the full window"
          onClick={onUnpin}
          style={{
            width: 28,
            height: 28,
            flex: 'none',
            border: 'none',
            borderRadius: 8,
            background: 'none',
            color: t.muted,
            fontSize: 15,
            cursor: 'pointer',
          }}
        >
          ⤢
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            aria-label="strip-totals"
            style={{ fontSize: 11, color: t.muted, fontVariantNumeric: 'tabular-nums' }}
          >
            Today · {hm(worked)} worked · {hm(breaks)} breaks
          </div>
          {confirm && view.status === 'on_call' ? (
            <div role="alertdialog" aria-label="strip-break-on-call">
              <div style={{ fontSize: 12, lineHeight: 1.4, marginBottom: 6 }}>
                You&apos;re on a {callName(view.callType)}. Take a{' '}
                {confirm === 'meal' ? 'meal' : 'bio'} break anyway? The call so far stays counted as
                a call.
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <Button
                  variant="chip"
                  onClick={() => {
                    const kind = confirm;
                    setConfirm(null);
                    run(() => api.startBreak(kind));
                  }}
                >
                  Start break
                </Button>
                <Button variant="chip" onClick={() => setConfirm(null)}>
                  Stay on the call
                </Button>
              </div>
            </div>
          ) : (
            (view.status === 'active' || view.status === 'on_call') && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <Button variant="chip" onClick={() => startBreak('bio')}>
                  Bio break
                </Button>
                <Button variant="chip" onClick={() => startBreak('meal')}>
                  Meal break
                </Button>
                {/* Not offered during a call: it's already tracked (ADR-0009 §2). */}
                {view.status === 'active' && (
                  <Button variant="chip" onClick={() => run(() => api.markAway('meeting'))}>
                    In a meeting
                  </Button>
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** The one action for the current status. */
function StripAction({
  view,
  run,
  onOpen,
}: {
  view: StateView;
  run: (command: () => Promise<StateView>) => void;
  /** Break: shows the bio / meal choice. */
  onOpen: () => void;
}): JSX.Element | null {
  const small = (variant: 'go' | 'primary' | 'secondary', text: ReactNode, onClick: () => void) => (
    <Button
      variant={variant}
      onClick={onClick}
      style={{ width: 'auto', padding: '7px 12px', fontSize: 13, flex: 'none' }}
    >
      {text}
    </Button>
  );
  switch (view.status) {
    case 'clocked_out':
      return small('go', 'Clock in', () => run(api.clockIn));
    case 'on_break':
      return small('primary', 'End break', () => run(api.endBreak));
    case 'away':
      return small('primary', "I'm back", () => run(api.markBack));
    case 'active':
    case 'on_call':
      return small('secondary', 'Break', onOpen);
    case 'idle_pending':
      // The idle prompt window has the answers (ADR-0008).
      return null;
  }
}
