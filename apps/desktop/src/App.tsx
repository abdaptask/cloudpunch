import { useRef, type CSSProperties, type ReactNode } from 'react';
import { api, type StateView } from './api.js';
import { TimelineView } from './TimelineView.js';
import {
  formatClock,
  formatDuration,
  formatTimer,
  groupOf,
  KIND_LABEL,
  KIND_ORDER,
  totalsByKind,
  WORKING_PART_LABEL,
  type SegmentKind,
} from './timelineModel.js';
import { Button } from './ui/Button.js';
import { useTheme, type Theme } from './ui/theme.js';
import { useAgentState } from './useAgentState.js';
import { useFitWindow } from './useFitWindow.js';
import { useNow } from './useNow.js';

/**
 * Home window (Timeline view). State lives in the Rust agent; this
 * renders the current `StateView` and invokes commands. The idle
 * prompt opens in its own window.
 *
 * Calls show as "On a call" here, on the employee's own screen;
 * reports and manager views still count them as active (ADR-0011).
 */

function statusLabel(v: StateView): string {
  switch (v.status) {
    case 'clocked_out':
      return 'Not clocked in';
    case 'active':
      return 'Clocked in';
    case 'on_call':
      return CALL_STATUS[v.callType ?? 'other'];
    case 'idle_pending':
      return 'Clocked in — are you still there?';
    case 'on_break':
      return v.breakKind === 'meal' ? 'On a meal break' : 'On a bio break';
    case 'away':
      return KIND_LABEL[awayKind(v)];
  }
}

function awayKind(v: StateView): 'away_meeting' | 'away_phone' | 'away_working' {
  if (v.awayReason === 'meeting') return 'away_meeting';
  if (v.awayReason === 'phone_call') return 'away_phone';
  return 'away_working';
}

function statusColor(t: Theme, v: StateView): string {
  switch (v.status) {
    case 'clocked_out':
      return t.muted;
    case 'on_break':
      return t.kind[
        v.breakKind === 'meal'
          ? 'meal_break'
          : v.breakKind === 'other'
            ? 'other_break'
            : 'bio_break'
      ];
    case 'away':
      return t.kind[awayKind(v)];
    case 'idle_pending':
      return t.kind.prompt;
    case 'active':
      return t.kind.working;
    case 'on_call':
      return t.kind[CALL_KIND[v.callType ?? 'other']];
  }
}

type CallTypeName = 'teams' | 'zoom' | 'other';

const CALL_STATUS: Record<CallTypeName, string> = {
  teams: 'On a Teams call',
  zoom: 'On a Zoom call',
  other: 'On a call',
};

const CALL_KIND: Record<CallTypeName, SegmentKind> = {
  teams: 'call_teams',
  zoom: 'call_zoom',
  other: 'call_other',
};

const ERROR_TEXT: Record<string, string> = {
  invalid_transition: "That action isn't available right now.",
};

