import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { DayResult } from './dayHistory.js';
import type { DaySummary, DaysResult } from './dayPickerModel.js';
import type { PromptResponse } from './IdlePrompt.js';
import type { Segment } from './timelineModel.js';

/**
 * Typed wrappers around the Rust agent's Tauri commands (slice
 * 2b.7.2b PR D). The core validates everything; a rejected command
 * rejects the promise with a code string (`invalid_transition`,
 * `note_required`, `note_too_long`, `option_not_offered`,
 * `invalid_argument`).
 */

export type Status =
  'clocked_out' | 'active' | 'on_call' | 'idle_pending' | 'idle' | 'on_break' | 'away';

/** `USER_IDLE_EXPLAINED.explanation` (ADR-0018 §2). */
export type IdleExplanation = 'working_away' | 'meeting' | 'phone_call' | 'break' | 'idle';

/** `GET /v1/admin/policy/{global|departments/:id}` (ADR-0018 §5). */
export interface AdminPolicy {
  override: { document: Record<string, unknown> } | null;
  effective: { policy: Record<string, unknown> };
}

/** People (ADR-0020): someone with CloudPunch roles. */
export interface Person {
  oid: string;
  name: string;
  roles: string[];
  has_employee_record: boolean;
}

/** A roles save (ADR-0020). With no Employee, Manager or HR left, the
 * person's record is turned off and those who reported to them have no
 * manager now (`unassigned_reports`). */
export interface RolesSaved {
  roles: string[];
  changed: boolean;
  unassigned_reports?: { id: string; name: string }[];
}

/** Welcome email preview (ADR-0021). */
export interface WelcomePreview {
  from: string;
  to: string;
  cc: string[];
  subject: string;
}

/** People: a directory search result. */
export interface DirectoryUser {
  oid: string;
  name: string;
  email: string | null;
}

/** An idle stretch that just ended, epoch ms. */
export interface IdleReturn {
  since: number;
  until: number;
}

/** Team today: one person's status now (ADR-0025). */
export interface TeamPerson {
  employee_id: string;
  name: string;
  status:
    | 'clocked_out'
    | 'working'
    | 'on_call'
    | 'on_break'
    | 'away'
    | 'prompt'
    | 'idle'
    /** In their shift, not clocked in since it started (ADR-0031); `since` = shift start. */
    | 'shift_not_started'
    /** Said "Not working today" (ADR-0031). */
    | 'not_working'
    /** Their shift falls on a company holiday (ADR-0037); see `holiday`. */
    | 'holiday';
  /** Segment kind now (`personal_break`, `away_meeting`, …). */
  kind: string | null;
  since: string | null;
  back_by: string | null;
  worked_ms: number;
  /** The holiday's name, when `status` is `holiday`. */
  holiday?: string;
  /** Missed starts and "not working" days lately (ADR-0037 §4), when any. */
  starts?: { missed: number; not_working: number; days: number; regular: boolean };
}

