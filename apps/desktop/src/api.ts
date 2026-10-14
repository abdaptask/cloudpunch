import { bulkShiftBody, officePatternBody, patternBody } from './admin/shiftBodies.js';
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

/** One person's answer in a bulk role or welcome request (ADR-0038 §5). */
export interface BulkOutcome {
  oid: string;
  outcome: 'done' | 'already' | 'sent' | 'refused' | 'failed';
  code?: string;
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
  /** In the office today (ADR-0039): `status` is `holiday`, named "In office". */
  in_office?: true;
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
  /** The named shift they're on (ADR-0038 §6); null or absent: custom. */
  template?: { id: string; name: string } | null;
}

/** Someone's in-office days (ADR-0039): usual weekdays and one-offs in a range. */
/** One person's day in the day-end summary (ADR-0040 §1). */
export type DayReportStatus =
  'worked' | 'late' | 'not_clocked_in' | 'not_working' | 'holiday' | 'in_office' | 'off';

export interface DayReportRow {
  employee_id: string;
  name: string;
  manager_id: string | null;
  date: string;
  status: DayReportStatus;
  holiday?: string;
  shift: { start: string; end: string } | null;
  /** The zone times are shown in. */
  tz: string;
  clock_in: string | null;
  clock_out: string | null;
  still_in: boolean;
  minutes_late: number | null;
  worked_ms: number;
  shift_ms: number;
  idle_ms: number;
  breaks_ms: number;
  breaks_over_limit: number;
  away_ms: number;
  corrections_waiting: number;
  /** The day as work / break / idle spans (older servers send none). */
  segments?: { kind: 'work' | 'break' | 'idle'; from: string; to: string }[];
}

export interface DayReport {
  date: string;
  counts: Record<DayReportStatus, number>;
  people: DayReportRow[];
}

/** One person over a range (ADR-0040 §3). */
export interface OverviewPerson {
  employee_id: string;
  name: string;
  days_worked: number;
  shift_days: number;
  shift_days_worked: number;
  attendance: number | null;
  worked_ms: number;
  scheduled_ms: number;
  late_starts: number;
  avg_minutes_late: number | null;
  missed_starts: number;
  idle_ms: number;
  idle_share: number | null;
  breaks_ms: number;
  break_ms_per_day: number | null;
  breaks_over_limit: number;
  away_ms: number;
}

export interface OverviewWeek {
  week: string;
  shift_days: number;
  shift_days_worked: number;
  late_starts: number;
  missed_starts: number;
  worked_ms: number;
  idle_ms: number;
}

export interface Overview {
  from: string;
  to: string;
  totals: Omit<OverviewPerson, 'employee_id' | 'name'> & { people: number };
  people: OverviewPerson[];
  weeks: OverviewWeek[];
  health: {
    active_people: number;
    with_app: number;
    clocked_in: number;
    never_clocked_in: { employee_id: string; name: string }[];
    versions: { version: string; computers: number }[];
    newest_version: string | null;
    computers_behind: number;
    corrections_waiting: number;
    /** Uploads the server refused in the range, per computer and reason. */
    refused?: {
      employee_id: string;
      name: string;
      os: string | null;
      reason: string;
      events: number;
      ahead_seconds: number | null;
      last_at: string;
    }[];
  };
}

/** One change, in words (ADR-0038 §8). */
export interface HistoryEntry {
  at: string;
  /** Who made it; null for the system or someone no longer listed. */
  by: string | null;
  action: string;
  summary: string;
  reason: string | null;
}

/** A retention dry run (ADR-0044 §3): rows each kind would lose now. */
export interface RetentionPreviewResult {
  enabled: boolean;
  kinds: { kind: string; days: number; rows: number }[];
}

export interface RetentionPeriods {
  time_records_years: number;
  idle_notes_days: number;
  audit_log_years: number;
  notifications_days: number;
  operational_days: number;
}

/** One day on My week's strip (ADR-0047 §5). */
export type DayMark =
  'on_time' | 'late' | 'missed' | 'short' | 'worked' | 'off' | 'office' | 'holiday' | 'not_working';

export interface MyWeek {
  from: string;
  to: string;
  strip: {
    date: string;
    mark: DayMark;
    minutes_late: number | null;
    worked_ms: number;
    shift_ms: number;
    idle_ms: number;
  }[];
  totals: {
    on_time: number;
    shift_days: number;
    worked_ms: number;
    scheduled_ms: number;
    idle_ms: number;
  };
  findings: {
    id: string;
    kind: string;
    status: string;
    headline: string;
    dates: string[];
    nudges: { at: string; by: string | null; message: string | null }[];
    context: { at: string; text: string | null }[];
  }[];
}

export interface OfficeDays {
  employee_id: string;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  weekdays: number[];
  days: { date: string; in_office: boolean }[];
}

