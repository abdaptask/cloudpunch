import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, type StateView } from './api.js';
import { BreakPicker, callName } from './BreakPicker.js';
import { ClockInPrompt } from './ClockInPrompt.js';
import { ClockOutDialog } from './ClockOutDialog.js';
import { IdleReturnDialog } from './IdleReturnDialog.js';
import { DayDial } from './DayDial.js';
import { DayPicker } from './DayPicker.js';
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
import { TripCard } from './TripCard.js';
import { tripSummary, type TripSummary } from './tripModel.js';
import {
  applyBreakLabels,
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
  workingDayStart,
} from './timelineModel.js';
import { Button } from './ui/Button.js';
import { Logo } from './ui/Logo.js';
import { SevenSegment } from './ui/SevenSegment.js';
import { dark, useTheme, type Theme } from './ui/theme.js';
import { PeopleScreen } from './PeopleScreen.js';
import { SettingsScreen } from './SettingsScreen.js';
import { SignIn } from './SignIn.js';
import { Strip } from './Strip.js';
import { useAgentState } from './useAgentState.js';
import { useAuth } from './useAuth.js';
import { useDay } from './useDay.js';
import { useEnrollment } from './useEnrollment.js';
import { useFitWindow } from './useFitWindow.js';
import { useNow } from './useNow.js';
import { usePinned } from './usePinned.js';

/**
 * Home window (Timeline view). State lives in the Rust agent; this
 * renders the current `StateView` and invokes commands. The idle
 * prompt opens in its own window.
 *
 * Calls show as "On a call" here, on the employee's own screen;
 * reports and manager views still count them as active (ADR-0011).
 */

/** Where "today" starts: the current working day, else now (nothing yet). */
function daySince(v: StateView, now: number): number {
  return workingDayStart(v.timeline, now) ?? now;
}

/** Tracked time today and when the last session ended (clocked out). */
function dayOf(v: StateView, now: number): { worked: number; lastOut: number | null } {
  const since = daySince(v, now);
  const rows = today(v.timeline, now, since);
  if (rows.length === 0) return { worked: 0, lastOut: null };
  return {
    worked: totals(v.timeline, now, since).working,
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
    case 'idle':
      return v.idleSince !== null ? `Idle since ${formatClock(v.idleSince)}` : 'Idle';
    case 'on_break': {
      const kind = v.breakKind ?? 'other';
      const name = v.breakOptions.find((o) => o.id === kind)?.label ?? KIND_LABEL[`${kind}_break`];
      // "Personal · back by 10:45" (ADR-0023 §2).
      const back = backBy(v);
      return back ? `${name} · back by ${back}` : `On a ${name.toLowerCase()}`;
    }
    case 'away':
      return KIND_LABEL[awayKind(v)];
  }
}

/** When a planned break is due to end, as a clock time. */
function backBy(v: StateView): string | null {
  if (v.plannedBreakMinutes === null) return null;
  const started = [...v.timeline].reverse().find((s) => s.endedAt === null)?.startedAt;
  return started === undefined ? null : formatClock(started + v.plannedBreakMinutes * 60_000);
}

function awayKind(v: StateView): 'away_meeting' | 'away_phone' | 'away_training' | 'away_working' {
  if (v.awayReason === 'meeting') return 'away_meeting';
  if (v.awayReason === 'phone_call') return 'away_phone';
  if (v.awayReason === 'training') return 'away_training';
  return 'away_working';
}