export function App(): JSX.Element {
  const t = useTheme();
  const { view, error, run } = useAgentState();
  const now = useNow();
  const mainRef = useRef<HTMLElement>(null);
  useFitWindow(mainRef);

  return (
    <main
      ref={mainRef}
      style={{
        fontFamily: t.font,
        color: t.text,
        background: t.bg,
        boxSizing: 'border-box',
        padding: '20px 20px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 650, letterSpacing: -0.2 }}>
          CloudPunch
        </h1>
        <span style={{ fontSize: 12, color: t.muted }}>{formatClock(now)}</span>
      </header>

      <section
        aria-label="current-status"
        style={{
          ...card(t),
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden
            style={{
              width: 9,
              height: 9,
              borderRadius: 999,
              background: view ? statusColor(t, view) : t.border,
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {view ? statusLabel(view) : 'Loading…'}
          </span>
        </div>
        {view?.sessionStartedAt != null ? (
          <>
            <div
              aria-label="session-timer"
              style={{
                fontSize: 38,
                fontWeight: 600,
                letterSpacing: -0.5,
                fontVariantNumeric: 'tabular-nums',
                marginTop: 4,
              }}
            >
              {formatTimer(now - view.sessionStartedAt)}
            </div>
            <div style={{ fontSize: 12, color: t.muted }}>
              since {formatClock(view.sessionStartedAt)}
            </div>
          </>
        ) : (
          view && (
            <div style={{ fontSize: 13, color: t.muted, marginTop: 2 }}>
              Clock in to start tracking your day.
            </div>
          )
        )}
      </section>

      {view?.status === 'clocked_out' && view.autoClockedOutAt !== null && (
        <p
          role="status"
          style={{
            margin: 0,
            padding: '10px 12px',
            borderRadius: 10,
            fontSize: 13,
            lineHeight: 1.4,
            background: t.warnBg,
            color: t.warnText,
          }}
        >
          You were clocked out at {formatClock(view.autoClockedOutAt)} because the idle prompt
          wasn&apos;t answered. Time up to when the prompt appeared is kept.
        </p>
      )}

      {view && (
        <section aria-label="actions" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Actions view={view} run={run} />
        </section>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger }}>
          {ERROR_TEXT[error] ?? `Something went wrong (${error}).`}
        </p>
      )}

      {view && (
        <section aria-label="today" style={card(t)}>
          <h2 style={sectionTitle(t)}>Today</h2>
          <TimelineView segments={view.timeline} now={now} />
        </section>
      )}

      {view && view.timeline.length > 0 && <Footer view={view} now={now} />}
    </main>
  );
}

function Actions({
  view,
  run,
}: {
  view: StateView;
  run: (command: () => Promise<StateView>) => void;
}): JSX.Element {
  const chips = (children: ReactNode): JSX.Element => (
    <div style={{ display: 'flex', gap: 8 }}>{children}</div>
  );
  switch (view.status) {
    case 'clocked_out':
      return (
        <Button variant="primary" onClick={() => run(api.clockIn)}>
          Clock in
        </Button>
      );
    case 'active':
    case 'on_call':
      return (
        <>
          <Button variant="primary" onClick={() => run(api.clockOut)}>
            Clock out
          </Button>
          {chips(
            <>
              <Button variant="chip" onClick={() => run(() => api.startBreak('bio'))}>
                Bio break
              </Button>
              <Button variant="chip" onClick={() => run(() => api.startBreak('meal'))}>
                Meal break
              </Button>
            </>,
          )}
          {/* Not offered during a call: it's already tracked (ADR-0009 §2). */}
          {view.status === 'active' &&
            chips(
              <Button variant="chip" onClick={() => run(() => api.markAway('meeting'))}>
                In a meeting
              </Button>,
            )}
        </>
      );
    case 'idle_pending':
      return (
        <Button variant="primary" onClick={() => run(api.clockOut)}>
          Clock out
        </Button>
      );
    case 'on_break':
      return (
        <>
          <Button variant="primary" onClick={() => run(api.endBreak)}>
            End break
          </Button>
          <Button variant="secondary" onClick={() => run(api.clockOut)}>
            Clock out
          </Button>
        </>
      );
    case 'away':
      return (
        <>
          <Button variant="primary" onClick={() => run(api.markBack)}>
            I&apos;m back
          </Button>
          <Button variant="secondary" onClick={() => run(api.clockOut)}>
            Clock out
          </Button>
        </>
      );
  }
}

function Footer({ view, now }: { view: StateView; now: number }): JSX.Element {
  const t = useTheme();
  const byKind = totalsByKind(view.timeline, now);
  const present = KIND_ORDER.filter((k) => (byKind[k] ?? 0) > 0);
  const workingParts = present.filter((k) => groupOf(k) === 'working');
  const otherRows = present.filter((k) => groupOf(k) !== 'working');
  const workingTotal = workingParts.reduce((sum, k) => sum + (byKind[k] ?? 0), 0);
  // Only break Working down when it's more than plain computer time.
  const showParts = workingParts.some((k) => k !== 'working');
  const onTheClock = Object.values(byKind).reduce((a, b) => a + b, 0);
  const dot = (k: SegmentKind): JSX.Element => (
    <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: t.kind[k] }} />
  );
  return (
    <footer aria-label="totals" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <section style={card(t)}>
        <h2 style={sectionTitle(t)}>Today&apos;s totals</h2>
        <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={totalRow}>
            <dt style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              {dot('working')}
              Working
            </dt>
            <dd style={totalValue}>{formatDuration(workingTotal)}</dd>
          </div>
          {showParts &&
            workingParts.map((k) => (
              <div key={k} style={{ ...totalRow, paddingLeft: 16 }}>
                <dt
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    color: t.muted,
                  }}
                >
                  {dot(k)}
                  {WORKING_PART_LABEL[k] ?? KIND_LABEL[k]}
                </dt>
                <dd style={{ ...totalValue, fontSize: 12, color: t.muted }}>
                  {formatDuration(byKind[k] ?? 0)}
                </dd>
              </div>
            ))}
          {otherRows.map((k) => (
            <div key={k} style={totalRow}>
              <dt style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                {dot(k)}
                {KIND_LABEL[k]}
              </dt>
              <dd style={totalValue}>{formatDuration(byKind[k] ?? 0)}</dd>
            </div>
          ))}
          <div
            style={{
              ...totalRow,
              borderTop: `1px solid ${t.border}`,
              paddingTop: 8,
              marginTop: 2,
            }}
          >
            <dt style={{ fontSize: 13, fontWeight: 600 }}>On the clock</dt>
            <dd style={{ ...totalValue, fontWeight: 600 }}>{formatDuration(onTheClock)}</dd>
          </div>
        </dl>
      </section>
      <p style={{ margin: 0, fontSize: 11, lineHeight: 1.4, color: t.muted }}>
        Tracked on this device, to the second. Paid hours come from your approved timesheet, which
        applies break and prompt rules.
      </p>
    </footer>
  );
}

const totalRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const totalValue: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
};

function card(t: Theme): CSSProperties {
  return {
    background: t.surface,
    border: `1px solid ${t.border}`,
    borderRadius: 14,
    padding: 16,
  };
}

function sectionTitle(t: Theme): CSSProperties {
  return {
    margin: '0 0 12px',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: t.muted,
  };
}