/** A named shift's pattern, as it's set up (ADR-0038 §6). */
export interface ShiftPattern {
  name: string;
  days: number[];
  start: string;
  end: string;
  tzIana: string;
}

/** A named shift as listed: today's version, the next change, and who's on it. */
export interface ShiftTemplate {
  id: string;
  name: string;
  days: number[];
  start: string;
  end: string;
  tz_iana: string;
  effective_from: string;
  retired: boolean;
  next: (Shift & { name: string; effective_from: string; retired: boolean }) | null;
  people: number;
}

/** What a bulk shift sets: a named shift, or a pattern (empty days: none). */
export type BulkShiftTarget =
  | { templateId: string }
  | { days: number[]; start: string | null; end: string | null; tzIana: string };

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

/** How far this computer's clock is off, and which way. */
export interface ClockSkew {
  ahead: boolean;
  seconds: number;
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
  /** A pushed update's deadline, epoch ms (ADR-0046 §3). */
  updateRequiredBy?: number | null;
  /** When an overdue pushed update clocks out, updates and clocks back in, epoch ms. */
  updateNoticeUntil?: number | null;
  /** A downloaded update's version, waiting to install (ADR-0022). */
  updateReady: string | null;
  /** The prompt or idle in progress is a presence check (ADR-0024). */
  presenceCheck: 'continuous' | 'periodic' | null;
  /** "Welcome back?" while Away (ADR-0027), epoch ms. */
  awayCheck: { inputSince: number; deadline: number } | null;
  /** Clocked in on another computer: no clock-in here (ADR-0028). */
  blockedElsewhere: BlockedElsewhere | null;
  /** This computer's clock is off from the server's (owner, 2026-10-14). */
  clockSkew?: ClockSkew | null;
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
  /** Each settings save for a scope, newest first (ADR-0038 §8). */
  adminPolicyHistory: (
    scope: 'global' | 'department',
    id: string | null,
  ): Promise<{ entries: HistoryEntry[] }> => invoke('admin_policy_history', { scope, id }),
  /** The changes made to a person, newest first (ADR-0038 §8). */
  adminPersonHistory: (employeeId: string): Promise<{ entries: HistoryEntry[] }> =>
    invoke('admin_person_history', { employeeId }),
  /** What the clean-up would delete now for these periods; changes nothing (ADR-0044). */
  adminRetentionPreview: (periods: RetentionPeriods): Promise<RetentionPreviewResult> =>
    invoke('admin_retention_preview', { periods }),
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
  /**
   * Bulk (ADR-0038 §5). `key` is the request's idempotency key: send the
   * same one again to retry, and the server answers as it did.
   */
  adminBulkManager: (
    key: string,
    employeeIds: string[],
    managerId: string | null,
    reason: string,
  ): Promise<{ manager_employee_id: string | null; changed: string[]; unchanged: string[] }> =>
    invoke('admin_bulk_manager', { key, employeeIds, managerId, reason: reason || null }),
  adminBulkRoles: (
    key: string,
    oids: string[],
    change: { add: string[]; remove: string[] },
    reason: string,
  ): Promise<{ add: string[]; remove: string[]; results: BulkOutcome[] }> =>
    invoke('admin_bulk_roles', {
      key,
      oids,
      add: change.add,
      remove: change.remove,
      reason: reason || null,
    }),
  adminBulkWelcome: (
    key: string,
    oids: string[],
    note: string,
  ): Promise<{ results: BulkOutcome[] }> =>
    invoke('admin_bulk_welcome', { key, oids, note: note || null }),
  /** Where people connect from (ADR-0029); the server checks who sees whom. */
  myConnections: (): Promise<ConnectionHistory> => invoke('my_connections'),
  /** My week (ADR-0047 §5): my own last 14 days and findings. */
  myInsights: (): Promise<MyWeek> => invoke('my_insights'),
  /** My side of a finding about me (ADR-0047 §5). */
  addInsightContext: (id: string, text: string): Promise<{ ok: boolean }> =>
    invoke('add_insight_context', { id, text }),
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
  /**
   * Windows-style update (ADR-0046 §2): clocks out if clocked in,
   * installs, and on the new version `clock_in`, `shutdown` or nothing.
   */
  updateNow: (then: 'none' | 'clock_in' | 'shutdown'): Promise<void> =>
    invoke<void>('update_now', { then }),
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
  /** Named shifts (ADR-0038 §6), Administrators. */
  adminShiftTemplates: (): Promise<{ templates: ShiftTemplate[]; custom: number; none: number }> =>
    invoke('admin_shift_templates'),
  adminCreateShiftTemplate: (t: ShiftPattern, reason: string): Promise<ShiftTemplate> =>
    invoke('admin_create_shift_template', { body: patternBody(t, reason) }),
  /** A new version from `effectiveFrom`; `dryRun` only counts who it changes. */
  adminSaveShiftTemplate: (
    id: string,
    t: ShiftPattern,
    effectiveFrom: string,
    reason: string,
    dryRun = false,
  ): Promise<{ people: number; effective_from: string }> =>
    invoke('admin_save_shift_template', {
      id,
      body: {
        ...patternBody(t, reason),
        effective_from: effectiveFrom,
        ...(dryRun ? { dry_run: true } : {}),
      },
    }),
  adminRetireShiftTemplate: (id: string, reason: string): Promise<{ id: string; retired: true }> =>
    invoke('admin_retire_shift_template', { id, reason: reason || null }),
  /** Give someone a named shift from a date (today when null). */
  adminSetNamedShift: (
    employeeId: string,
    templateId: string,
    effectiveFrom: string | null,
  ): Promise<{ shift: Shift | null; template_id: string | null; effective_from: string }> =>
    invoke('admin_set_named_shift', { employeeId, templateId, effectiveFrom }),
  /** Bulk (ADR-0038 §5): one shift for many, all or nothing; `key` as for the others. */
  adminBulkShift: (
    key: string,
    employeeIds: string[],
    target: BulkShiftTarget,
    effectiveFrom: string | null,
    reason: string,
  ): Promise<{
    template_id: string | null;
    effective_from: string;
    changed: string[];
    unchanged: string[];
  }> =>
    invoke('admin_bulk_shift', {
      body: bulkShiftBody(key, employeeIds, target, effectiveFrom, reason),
    }),
  /** In-office days (ADR-0039), Administrators and HR. */
  adminOfficeDays: (from: string, to: string): Promise<{ people: OfficeDays[] }> =>
    invoke('admin_office_days', { from, to }),
  adminSetOfficePattern: (
    employeeId: string,
    weekdays: number[],
    effectiveFrom: string | null,
    reason: string,
  ): Promise<{ weekdays: number[]; effective_from: string }> =>
    invoke('admin_set_office_pattern', {
      employeeId,
      body: officePatternBody(weekdays, effectiveFrom, reason),
    }),
  adminSetOfficeDay: (
    employeeId: string,
    date: string,
    inOffice: boolean,
    reason: string,
  ): Promise<{ date: string; in_office: boolean }> =>
    invoke('admin_set_office_day', {
      employeeId,
      date,
      body: reason.trim()
        ? { in_office: inOffice, reason: reason.trim() }
        : { in_office: inOffice },
    }),
  /** Bulk (ADR-0038 §5): the same office weekdays for many, all or nothing. */
  adminBulkOffice: (
    key: string,
    employeeIds: string[],
    weekdays: number[],
    effectiveFrom: string | null,
    reason: string,
  ): Promise<{
    weekdays: number[];
    effective_from: string;
    changed: string[];
    unchanged: string[];
  }> =>
    invoke('admin_bulk_office', {
      body: {
        idempotency_key: key,
        employee_ids: employeeIds,
        ...officePatternBody(weekdays, effectiveFrom, reason),
      },
    }),
  /** Each person's day on `date` (ADR-0040 §2), problems first. */
  reportDay: (date: string): Promise<DayReport> => invoke('report_day', { date }),
  /** The overall report for a range (ADR-0040 §3), HR and Administrators. */
  reportOverview: (from: string, to: string): Promise<Overview> =>
    invoke('report_overview', { from, to }),
  /** Save a CSV in Downloads; resolves to where it went. */
  saveCsv: (name: string, text: string): Promise<string> => invoke('save_csv', { name, text }),
  /** The newest published version per system (ADR-0046 §3). */
  adminUpdatesLatest: (): Promise<{ windows: string | null; macos: string | null }> =>
    invoke('admin_updates_latest'),
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
  /** `breakKind` only with `break`: the stretch becomes that break (ADR-0042). */
  explainIdle: (
    explanation: IdleExplanation,
    note: string | null,
    breakKind: BreakId | null = null,
  ): Promise<StateView> => invoke<StateView>('explain_idle', { explanation, note, breakKind }),
  dismissIdleReturn: (): Promise<StateView> => invoke<StateView>('dismiss_idle_return'),
  respondToPrompt: (response: PromptResponse, note: string | null): Promise<StateView> =>
    invoke<StateView>('respond_to_prompt', { response, note }),
  /** Ask the agent to resize the main window to `height` logical px. */
  fitWindow: (height: number): Promise<void> => invoke<void>('fit_window', { height }),
  /** The admin console in its own wide window (ADR-0038 §2); brings it forward if open. */
  openAdminWindow: (): Promise<void> => invoke<void>('open_admin_window'),
  /** From inside the admin window only: close it. */
  closeAdminWindow: (): Promise<void> => invoke<void>('close_admin_window'),
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
