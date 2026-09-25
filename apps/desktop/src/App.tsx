import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, type StateView } from './api.js';
import { ClockOutDialog } from './ClockOutDialog.js';
import { DayDial } from './DayDial.js';
import {
  dayEnd,
  dayLabel,
  daySegments,
  localDateOf,
  LOOKBACK_DAYS,
  recordedElsewhere,
  shiftDate,
  tintFor,
  zoneNote,
} from './dayHistory.js';
import { CloseDialog, LongShiftBanner, rememberedKeepRunning } from './CloseDialog.js';
import { TimelineView } from './TimelineView.js';
import {
  formatClock,
  formatDuration,
  formatTimer,
  groupOf,
  KIND_LABEL,
  KIND_ORDER,
  today,
  totals,
  totalsByKind,
  WORKING_PART_LABEL,
  type Segment,
  type SegmentKind,
} from './timelineModel.js';
import { Button } from './ui/Button.js';
import { Logo } from './ui/Logo.js';
import { useTheme, type Theme } from './ui/theme.js';
import { SignIn } from './SignIn.js';
import { useAgentState } from './useAgentState.js';
import { useAuth } from './useAuth.js';
import { useDay } from './useDay.js';
import { useEnrollment } from './useEnrollment.js';
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

/** Tracked time today and when the last session ended (clocked out). */
function dayOf(v: StateView, now: number): { worked: number; lastOut: number | null } {
  const rows = today(v.timeline, now);
  if (rows.length === 0) return { worked: 0, lastOut: null };
  return {
    worked: totals(v.timeline, now).working,
    lastOut: Math.max(...rows.map((r) => r.endedAt)),
  };
}

/** Clocked out: a hint that knows whether the day has started. */
function clockedOutHint(v: StateView, now: number): string {
  const { worked, lastOut } = dayOf(v, now);
  if (lastOut === null) return 'Ready to start? Clock in when you begin work.';
  return `${formatWorked(worked)} worked today · clocked out at ${formatClock(lastOut)}. Clock in again to continue.`;
}