function statusColor(t: Theme, v: StateView): string {
  switch (v.status) {
    case 'clocked_out':
      return t.muted;
    case 'on_break':
      return t.kind[`${v.breakKind ?? 'other'}_break`];
    case 'away':
      return t.kind[awayKind(v)];
    case 'idle_pending':
      return t.kind.prompt;
    case 'idle':
      return t.kind.idle;
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
  // ADR-0018 §4: the sign-in is over 12 hours old or before the last session.
  start_out_of_range: "That sign-in time can't be used any more. Clock in now instead.",
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
  const { pinned, pin, unpin } = usePinned();
  const enrollBlocked = signedIn && enrollment?.state === 'blocked';
  const [closeAsked, setCloseAsked] = useState(false);
  // Clock out asks first and offers a break instead (owner request).
  const [clockOutAsked, setClockOutAsked] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const askClockOut = (): void => setClockOutAsked(true);
  // "Take a break": type, "Back in?", and a word about a call in
  // progress (ADR-0023; owner request).
  const [breakPicker, setBreakPicker] = useState(false);

  // Past days (ADR-0016): null shows today, live.
  const [viewDate, setViewDate] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Settings for HR / Administrators (ADR-0018 §5). The server checks
  // the role on every call; this only decides whether to offer it.
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (!signedIn) {
      setCapabilities([]);
      setSettingsOpen(false);
      return;
    }
    let current = true;
    api.myCapabilities().then(
      (c) => {
        if (current) setCapabilities(c);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [signedIn]);
  const canEditCompany = capabilities.includes('admin.policy.write');
  const canEditRules = canEditCompany || capabilities.includes('hr.policy.write');
  // People (ADR-0020): Administrators assign any role, HR Employee / Manager.
  const canAssignAll = capabilities.includes('admin.role.assign');
  const canManagePeople = canAssignAll || capabilities.includes('hr.employee.write');
  const canEditSettings = canEditRules || canManagePeople;
  const [adminTab, setAdminTab] = useState<'rules' | 'people'>('rules');
  const tab = !canEditRules ? 'people' : !canManagePeople ? 'rules' : adminTab;
  const showDate = (d: string): void => setViewDate(d >= todayDate ? null : d);
  const todayDate = localDateOf(now);
  const pastDate = viewDate !== null && viewDate < todayDate ? viewDate : null;
  const past = useDay(signedIn ? pastDate : null);
  const pastDay = past.status === 'ready' ? past.result : null;
  const pastSegs: Segment[] = pastDay ? daySegments(pastDay.day) : [];
  const pastEnd = dayEnd(pastSegs);
  useEffect(() => {
    if (!signedIn) {
      setViewDate(null);
      setPickerOpen(false);
    }
  }, [signedIn]);
  // What the stats and details show: today live, or the past day whole.
  // Today is the current working day, so a night shift isn't cut at midnight.
  const todaySince = view ? daySince(view, now) : now;
  const todaySegs = (view?.timeline ?? []).filter((s) => (s.endedAt ?? now) > todaySince);
  const shownSegs = pastDate ? pastSegs : todaySegs;
  const shownNow = pastDate ? (pastEnd ?? now) : now;
  const shownSince = pastDate ? -Infinity : todaySince;

  // The close button asks first, unless "keep running" was remembered
  // (ADR-0013 §1). The tray's Quit while clocked in lands here too.
  // Pinned, the question needs the full window: unpin first.
  useEffect(() => {
    const off = api.onCloseRequested(() => {
      if (rememberedKeepRunning()) void api.hideToTray();
      else {
        void api.unpinWindow().catch(() => undefined);
        setCloseAsked(true);
      }
    });
    return () => void off.then((fn) => fn());
  }, []);
  // The tray's "Take a break…" opens the picker here.
  useEffect(() => {
    const off = api.onBreakPicker(() => {
      void api.unpinWindow().catch(() => undefined);
      setBreakPicker(true);
    });
    return () => void off.then((fn) => fn());
  }, []);
  // HR's names for the break types, everywhere they're shown.
  const breakOptions = view?.breakOptions;
  useEffect(() => {
    if (breakOptions) applyBreakLabels(breakOptions);
  }, [breakOptions]);
  const clockedIn = view !== null && view.status !== 'clocked_out';
  const showStrip = signedIn && pinned && view !== null;
  const todayTotals = totals(todaySegs, now, todaySince);

  // End-of-day summary (ADR-0013 §8): on the employee's own clock-out
  // (not the idle auto clock-out, which explains itself) and at sign-out.
  const [trip, setTrip] = useState<{ summary: TripSummary; signedOut: boolean } | null>(null);
  const summarise = (): TripSummary | null =>
    view ? tripSummary(todaySegs, now, todaySince, view.longDayMs) : null;
  const prevStatus = useRef<string | null>(null);
  const status = view?.status ?? null;
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (status !== 'clocked_out') {
      setTrip(null);
      return;
    }
    if (prev !== null && prev !== 'clocked_out' && view?.autoClockedOutAt === null) {
      const summary = summarise();
      if (summary && summary.worked > 0) setTrip({ summary, signedOut: false });
    }
    // Only the status change matters; the summary is taken at that moment.
  }, [status]);
  useEffect(() => {
    if (signedIn) setTrip((p) => (p?.signedOut ? null : p));
  }, [signedIn]);
  const signOutWithSummary = (): void => {
    const summary = summarise();
    setTrip(summary && summary.worked > 0 ? { summary, signedOut: true } : null);
    signOut();
  };
  const tripCard = trip && (
    <TripCard trip={trip.summary} signedOut={trip.signedOut} onDone={() => setTrip(null)} />
  );

  return (
    <main
      ref={mainRef}
      style={
        showStrip
          ? { fontFamily: t.font, color: t.text, background: t.bg }
          : {
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
            }
      }
    >
      {showStrip && (
        <Strip
          view={view}
          now={now}
          label={statusLabel(view, now)}
          color={statusColor(t, view)}
          worked={todayTotals.working}
          breaks={todayTotals.break}
          idle={todayTotals.idle}
          run={run}
          onUnpin={unpin}
          onTakeBreak={() => {
            unpin();
            setBreakPicker(true);
          }}
        />
      )}
      {/* Signed out, the sign-in card carries the brand; no header. */}
      {!showStrip && signedIn && (
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
                    <button type="button" onClick={signOutWithSummary} style={linkButton(t)}>
                      Sign out
                    </button>
                  </>
                )}
                {' · '}
              </>
            )}
            {formatClock(now)}
            {canEditSettings && (
              <SettingsButton open={settingsOpen} onClick={() => setSettingsOpen((o) => !o)} />
            )}
            <PinButton onClick={pin} />
          </span>
        </header>
      )}
      {!showStrip && (
        <>
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
              call={view.status === 'on_call' ? callName(view.callType) : null}
              onBreak={() => {
                setClockOutAsked(false);
                setBreakPicker(true);
              }}
              onCancel={() => setClockOutAsked(false)}
            />
          )}
          {signedIn && view?.clockInPrompt && view.status === 'clocked_out' && (
            <ClockInPrompt
              signedInAt={view.signedInAt}
              onClockInFrom={() => run(api.clockInFromSignIn)}
              onClockInNow={() => run(api.clockIn)}
              onNotNow={() => run(api.dismissClockInPrompt)}
            />
          )}
          {signedIn && view?.idleReturn && (
            <IdleReturnDialog
              stretch={view.idleReturn}
              onExplain={(explanation, note) => run(() => api.explainIdle(explanation, note))}
              onSkip={() => run(api.dismissIdleReturn)}
            />
          )}
          {breakPicker && view && (view.status === 'active' || view.status === 'on_call') && (
            <BreakPicker
              options={view.breakOptions}
              call={view.status === 'on_call' ? callName(view.callType) : null}
              onStart={(kind, planned) => {
                setBreakPicker(false);
                run(() => api.startBreak(kind, planned));
              }}
              onCancel={() => setBreakPicker(false)}
            />
          )}
          {signedIn && !pastDate && view?.longShift && view.sessionStartedAt !== null && (
            <LongShiftBanner
              hours={formatHours(now - view.sessionStartedAt)}
              onStillWorking={() => run(api.ackLongShift)}
              onClockOut={askClockOut}
            />
          )}
          {!auth && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}
          {auth && !signedIn && tripCard}
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
              Signed out. {auth.unsentKept === 1 ? '1 event' : `${auth.unsentKept} events`} will be
              sent the next time you sign in on this computer.
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
          {signedIn && settingsOpen && canEditSettings && (
            <>
              {canEditRules && canManagePeople && (
                <div role="tablist" aria-label="admin-tabs" style={{ display: 'flex', gap: 6 }}>
                  {(
                    [
                      ['rules', 'Rules'],
                      ['people', 'People'],
                    ] as const
                  ).map(([key, label]) => (
                    <Button
                      key={key}
                      role="tab"
                      aria-selected={tab === key}
                      variant="chip"
                      onClick={() => setAdminTab(key)}
                      style={
                        tab === key
                          ? { borderColor: t.accent, color: t.accent, fontWeight: 650 }
                          : {}
                      }
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              )}
              {tab === 'rules' ? (
                <SettingsScreen
                  canEditCompany={canEditCompany}
                  onClose={() => setSettingsOpen(false)}
                />
              ) : (
                <PeopleScreen canAssignAll={canAssignAll} onClose={() => setSettingsOpen(false)} />
              )}
            </>
          )}
          {signedIn && !(settingsOpen && canEditSettings) && (
            <>
              {/* Status and actions stay put; the details below scroll. */}
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  background: t.bg,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  paddingBottom: 2,
                }}
              >
                <section
                  aria-label="current-status"
                  style={{ ...card(t), padding: '8px 12px 12px', textAlign: 'center' }}
                >
                  <DayNav
                    date={pastDate ?? todayDate}
                    today={todayDate}
                    pickerOpen={pickerOpen}
                    onTogglePicker={() => setPickerOpen((o) => !o)}
                    onChange={(d) => {
                      setPickerOpen(false);
                      showDate(d);
                    }}
                  />
                  {pickerOpen ? (
                    <DayPicker
                      today={todayDate}
                      selected={pastDate ?? todayDate}
                      onPick={(d) => {
                        // A tap opens the day with its sessions and totals (owner request).
                        setPickerOpen(false);
                        setDetailsOpen(true);
                        showDate(d);
                      }}
                      onClose={() => setPickerOpen(false)}
                    />
                  ) : pastDate ? (
                    <PastDial
                      state={past}
                      segments={pastSegs}
                      end={pastEnd}
                      date={pastDate}
                      today={todayDate}
                    />
                  ) : (
                    <DayDial
                      segments={todaySegs}
                      now={now}
                      park={trip?.summary.long === true}
                      tint={view ? t.tint[tintFor(view.status)] : undefined}
                      glow={view ? t.gauge.glow[tintFor(view.status)] : undefined}
                      worked={todayTotals.working}
                      elapsed={view?.sessionStartedAt != null ? now - view.sessionStartedAt : null}
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
                          // On the dark gauge: the dark theme's brighter colours.
                          color: view ? statusColor(dark, view) : t.gauge.dim,
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: 999,
                            background: view ? statusColor(dark, view) : t.gauge.unlit,
                            boxShadow: view ? `0 0 6px ${statusColor(dark, view)}` : 'none',
                          }}
                        />
                        <span>{view ? statusLabel(view, now) : 'Loading…'}</span>
                      </div>
                      {view?.sessionStartedAt != null ? (
                        <>
                          <div aria-label="session-timer" style={{ margin: '4px 0 2px' }}>
                            <SevenSegment
                              text={formatTimer(now - view.sessionStartedAt)}
                              color={t.gauge.text}
                              unlit={t.gauge.unlit}
                              height={28}
                            />
                          </div>
                          <div style={{ fontSize: 11, color: t.gauge.dim }}>
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
                            <div style={{ fontSize: 11, color: t.gauge.dim }}>worked today</div>
                          </>
                        )
                      )}
                    </DayDial>
                  )}
                  {!pastDate && !pickerOpen && view?.status === 'clocked_out' && (
                    <div style={{ fontSize: 12, color: t.muted, marginTop: 6, lineHeight: 1.4 }}>
                      {clockedOutHint(view, now)}
                    </div>
                  )}
                </section>

                {!pastDate && signedIn && tripCard}

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
                    {view.autoClockOutReason === 'idle_cap'
                      ? `You were clocked out at ${formatClock(view.autoClockedOutAt)} after a long idle stretch. The idle time is kept for your manager to review.`
                      : `You were clocked out at ${formatClock(view.autoClockedOutAt)} because the idle prompt wasn't answered. Time up to when the prompt appeared is kept.`}
                  </p>
                )}

                {view && (
                  <section
                    aria-label="actions"
                    style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                  >
                    {/* A past day is for looking back: no clock or break actions (owner request). */}
                    {pastDate ? (
                      <BackToToday
                        view={view}
                        now={now}
                        onClick={() => {
                          setPickerOpen(false);
                          setViewDate(null);
                        }}
                      />
                    ) : (
                      <Actions
                        view={view}
                        run={run}
                        onClockOut={askClockOut}
                        onBreak={() => setBreakPicker(true)}
                      />
                    )}
                  </section>
                )}
              </div>

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
                    <Footer
                      segments={shownSegs}
                      now={shownNow}
                      since={shownSince}
                      past={!!pastDate}
                    />
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}

