import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { DayResult } from './dayHistory.js';
import type { DaysResult } from './dayPickerModel.js';
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
  adminPeopleSetRoles: (oid: string, roles: string[], reason: string): Promise<unknown> =>
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
  /** "Restart to update" while clocked out; the app exits and reopens. */
  installUpdateNow: (): Promise<void> => invoke<void>('install_update_now'),
  /** `plannedMinutes`: the "Back in?" answer; null = Not sure. */
  startBreak: (kind: BreakId, plannedMinutes: number | null = null): Promise<StateView> =>
    invoke<StateView>('start_break', { kind, plannedMinutes }),
  endBreak: (): Promise<StateView> => invoke<StateView>('end_break'),
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
  signOut: (): Promise<AuthStatus> => invoke<AuthStatus>('sign_out'),
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
