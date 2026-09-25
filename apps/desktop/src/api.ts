import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { PromptResponse } from './IdlePrompt.js';
import type { Segment } from './timelineModel.js';

/**
 * Typed wrappers around the Rust agent's Tauri commands (slice
 * 2b.7.2b PR D). The core validates everything; a rejected command
 * rejects the promise with a code string (`invalid_transition`,
 * `note_required`, `note_too_long`, `option_not_offered`,
 * `invalid_argument`).
 */

export type Status = 'clocked_out' | 'active' | 'on_call' | 'idle_pending' | 'on_break' | 'away';

/** Mirrors `agent::StateView`. Timestamps are epoch ms. */
export interface StateView {
  status: Status;
  breakKind: 'bio' | 'meal' | 'other' | null;
  awayReason: 'phone_call' | 'working_away' | 'meeting' | null;
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
}

/** The window's close button was pressed (ADR-0013 §1). */
export const CLOSE_REQUESTED_EVENT = 'cp://close-requested';

/** Emitted by the agent after every state change. */
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
  clockOut: (): Promise<StateView> => invoke<StateView>('clock_out'),
  startBreak: (kind: 'bio' | 'meal'): Promise<StateView> =>
    invoke<StateView>('start_break', { kind }),
  endBreak: (): Promise<StateView> => invoke<StateView>('end_break'),
  markBack: (): Promise<StateView> => invoke<StateView>('mark_back'),
  /** Voluntary tag (ADR-0011 §2). */
  markAway: (reason: 'meeting'): Promise<StateView> => invoke<StateView>('mark_away', { reason }),
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
  /** Long-shift banner: "Still working" (ADR-0013 §5). */
  ackLongShift: (): Promise<StateView> => invoke<StateView>('ack_long_shift'),
};