/** Header button: pin the window as the mini strip (ADR-0017). */
/** Header button for HR / Administrators: open Settings (ADR-0018 §5). */
function SettingsButton({ open, onClick }: { open: boolean; onClick: () => void }): JSX.Element {
  const t = useTheme();
  return (
    <button
      type="button"
      aria-label="Settings"
      aria-pressed={open}
      title="Settings (HR and Administrators)"
      onClick={onClick}
      style={{
        marginLeft: 8,
        width: 24,
        height: 24,
        padding: 0,
        border: 'none',
        borderRadius: 6,
        background: open ? t.surfaceAlt : 'none',
        color: t.muted,
        cursor: 'pointer',
        verticalAlign: 'middle',
      }}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden fill="currentColor">
        <path d="M8 5.25A2.75 2.75 0 1 0 8 10.75 2.75 2.75 0 0 0 8 5.25ZM6.75 8a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0Z" />
        <path d="M6.9.9a.75.75 0 0 1 .74-.65h.72a.75.75 0 0 1 .74.65l.17 1.3c.37.12.72.27 1.05.46l1.04-.8a.75.75 0 0 1 .98.06l.51.51a.75.75 0 0 1 .07.98l-.8 1.04c.19.33.34.68.45 1.05l1.3.17a.75.75 0 0 1 .66.74v.72a.75.75 0 0 1-.66.74l-1.3.17c-.11.37-.26.72-.45 1.05l.8 1.04a.75.75 0 0 1-.07.98l-.51.51a.75.75 0 0 1-.98.07l-1.04-.8c-.33.19-.68.34-1.05.45l-.17 1.3a.75.75 0 0 1-.74.66h-.72a.75.75 0 0 1-.74-.66l-.17-1.3a4.8 4.8 0 0 1-1.05-.45l-1.04.8a.75.75 0 0 1-.98-.07l-.51-.51a.75.75 0 0 1-.07-.98l.8-1.04a4.8 4.8 0 0 1-.45-1.05l-1.3-.17A.75.75 0 0 1 .25 8.36v-.72a.75.75 0 0 1 .65-.74l1.3-.17c.12-.37.27-.72.46-1.05l-.8-1.04a.75.75 0 0 1 .06-.98l.51-.51a.75.75 0 0 1 .98-.06l1.04.8c.33-.19.68-.34 1.05-.46L6.9.9Zm.87.85-.14 1.1a.75.75 0 0 1-.57.63 3.3 3.3 0 0 0-1.35.56.75.75 0 0 1-.85-.02l-.88-.68-.16.16.68.88a.75.75 0 0 1 .02.85 3.3 3.3 0 0 0-.56 1.35.75.75 0 0 1-.63.57l-1.1.14v.22l1.1.14c.31.04.57.27.63.57.1.49.29.95.56 1.35a.75.75 0 0 1-.02.85l-.68.88.16.16.88-.68a.75.75 0 0 1 .85-.02c.4.27.86.46 1.35.56.3.06.53.32.57.63l.14 1.1h.22l.14-1.1a.75.75 0 0 1 .57-.63c.49-.1.95-.29 1.35-.56a.75.75 0 0 1 .85.02l.88.68.16-.16-.68-.88a.75.75 0 0 1-.02-.85c.27-.4.46-.86.56-1.35a.75.75 0 0 1 .63-.57l1.1-.14v-.22l-1.1-.14a.75.75 0 0 1-.63-.57 3.3 3.3 0 0 0-.56-1.35.75.75 0 0 1 .02-.85l.68-.88-.16-.16-.88.68a.75.75 0 0 1-.85.02 3.3 3.3 0 0 0-1.35-.56.75.75 0 0 1-.57-.63l-.14-1.1h-.22Z" />
      </svg>
    </button>
  );
}