/** One network a computer connected from (ADR-0029). */
export interface Connection {
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
  provider: string | null;
  asn: number | null;
  device_os: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

/** `GET /v1/me/connections` and `/v1/team/:id/connections`. */
export interface ConnectionHistory {
  name?: string;
  /** Whether `connections.record` is on. */
  recording: boolean;
  keep_days: number;
  /** "IP data by DB-IP" (CC BY 4.0). */
  attribution: string;
  connections: Connection[];
}

/** `GET /v1/team/connections`: each person's latest. */
export interface TeamConnections {
  recording: boolean;
  attribution: string;
  people: (Connection & { employee_id: string; name: string })[];
}

/** What a correction may say the time was (ADR-0030 §1). */
export type CorrectionKind =
  | 'working'
  | 'away_working'
  | 'bio_break'
  | 'meal_break'
  | 'rest_break'
  | 'personal_break'
  | 'other_break'
  | 'not_worked';

/** A correction touching a day, whatever its status (ADR-0030 §4). */
export interface DayCorrection {
  id: string;
  /** ISO 8601 with the person's offset. */
  from: string;
  to: string;
  kind: CorrectionKind;
  reason: string;
  status: 'requested' | 'endorsed' | 'approved' | 'rejected' | 'withdrawn';
  requested_by: string;
  requested_at: string;
  decisions: { decision: string; by: string; at: string; note: string | null }[];
}

export interface CorrectionQueueItem {
  employee_id: string;
  name: string;
  /** The working day it is on, `YYYY-MM-DD`. */
  date: string;
  correction: DayCorrection;
}

/** What waits on the signed-in user. */
export interface CorrectionQueue {
  to_endorse: CorrectionQueueItem[];
  to_approve: CorrectionQueueItem[];
}

/** A weekly shift (ADR-0031): ISO weekdays, 1 = Monday … 7 = Sunday. */
export interface Shift {
  days: number[];
  start: string;
  end: string;
  tz_iana: string;
}

/** A company holiday (ADR-0037 §1). */
export interface Holiday {
  /** `YYYY-MM-DD`. */
  date: string;
  name: string;
}

export interface ShiftRow {
  employee_id: string;
  name: string;
  shift: Shift | null;
}

export interface CorrectionInput {
  /** A direct report's id, as their manager; absent for your own time. */
  employeeId?: string;
  from: string;
  to: string;
  tzIana: string;
  kind: CorrectionKind;
  reason: string;
}

export interface TeamDaySegment {
  kind: string;
  started_at: string;
  ended_at: string;
  explanation?: { explanation: string; note: string | null };
  planned_minutes?: number;
  /** Minutes added with "5 / 10 more min" (ADR-0031 §3). */
  extended_minutes?: number;
  presence_check?: 'continuous' | 'periodic';
  ended_by?: 'input' | 'call';
  /** An approved correction's stretch (ADR-0030 §4). */
  correction_id?: string;
}

/** A team member's day: `/v1/me/days`' shape plus their name. */
export interface TeamDay {
  name: string;
  date: string;
  sessions: {
    session_id: string;
    device_id: string;
    tz_iana: string;
    clock_in: string;
    clock_out: string | null;
    close_reason: string | null;
    reconstructed: boolean;
    open: boolean;
    started_from_sign_in: boolean;
    /** Made only of an approved correction. */
    corrected?: true;
    segments: TeamDaySegment[];
  }[];
  /** Corrections touching the day (older servers leave it out). */
  corrections?: DayCorrection[];
  totals: {
    worked_ms: number;
    calls_ms: number;
    meetings_ms: number;
    breaks_ms: number;
    paid_break_ms: number;
    unpaid_break_ms: number;
    prompt_ms: number;
    idle_ms: number;
  };
}

export interface TeamException {
  employee_id: string;
  name: string;
  date: string;
  kind:
    | 'long_idle'
    | 'break_over_planned'
    | 'break_over_limit'
    | 'long_shift'
    | 'auto_clock_out'
    | 'reconstructed'
    | 'presence_check'
    | 'long_away';
  at: string;
  minutes: number | null;
  over_minutes: number | null;
  segment: string | null;
  explanation: { explanation: string; note: string | null } | null;
  /** Presence check (ADR-0024). */
  pattern?: 'continuous' | 'periodic';
  answered?: boolean;
  /** Long Away (ADR-0027): how it ended, if on its own. */
  ended_by?: 'input' | 'call';
}

/** People: an employee and their manager (ADR-0025 §1). */
export interface EmployeeRow {
  id: string;
  name: string;
  email: string | null;
  reporting_manager_id: string | null;
  /** Entra object id, to match People's roles. */
  oid?: string | null;
}

/** Versions: an enrolled device (ADR-0025 §3). */
export interface DeviceRow {
  device_id: string;
  display_name: string;
  work_email: string;
  os: 'windows' | 'macos';
  app_version: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

/** People → Active machine (ADR-0028 §4): where someone is clocked in. */
export interface ActiveMachine {
  device_id: string;
  os: 'windows' | 'macos';
  enrolled_at: string;
  opened_at: string;
  last_event_at: string | null;
}

/** Clocked in on another computer (ADR-0028); epoch ms. */
export interface BlockedElsewhere {
  /** Null until the server has said. */
  os: 'windows' | 'macos' | null;
  openedAt: number | null;
}

/** The fixed break ids (ADR-0023 §1). */
export type BreakId = 'bio' | 'meal' | 'rest' | 'personal' | 'other';

/** One break type the policy offers, in menu order. */
export interface BreakOption {
  id: BreakId;
  label: string;
  /** Reminder limit in minutes; null = none. */
  maxMinutes: number | null;
}

/** Mirrors `agent::StateView`. Timestamps are epoch ms. */
export interface StateView {
  status: Status;
  breakKind: BreakId | null;
  awayReason: 'phone_call' | 'working_away' | 'meeting' | 'training' | null;
  /** Kind of call while `on_call` (ADR-0012). */
  callType: 'teams' | 'zoom' | 'other' | null;
  promptDeadline: number | null;
  promptOptions: PromptResponse[];
  noteRequiredFor: PromptResponse[];
  autoClockedOutAt: number | null;
  /** Clock-in time of the open session; null when clocked out. */
  sessionStartedAt: number | null;
  /** Tracked segments since the app started (display only). */
  timeline: Segment[];
  /** Long-shift check showing (ADR-0013 §5). */
  longShift: boolean;
  /** Policy's long day for the end-of-day summary, ms (ADR-0013 §8). */
  longDayMs: number;
  /** Start of logged idle while `idle` (ADR-0018). */
  idleSince: number | null;
  /** Just back from idle: ask what they were doing. */
  idleReturn: IdleReturn | null;
  /** Why `autoClockedOutAt`: `idle_cap` (ADR-0018) or `prompt` (older). */
  autoClockOutReason: 'idle_cap' | 'prompt' | null;
  /** Computer sign-in time a clock-in may start from (ADR-0018 §4). */
  signedInAt: number | null;
  /** The daily clock-in popup is showing (8:00 New York by default). */
  clockInPrompt: boolean;
  /** The popup is for a shift: offer "Not working today" (ADR-0031). */
  notWorkingOffered: boolean;
  /** When the planned break ran out, while it goes on (ADR-0031 §3). */
  breakOverSince: number | null;
  /** Break types to offer, in menu order (ADR-0023). */
  breakOptions: BreakOption[];
  /** Offer Training as an Away tag. */
  offerTraining: boolean;
  /** The break in progress's "Back in?" answer, minutes. */
  plannedBreakMinutes: number | null;
  /** This build's version. */
  appVersion: string;
  /** A downloaded update's version, waiting to install (ADR-0022). */
  updateReady: string | null;
  /** The prompt or idle in progress is a presence check (ADR-0024). */
  presenceCheck: 'continuous' | 'periodic' | null;
  /** "Welcome back?" while Away (ADR-0027), epoch ms. */
  awayCheck: { inputSince: number; deadline: number } | null;
  /** Clocked in on another computer: no clock-in here (ADR-0028). */
  blockedElsewhere: BlockedElsewhere | null;
}

/** The window's close button was pressed (ADR-0013 §1). */
export const CLOSE_REQUESTED_EVENT = 'cp://close-requested';
/** Mirrors `tray::BREAK_PICKER_EVENT`: "Take a break…" in the tray. */
export const BREAK_PICKER_EVENT = 'cp://break-picker';

/** Emitted by the agent after every state change. */
/** Mirrors `strip::PIN_EVENT`. */
export const PIN_EVENT = 'cp://pinned';

export const STATE_EVENT = 'cp://state';

/** Mirrors `auth::AuthStatus`. */
export interface AuthStatus {
  signedIn: boolean;
  name: string | null;
  username: string | null;
  /** After sign-out: events kept here until this user signs in again. */
  unsentKept?: number;
  /** Why the app signed out on its own (ADR-0028 §4). */
  notice?: 'signed_out_by_admin';
  /**
   * Signed in, but Microsoft refused to renew the sign-in: nothing
   * reaches the server until they sign in again (time waits here).
   */
  expired?: boolean;
}

/** Emitted after sign-in, sign-out, and the silent start-up restore. */
export const AUTH_EVENT = 'cp://auth';

/** Mirrors `enroll::EnrollmentStatus` (2b.4 F3b). */
export interface EnrollmentStatus {
  state: 'pending' | 'enrolled' | 'retrying' | 'not_configured' | 'blocked';
  /** Why, for `retrying` and `blocked`. */
  code: string | null;
}

/** Emitted whenever the enrollment state changes. */
export const ENROLLMENT_EVENT = 'cp://enrollment';

/** The account menu's update check. */
export type UpdateCheck = { status: 'up_to_date' } | { status: 'ready'; version: string };

export const api = {
  getState: (): Promise<StateView> => invoke<StateView>('get_state'),
  clockIn: (): Promise<StateView> => invoke<StateView>('clock_in'),
  /** Start from the computer sign-in time; rejects `start_out_of_range`. */
  clockInFromSignIn: (): Promise<StateView> => invoke<StateView>('clock_in_from_sign_in'),
  dismissClockInPrompt: (): Promise<StateView> => invoke<StateView>('dismiss_clock_in_prompt'),
  /** The signed-in user's capabilities, e.g. `admin.policy.write`. */
  myCapabilities: (): Promise<string[]> => invoke<string[]>('my_capabilities'),
  adminDepartments: (): Promise<{ departments: { id: string; name: string }[] }> =>
    invoke('admin_departments'),
  adminPolicyGet: (scope: 'global' | 'department', id: string | null): Promise<AdminPolicy> =>
    invoke<AdminPolicy>('admin_policy_get', { scope, id }),
  adminPeople: (): Promise<{ people: Person[] }> => invoke('admin_people'),
  adminPeopleSearch: (q: string): Promise<{ users: DirectoryUser[] }> =>
    invoke('admin_people_search', { q }),
  adminPeopleSetRoles: (oid: string, roles: string[], reason: string): Promise<RolesSaved> =>
    invoke('admin_people_set_roles', { oid, roles, reason: reason || null }),
  adminWelcomePreview: (oid: string): Promise<WelcomePreview> =>
    invoke<WelcomePreview>('admin_welcome_preview', { oid }),
  adminWelcomeSend: (oid: string, note: string): Promise<{ to: string; cc: string[] }> =>
    invoke('admin_welcome_send', { oid, note: note || null }),
  adminPolicyPut: (
    scope: 'global' | 'department',
    id: string | null,
    document: Record<string, unknown>,
    reason: string,
  ): Promise<AdminPolicy> =>
    invoke<AdminPolicy>('admin_policy_put', { scope, id, document, reason: reason || null }),
  clockOut: (): Promise<StateView> => invoke<StateView>('clock_out'),
  teamNow: (): Promise<{ people: TeamPerson[] }> => invoke('team_now'),
  teamDay: (employeeId: string, date: string): Promise<TeamDay> =>
    invoke('team_day', { employeeId, date }),
  /** One person's day totals over `[from, to]` (the person screen's Earlier list). */
  teamDays: (
    employeeId: string,
    from: string,
    to: string,
  ): Promise<{ name: string; days: DaySummary[] }> => invoke('team_days', { employeeId, from, to }),
  teamExceptions: (
    from: string,
    to: string,
    employeeId: string | null = null,
  ): Promise<{ exceptions: TeamException[] }> =>
    invoke('team_exceptions', { from, to, employeeId }),
  adminEmployees: (): Promise<{ employees: EmployeeRow[] }> => invoke('admin_employees'),
  adminSetManager: (
    employeeId: string,
    managerId: string | null,
    reason: string,
  ): Promise<{ id: string; reporting_manager_id: string | null }> =>
    invoke('admin_set_manager', { employeeId, managerId, reason: reason || null }),
  adminDevices: (): Promise<{ devices: DeviceRow[] }> => invoke('admin_devices'),
  /** Where people connect from (ADR-0029); the server checks who sees whom. */
  myConnections: (): Promise<ConnectionHistory> => invoke('my_connections'),
  teamConnections: (): Promise<TeamConnections> => invoke('team_connections'),
  personConnections: (employeeId: string): Promise<ConnectionHistory> =>
    invoke('person_connections', { employeeId }),
  /** Administrators (ADR-0028 §4): null when not clocked in anywhere. */
  adminActiveDevice: (employeeId: string): Promise<ActiveMachine | null> =>
    invoke('admin_active_device', { employeeId }),
  /** Clocks them out at their last activity and signs that computer out. */
  adminActiveDeviceSignOut: (
    employeeId: string,
    deviceId: string,
  ): Promise<{ closed_at: string | null }> =>
    invoke('admin_active_device_sign_out', { employeeId, deviceId }),
  /** "Check again" while blocked (ADR-0028); rejects `offline` if unanswered. */
  checkActiveDevice: (): Promise<StateView> => invoke<StateView>('check_active_device'),
  /** The answer to "Welcome back?" while Away (ADR-0027). */
  answerAwayCheck: (back: boolean): Promise<StateView> =>
    invoke<StateView>('answer_away_check', { back }),
  /** "I'm back" after an unanswered presence check (ADR-0024). */
  confirmPresence: (): Promise<StateView> => invoke<StateView>('confirm_presence'),
  /** "Restart to update" while clocked out; the app exits and reopens. */
  installUpdateNow: (): Promise<void> => invoke<void>('install_update_now'),
  /**
   * "Check for updates" in the account menu: the 4-hourly check, now. A
   * found update is downloaded and installs like any other. Rejects with
   * `not_configured`, `signed_out` or `offline`.
   */
  checkForUpdate: (): Promise<UpdateCheck> => invoke<UpdateCheck>('check_for_update'),
  /** Ask to correct your own time, or (with `employeeId`) a report's, as their manager. */
  requestCorrection: (c: CorrectionInput): Promise<{ correction: DayCorrection }> =>
    invoke<{ correction: DayCorrection }>('request_correction', {
      employeeId: c.employeeId ?? null,
      from: c.from,
      to: c.to,
      tzIana: c.tzIana,
      kind: c.kind,
      reason: c.reason,
    }),
  correctionsQueue: (): Promise<CorrectionQueue> => invoke<CorrectionQueue>('corrections_queue'),
  /** "Not working today" for the shift showing (ADR-0031). */
  notWorkingToday: (): Promise<StateView> => invoke<StateView>('not_working_today'),
  adminShifts: (): Promise<{ people: ShiftRow[] }> =>
    invoke<{ people: ShiftRow[] }>('admin_shifts'),
  /** Set someone's shift; `days` empty clears it. */
  adminSetShift: (
    employeeId: string,
    s: { days: number[]; start: string | null; end: string | null; tzIana: string },
  ): Promise<{ shift: Shift | null }> =>
    invoke<{ shift: Shift | null }>('admin_set_shift', {
      employeeId,
      days: s.days,
      start: s.start,
      end: s.end,
      tzIana: s.tzIana,
    }),
  /** The company holidays, last month to a year ahead (ADR-0037). */
  holidays: (): Promise<{ holidays: Holiday[] }> => invoke<{ holidays: Holiday[] }>('holidays'),
  /** Add or rename a holiday (HR and Administrators). */
  setHoliday: (date: string, name: string): Promise<Holiday> =>
    invoke<Holiday>('admin_set_holiday', { date, name }),
  /** Remove a holiday (HR and Administrators). */
  removeHoliday: (date: string): Promise<unknown> => invoke('admin_remove_holiday', { date }),
  decideCorrection: (
    id: string,
    decision: 'endorse' | 'approve' | 'reject' | 'withdraw',
    note: string | null = null,
  ): Promise<{ correction: DayCorrection }> =>
    invoke<{ correction: DayCorrection }>('decide_correction', { id, decision, note }),
  /** `plannedMinutes`: the "Back in?" answer; null = Not sure. */
  startBreak: (kind: BreakId, plannedMinutes: number | null = null): Promise<StateView> =>
    invoke<StateView>('start_break', { kind, plannedMinutes }),
  endBreak: (): Promise<StateView> => invoke<StateView>('end_break'),
  /** "5 more min" / "10 more min" on a break that ran over (ADR-0031 §3). */
  extendBreak: (minutes: 5 | 10): Promise<StateView> =>
    invoke<StateView>('extend_break', { minutes }),
  markBack: (): Promise<StateView> => invoke<StateView>('mark_back'),
  /** Voluntary tag (ADR-0011 §2). */
  markAway: (reason: 'meeting' | 'training'): Promise<StateView> =>
    invoke<StateView>('mark_away', { reason }),
  explainIdle: (explanation: IdleExplanation, note: string | null): Promise<StateView> =>
    invoke<StateView>('explain_idle', { explanation, note }),
  dismissIdleReturn: (): Promise<StateView> => invoke<StateView>('dismiss_idle_return'),
  respondToPrompt: (response: PromptResponse, note: string | null): Promise<StateView> =>
    invoke<StateView>('respond_to_prompt', { response, note }),
  /** Ask the agent to resize the main window to `height` logical px. */
  fitWindow: (height: number): Promise<void> => invoke<void>('fit_window', { height }),
  authStatus: (): Promise<AuthStatus> => invoke<AuthStatus>('auth_status'),
  /** Opens the system browser; resolves once sign-in completes. */
  signIn: (): Promise<AuthStatus> => invoke<AuthStatus>('sign_in'),
  /** Stop a sign-in waiting on the browser. */
  cancelSignIn: (): Promise<void> => invoke<void>('cancel_sign_in'),
  /** `clockOut`: clock out first ("Clock out and sign out"). */
  signOut: (clockOut = false): Promise<AuthStatus> => invoke<AuthStatus>('sign_out', { clockOut }),
  onAuth: (cb: (status: AuthStatus) => void): Promise<UnlistenFn> =>
    listen<AuthStatus>(AUTH_EVENT, (e) => cb(e.payload)),
  enrollmentStatus: (): Promise<EnrollmentStatus> => invoke<EnrollmentStatus>('enrollment_status'),
  onEnrollment: (cb: (status: EnrollmentStatus) => void): Promise<UnlistenFn> =>
    listen<EnrollmentStatus>(ENROLLMENT_EVENT, (e) => cb(e.payload)),
  onState: (cb: (view: StateView) => void): Promise<UnlistenFn> =>
    listen<StateView>(STATE_EVENT, (e) => cb(e.payload)),
  /** Close dialog answers (ADR-0013 §1). */
  hideToTray: (): Promise<void> => invoke<void>('hide_to_tray'),
  quitApp: (): Promise<void> => invoke<void>('quit_app'),
  clockOutAndQuit: (): Promise<void> => invoke<void>('clock_out_and_quit'),
  onCloseRequested: (cb: () => void): Promise<UnlistenFn> =>
    listen<null>(CLOSE_REQUESTED_EVENT, () => cb()),
  onBreakPicker: (cb: () => void): Promise<UnlistenFn> => listen(BREAK_PICKER_EVENT, () => cb()),
  /** Long-shift banner: "Still working" (ADR-0013 §5). */
  ackLongShift: (): Promise<StateView> => invoke<StateView>('ack_long_shift'),
  /**
   * A past working day (ADR-0016). Rejects with `offline` (nothing
   * cached), `not_configured`, `not_signed_in`, or the backend's code.
   */
  getDay: (date: string): Promise<DayResult> => invoke<DayResult>('get_day', { date }),
  /** Totals per working day for the day picker; rejects like `getDay`. */
  getDays: (from: string, to: string): Promise<DaysResult> =>
    invoke<DaysResult>('get_days', { from, to }),
  /** Pinned mini strip (ADR-0017). Each resolves to the new pinned state. */
  pinWindow: (): Promise<boolean> => invoke<boolean>('pin_window'),
  unpinWindow: (): Promise<boolean> => invoke<boolean>('unpin_window'),
  pinStatus: (): Promise<boolean> => invoke<boolean>('pin_status'),
  onPinned: (cb: (pinned: boolean) => void): Promise<UnlistenFn> =>
    listen<boolean>(PIN_EVENT, (e) => cb(e.payload)),
  /** Move the borderless strip: an OS drag of this window. */
  startDragging: (): Promise<void> => getCurrentWindow().startDragging(),
};