/** "6h 12m" / "25m" / "under a minute". */
function formatWorked(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'Under a minute';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function statusLabel(v: StateView, now: number): string {
  switch (v.status) {
    case 'clocked_out':
      return dayOf(v, now).lastOut === null ? 'Not clocked in' : 'Clocked out';
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

/** Why enrollment blocks clocking in (2b.4 F3b); `clock_in` returns the same codes. */
const ENROLL_TEXT: Record<string, string> = {
  no_user: "Your account isn't set up in CloudPunch yet. Contact HR.",
  no_employee: "Your account isn't linked to an employee record. Contact HR.",
  clock_not_allowed: "Clocking in isn't enabled for your account. Contact HR.",
  device_revoked: 'This computer has been removed from CloudPunch. Contact IT.',
  device_conflict: 'This computer is registered to someone else. Contact IT.',
};

function enrollText(code: string | null): string {
  return (
    (code && ENROLL_TEXT[code]) ??
    `CloudPunch couldn't register this computer (${code}). Contact IT.`
  );
}

const ERROR_TEXT: Record<string, string> = {
  invalid_transition: "That action isn't available right now.",
  // First clock-in on this computer waits for enrollment (2b.4 F3c).
  not_enrolled: 'Connecting to CloudPunch… try again in a moment.',
  ...ENROLL_TEXT,
};

export function App(): JSX.Element {
  const t = useTheme();
  const { view, error, run } = useAgentState();
  const now = useNow();
  const mainRef = useRef<HTMLElement>(null);
  useFitWindow(mainRef);
  const { auth, busy, error: authError, signIn, cancelSignIn, signOut } = useAuth();
  const signedIn = auth?.signedIn === true;
  const enrollment = useEnrollment();
  const enrollBlocked = signedIn && enrollment?.state === 'blocked';
  const [closeAsked, setCloseAsked] = useState(false);
  // Clock out asks first and offers a break instead (owner request).
  const [clockOutAsked, setClockOutAsked] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const askClockOut = (): void => setClockOutAsked(true);

  // Past days (ADR-0016): null shows today, live.
  const [viewDate, setViewDate] = useState<string | null>(null);
  const todayDate = localDateOf(now);
  const pastDate = viewDate !== null && viewDate < todayDate ? viewDate : null;
  const past = useDay(signedIn ? pastDate : null);
  const pastDay = past.status === 'ready' ? past.result : null;
  const pastSegs: Segment[] = pastDay ? daySegments(pastDay.day) : [];
  const pastEnd = dayEnd(pastSegs);
  useEffect(() => {
    if (!signedIn) setViewDate(null);
  }, [signedIn]);
  // What the stats and details show: today live, or the past day whole.
  const shownSegs = pastDate ? pastSegs : (view?.timeline ?? []);
  const shownNow = pastDate ? (pastEnd ?? now) : now;
  const shownSince = pastDate ? -Infinity : undefined;

  // The close button asks first, unless "keep running" was remembered
  // (ADR-0013 §1). The tray's Quit while clocked in lands here too.
  useEffect(() => {
    const off = api.onCloseRequested(() => {
      if (rememberedKeepRunning()) void api.hideToTray();
      else setCloseAsked(true);
    });
    return () => void off.then((fn) => fn());
  }, []);
  const clockedIn = view !== null && view.status !== 'clocked_out';

  return (
    <main
      ref={mainRef}
      style={{
        fontFamily: t.font,
        color: t.text,
        // Signed out: a quiet branded backdrop behind the sign-in card.
        background:
          auth && !signedIn
            ? t.mode === 'dark'
              ? 'linear-gradient(160deg, #0b1a33 0%, #0f1115 65%)'
              : 'linear-gradient(160deg, #e6f1ff 0%, #f4f5f8 60%)'
            : t.bg,
        boxSizing: 'border-box',
        padding: '14px 16px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {/* Signed out, the sign-in card carries the brand; no header. */}
      {signedIn && (
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{ margin: 0, lineHeight: 0 }}>
            <Logo height={24} />
          </h1>
          <span style={{ fontSize: 12, color: t.muted }}>
            {signedIn && (auth.name ?? auth.username) && (
              <>
                {auth.name ?? auth.username}
                {view?.status === 'clocked_out' && (
                  <>
                    {' · '}
                    <button type="button" onClick={signOut} style={linkButton(t)}>
                      Sign out
                    </button>
                  </>
                )}
                {' · '}
              </>
            )}
            {formatClock(now)}
          </span>
        </header>
      )}

      {closeAsked && (
        <CloseDialog
          clockedIn={clockedIn}
          onKeepRunning={() => {
            setCloseAsked(false);
            void api.hideToTray();
          }}
          onQuit={() => {
            setCloseAsked(false);
            void (clockedIn ? api.clockOutAndQuit() : api.quitApp());
          }}
          onCancel={() => setCloseAsked(false)}
        />
      )}
      {clockOutAsked && view && (
        <ClockOutDialog
          offerBreaks={view.status === 'active' || view.status === 'on_call'}
          onClockOut={() => {
            setClockOutAsked(false);
            run(api.clockOut);
          }}
          onBreak={(kind) => {
            setClockOutAsked(false);
            run(() => api.startBreak(kind));
          }}
          onCancel={() => setClockOutAsked(false)}
        />
      )}
      {signedIn && view?.longShift && view.sessionStartedAt !== null && (
        <LongShiftBanner
          hours={formatHours(now - view.sessionStartedAt)}
          onStillWorking={() => run(api.ackLongShift)}
          onClockOut={askClockOut}
        />
      )}
      {!auth && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}
      {auth && !signedIn && (
        <SignIn busy={busy} error={authError} onSignIn={signIn} onCancel={cancelSignIn} />
      )}
      {signedIn && authError === 'clock_out_first' && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger }}>
          Clock out before signing out.
        </p>
      )}
      {auth && !signedIn && (auth.unsentKept ?? 0) > 0 && (
        <p role="status" style={{ margin: 0, fontSize: 13, color: t.muted }}>
          Signed out. {auth.unsentKept === 1 ? '1 event' : `${auth.unsentKept} events`} will be sent
          the next time you sign in on this computer.
        </p>
      )}
      {enrollBlocked && (
        <p
          role="alert"
          aria-label="enrollment"
          style={{ margin: 0, fontSize: 13, color: t.danger }}
        >
          {enrollText(enrollment.code)}
        </p>
      )}
      {signedIn && (
        <>
          <section
            aria-label="current-status"
            style={{ ...card(t), padding: '8px 12px 12px', textAlign: 'center' }}
          >
            <DayNav
              date={pastDate ?? todayDate}
              today={todayDate}
              onChange={(d) => setViewDate(d >= todayDate ? null : d)}
            />
            {pastDate ? (
              <PastDial
                state={past}
                segments={pastSegs}
                end={pastEnd}
                date={pastDate}
                today={todayDate}
              />
            ) : (
              <DayDial
                segments={view?.timeline ?? []}
                now={now}
                tint={view ? t.tint[tintFor(view.status)] : undefined}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 650,
                    letterSpacing: 0.6,
                    textTransform: 'uppercase',
                    color: view ? statusColor(t, view) : t.muted,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      background: view ? statusColor(t, view) : t.border,
                    }}
                  />
                  <span>{view ? statusLabel(view, now) : 'Loading…'}</span>
                </div>
                {view?.sessionStartedAt != null ? (
                  <>
                    <div
                      aria-label="session-timer"
                      style={{
                        fontSize: 30,
                        fontWeight: 650,
                        letterSpacing: -0.5,
                        fontVariantNumeric: 'tabular-nums',
                        lineHeight: 1.1,
                      }}
                    >
                      {formatTimer(now - view.sessionStartedAt)}
                    </div>
                    <div style={{ fontSize: 11, color: t.muted }}>
                      since {formatClock(view.sessionStartedAt)}
                    </div>
                  </>
                ) : (
                  view && (
                    <>
                      <div
                        style={{
                          fontSize: 26,
                          fontWeight: 650,
                          fontVariantNumeric: 'tabular-nums',
                          lineHeight: 1.1,
                        }}
                      >
                        {formatWorked(dayOf(view, now).worked)}
                      </div>
                      <div style={{ fontSize: 11, color: t.muted }}>worked today</div>
                    </>
                  )
                )}
              </DayDial>
            )}
            {!pastDate && view?.status === 'clocked_out' && (
              <div style={{ fontSize: 12, color: t.muted, marginTop: 6, lineHeight: 1.4 }}>
                {clockedOutHint(view, now)}
              </div>
            )}
          </section>

          {!pastDate && view?.status === 'clocked_out' && view.autoClockedOutAt !== null && (
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
            <section
              aria-label="actions"
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <Actions view={view} run={run} onClockOut={askClockOut} />
            </section>
          )}

          {error && !(enrollBlocked && error === enrollment.code) && (
            <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger }}>
              {ERROR_TEXT[error] ?? `Something went wrong (${error}).`}
            </p>
          )}

          {shownSegs.length > 0 && (
            <DayStats segments={shownSegs} now={shownNow} since={shownSince} />
          )}

          {shownSegs.length > 0 && (
            <button
              type="button"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((o) => !o)}
              style={{
                ...linkButton(t),
                alignSelf: 'center',
                fontSize: 12,
                color: t.muted,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {detailsOpen ? 'Hide details' : 'Details: sessions and totals'}
              <span aria-hidden style={{ fontSize: 9 }}>
                {detailsOpen ? '▲' : '▼'}
              </span>
            </button>
          )}

          {view && detailsOpen && (
            <>
              <section aria-label={pastDate ? 'past-day' : 'today'} style={card(t)}>
                <h2 style={sectionTitle(t)}>
                  {pastDate ? `Sessions · ${dayLabel(pastDate, todayDate)}` : 'Sessions today'}
                </h2>
                <TimelineView
                  segments={shownSegs}
                  now={shownNow}
                  since={shownSince}
                  emptyText={pastDate ? 'Nothing was tracked on this day.' : undefined}
                />
              </section>
              {shownSegs.length > 0 && (
                <Footer segments={shownSegs} now={shownNow} since={shownSince} past={!!pastDate} />
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}

function Actions({
  view,
  run,
  onClockOut,
}: {
  view: StateView;
  run: (command: () => Promise<StateView>) => void;
  /** Opens the "Clock out now?" dialog. */
  onClockOut: () => void;
}): JSX.Element {
  const chips = (children: ReactNode): JSX.Element => (
    <div style={{ display: 'flex', gap: 6 }}>{children}</div>
  );
  const pair = (children: ReactNode): JSX.Element => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
  );
  switch (view.status) {
    case 'clocked_out':
      return (
        <Button variant="go" onClick={() => run(api.clockIn)}>
          Clock in
        </Button>
      );
    case 'active':
    case 'on_call':
      return (
        <>
          <Button variant="stop" onClick={onClockOut}>
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
              {/* Not offered during a call: it's already tracked (ADR-0009 §2). */}
              {view.status === 'active' && (
                <Button variant="chip" onClick={() => run(() => api.markAway('meeting'))}>
                  In a meeting
                </Button>
              )}
            </>,
          )}
        </>
      );
    case 'idle_pending':
      return (
        <Button variant="stop" onClick={onClockOut}>
          Clock out
        </Button>
      );
    case 'on_break':
      return pair(
        <>
          <Button variant="primary" onClick={() => run(api.endBreak)}>
            End break
          </Button>
          <Button variant="stopOutline" onClick={onClockOut}>
            Clock out
          </Button>
        </>,
      );
    case 'away':
      return pair(
        <>
          <Button variant="primary" onClick={() => run(api.markBack)}>
            I&apos;m back
          </Button>
          <Button variant="stopOutline" onClick={onClockOut}>
            Clock out
          </Button>
        </>,
      );
  }
}

/** Compact figure for the stats strip: "0m", "<1m", "25m", "6h 12m". */
function statTime(ms: number): string {
  if (ms <= 0) return '0m';
  if (ms < 60_000) return '<1m';
  return formatWorked(ms);
}

/** Worked · Calls · Breaks at a glance (details hold the full totals). */
function DayStats({
  segments,
  now,
  since,
}: {
  segments: readonly Segment[];
  now: number;
  since?: number | undefined;
}): JSX.Element {
  const t = useTheme();
  const byKind = totalsByKind(segments, now, since);
  const sum = (pred: (k: SegmentKind) => boolean): number =>
    KIND_ORDER.filter(pred).reduce((a, k) => a + (byKind[k] ?? 0), 0);
  const stats: [string, number, string][] = [
    ['Worked', sum((k) => groupOf(k) === 'working'), t.kind.working],
    ['Calls', sum((k) => k.startsWith('call_')), t.kind.call_teams],
    ['Breaks', sum((k) => groupOf(k) === 'break'), t.kind.meal_break],
  ];
  return (
    <section
      aria-label="day-stats"
      style={{
        ...card(t),
        padding: '10px 6px',
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
      }}
    >
      {stats.map(([label, ms, colour], i) => (
        <div
          key={label}
          style={{
            textAlign: 'center',
            borderLeft: i === 0 ? 'none' : `1px solid ${t.border}`,
          }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 650,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {statTime(ms)}
          </div>
          <div
            style={{
              fontSize: 11,
              color: t.muted,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
            }}
          >
            <span
              aria-hidden
              style={{ width: 7, height: 7, borderRadius: 2, background: colour }}
            />
            {label}
          </div>
        </div>
      ))}
    </section>
  );
}

function Footer({
  segments,
  now,
  since,
  past,
}: {
  segments: readonly Segment[];
  now: number;
  since?: number | undefined;
  /** A past day: rebuilt by the backend from what it received. */
  past: boolean;
}): JSX.Element {
  const t = useTheme();
  const byKind = totalsByKind(segments, now, since);
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
        <h2 style={sectionTitle(t)}>{past ? 'Totals' : 'Today\u2019s totals'}</h2>
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
        {past
          ? 'As received by CloudPunch from your computers.'
          : 'Tracked on this device, to the second.'}{' '}
        Paid hours come from your approved timesheet, which applies break and prompt rules.
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

/** ‹ Today › — step through today and the previous 30 days (ADR-0016). */
function DayNav({
  date,
  today,
  onChange,
}: {
  date: string;
  today: string;
  onChange: (date: string) => void;
}): JSX.Element {
  const t = useTheme();
  const oldest = shiftDate(today, -LOOKBACK_DAYS);
  const arrow = (disabled: boolean): CSSProperties => ({
    width: 28,
    height: 28,
    borderRadius: 999,
    border: 'none',
    background: 'none',
    color: disabled ? t.border : t.muted,
    fontSize: 18,
    lineHeight: 1,
    cursor: disabled ? 'default' : 'pointer',
  });
  return (
    <div
      aria-label="day-navigation"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
    >
      <button
        type="button"
        aria-label="Previous day"
        disabled={date <= oldest}
        onClick={() => onChange(shiftDate(date, -1))}
        style={arrow(date <= oldest)}
      >
        ‹
      </button>
      {date === today ? (
        <span aria-label="day-shown" style={{ fontSize: 12, fontWeight: 600, color: t.muted }}>
          Today
        </span>
      ) : (
        <button
          type="button"
          aria-label="day-shown"
          title="Back to today"
          onClick={() => onChange(today)}
          style={{ ...linkButton(t), fontSize: 12, fontWeight: 600, color: t.text }}
        >
          {dayLabel(date, today)}
        </button>
      )}
      <button
        type="button"
        aria-label="Next day"
        disabled={date >= today}
        onClick={() => onChange(shiftDate(date, 1))}
        style={arrow(date >= today)}
      >
        ›
      </button>
    </div>
  );
}

const PAST_ERROR: Record<string, string> = {
  offline: "Can't reach CloudPunch right now. Past days show when you're online.",
  not_configured: "Past days aren't available in this build.",
  no_employee: "Your account isn't linked to an employee record. Contact HR.",
};

/** A past working day on the dial, with where and when it was recorded. */
function PastDial({
  state,
  segments,
  end,
  date,
  today,
}: {
  state: ReturnType<typeof useDay>;
  segments: readonly Segment[];
  end: number | null;
  date: string;
  today: string;
}): JSX.Element {
  const t = useTheme();
  const result = state.status === 'ready' ? state.result : null;
  const worked = end === null ? 0 : totals(segments, end, -Infinity).working;
  const first = segments.length > 0 ? Math.min(...segments.map((s) => s.startedAt)) : null;
  const notes: string[] = [];
  if (result) {
    const zone = zoneNote(result.day, -new Date().getTimezoneOffset());
    if (zone) notes.push(zone);
    if (recordedElsewhere(result.day, result.thisDevice)) {
      notes.push('Includes time from another computer');
    }
    if (result.stale) notes.push('Offline · showing what was loaded earlier');
  }
  const message =
    state.status === 'error'
      ? (PAST_ERROR[state.code] ?? `Couldn't load this day (${state.code}).`)
      : null;
  return (
    <>
      <DayDial
        segments={segments}
        now={end ?? Date.parse(`${date}T12:00:00`)}
        hand={false}
        tint={t.tint.off}
        label={dayLabel(date, today)}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 650,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: t.muted,
          }}
        >
          {state.status === 'loading' ? 'Loading…' : 'Worked'}
        </div>
        {result && (
          <>
            <div
              aria-label="past-worked"
              style={{
                fontSize: 26,
                fontWeight: 650,
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1.1,
              }}
            >
              {segments.length > 0 ? formatWorked(worked) : '0m'}
            </div>
            <div style={{ fontSize: 11, color: t.muted }}>
              {first !== null && end !== null
                ? `${formatClock(first)} – ${formatClock(end)}`
                : 'Nothing tracked'}
            </div>
          </>
        )}
      </DayDial>
      {message && (
        <div role="status" style={{ fontSize: 12, color: t.muted, marginTop: 6, lineHeight: 1.4 }}>
          {message}
        </div>
      )}
      {notes.map((n) => (
        <div key={n} style={{ fontSize: 11, color: t.muted, marginTop: 4, lineHeight: 1.4 }}>
          {n}
        </div>
      ))}
    </>
  );
}

/** "9 hours" / "11 hours". */
function formatHours(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

function linkButton(t: Theme): CSSProperties {
  return {
    padding: 0,
    border: 'none',
    background: 'none',
    color: t.accent,
    font: 'inherit',
    cursor: 'pointer',
  };
}

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