function PinButton({ onClick }: { onClick: () => void }): JSX.Element {
  const t = useTheme();
  return (
    <button
      type="button"
      aria-label="Pin to desktop"
      title="Pin to desktop: a small always-on-top strip (minimising does this too)"
      onClick={onClick}
      style={{
        marginLeft: 8,
        width: 24,
        height: 24,
        padding: 0,
        border: 'none',
        borderRadius: 6,
        background: 'none',
        color: t.muted,
        cursor: 'pointer',
        verticalAlign: 'middle',
      }}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden fill="currentColor">
        <path d="M10.5 1.5a.75.75 0 0 1 1.06 0l2.94 2.94a.75.75 0 0 1 0 1.06l-1.2 1.2a.75.75 0 0 1-.8.17l-.9-.35-2.3 2.3.4 2.03a.75.75 0 0 1-.2.68l-.9.9a.75.75 0 0 1-1.06 0L5.3 10.19l-3.02 3.02a.75.75 0 1 1-1.06-1.06L4.24 9.13 1.99 6.88a.75.75 0 0 1 0-1.06l.9-.9a.75.75 0 0 1 .68-.2l2.03.4 2.3-2.3-.35-.9a.75.75 0 0 1 .17-.8l1.2-1.2z" />
      </svg>
    </button>
  );
}

