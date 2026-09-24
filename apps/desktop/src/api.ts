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
}

/** Emitted by the agent after every state change. */
export const STATE_EVENT = 'cp://state';

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
  onState: (cb: (view: StateView) => void): Promise<UnlistenFn> =>
    listen<StateView>(STATE_EVENT, (e) => cb(e.payload)),
};