function Actions({
  view,
  run,
  onClockOut,
  onBreak,
}: {
  view: StateView;
  run: (command: () => Promise<StateView>) => void;
  /** Opens the "Clock out now?" dialog. */
  onClockOut: () => void;
  /** Opens "Take a break". */
  onBreak: () => void;
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
        <>
          <Button variant="go" onClick={() => run(api.clockIn)}>
            Clock in
          </Button>
          {/* ADR-0018 §4: start from when they signed in to the computer. */}
          {view.signedInAt !== null && (
            <button
              type="button"
              onClick={() => run(api.clockInFromSignIn)}
              style={{
                alignSelf: 'center',
                padding: 0,
                border: 'none',
                background: 'none',
                color: 'inherit',
                font: 'inherit',
                fontSize: 12,
                textDecoration: 'underline',
                cursor: 'pointer',
              }}
            >
              or clock in from {formatClock(view.signedInAt)}, when you signed in
            </button>
          )}
        </>
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
              <Button variant="chip" onClick={onBreak}>
                Take a break
              </Button>
              {/* Not offered during a call: it's already tracked (ADR-0009 §2). */}
              {view.status === 'active' && (
                <Button variant="chip" onClick={() => run(() => api.markAway('meeting'))}>
                  In a meeting
                </Button>
              )}
              {view.status === 'active' && view.offerTraining && (
                <Button variant="chip" onClick={() => run(() => api.markAway('training'))}>
                  In training
                </Button>
              )}
            </>,
          )}
        </>
      );
    case 'idle_pending':
    case 'idle':
      // Any click or key ends idle (ADR-0018); only clock out needs a button.
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

/** On a past day, the one action: back to today, with the live status under it. */
function BackToToday({
  view,
  now,
  onClick,
}: {
  view: StateView;
  now: number;
  onClick: () => void;
}): JSX.Element {
  const t = useTheme();
  const live =
    view.sessionStartedAt !== null
      ? `${statusLabel(view, now)} · ${formatTimer(now - view.sessionStartedAt)}`
      : statusLabel(view, now);
  return (
    <Button
      variant="primary"
      onClick={onClick}
      aria-label="Back to today"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
    >
      <span>Back to today</span>
      <span
        aria-label="live-status"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          fontWeight: 500,
          opacity: 0.85,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span
          aria-hidden
          style={{ width: 7, height: 7, borderRadius: 999, background: statusColor(t, view) }}
        />
        {live}
      </span>
    </Button>
  );
}

/** Compact figure for the stats strip: "0m", "<1m", "25m", "6h 12m". */
function statTime(ms: number): string {
  if (ms <= 0) return '0m';
  if (ms < 60_000) return '<1m';
  return formatWorked(ms);
}

/** Worked / Idle / Breaks / Calls as trip-meter readouts under the gauge. */
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
  const g = t.gauge;
  const byKind = totalsByKind(segments, now, since);
  const sum = (pred: (k: SegmentKind) => boolean): number =>
    KIND_ORDER.filter(pred).reduce((a, k) => a + (byKind[k] ?? 0), 0);
  const stats: [string, number, string][] = [
    ['Worked', sum((k) => groupOf(k) === 'working'), dark.kind.working],
    ['Idle', sum((k) => groupOf(k) === 'idle'), dark.kind.idle],
    ['Breaks', sum((k) => groupOf(k) === 'break'), dark.kind.meal_break],
    ['Calls', sum((k) => k.startsWith('call_')), dark.kind.call_teams],
  ];
  return (
    <section
      aria-label="day-stats"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 6,
        padding: 6,
        borderRadius: 12,
        background: `linear-gradient(180deg, ${g.face}, ${g.faceEdge})`,
        border: `1px solid ${g.rim}`,
      }}
    >
      {stats.map(([label, ms, colour]) => (
        <div
          key={label}
          style={{
            padding: '7px 4px 6px',
            borderRadius: 8,
            background: 'rgba(0, 0, 0, 0.28)',
            boxShadow: `inset 0 0 0 1px ${g.unlit}`,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: 0.5,
              color: g.text,
              fontVariantNumeric: 'tabular-nums',
              textShadow: `0 0 6px ${colour}`,
            }}
          >
            {statTime(ms)}
          </div>
          <div
            style={{
              marginTop: 2,
              fontSize: 9.5,
              fontWeight: 650,
              letterSpacing: 1,
              textTransform: 'uppercase',
              color: g.dim,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: colour,
                boxShadow: `0 0 5px ${colour}`,
              }}
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

/**
 * ‹ Today ▾ › — step through today and the previous 30 days, or tap the
 * date for the heat-calendar picker (ADR-0016).
 */
function DayNav({
  date,
  today,
  pickerOpen,
  onTogglePicker,
  onChange,
}: {
  date: string;
  today: string;
  pickerOpen: boolean;
  onTogglePicker: () => void;
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
      <button
        type="button"
        aria-label="day-shown"
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        title="Pick a day"
        onClick={onTogglePicker}
        style={{
          ...linkButton(t),
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '4px 10px',
          borderRadius: 999,
          background: pickerOpen ? t.surfaceAlt : 'none',
          fontSize: 12,
          fontWeight: 600,
          color: date === today ? t.muted : t.text,
        }}
      >
        {dayLabel(date, today)}
        <span aria-hidden style={{ fontSize: 9 }}>
          {pickerOpen ? '▲' : '▼'}
        </span>
      </button>
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
        glow={t.gauge.glow.off}
        worked={worked}
        label={dayLabel(date, today)}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 650,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: t.gauge.dim,
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
            <div style={{ fontSize: 11, color: t.gauge.dim }}>
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
