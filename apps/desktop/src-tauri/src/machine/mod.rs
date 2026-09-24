//! Desktop time-state machine (slice 2b.7.2b, PR B).
//!
//! Pure logic: no OS calls, no threads, no clock reads. Callers feed
//! [`Input`]s with an explicit `now` and act on the returned
//! [`Effect`]s (emit an event, show/hide the idle prompt, refresh the
//! tray). [`driver::Driver`] routes emitted events to an
//! [`sink::EventSink`]. Wiring to the watchers, the webview, and the
//! outbox lands in later PRs.
//!
//! The core owns both timers from ADR-0003 / ADR-0008:
//!   - the idle threshold, measured from the later of the last input
//!     and the last re-arm (clock-in, end of break/away/call, "still
//!     working");
//!   - the grace countdown, which input pushes out to
//!     `last_input + grace` but never stops.
//!
//! While on a call the idle threshold is suspended, but the
//! silent-call cap (ADR-0010) prompts after `max_silent_call` with no
//! input. The ongoing call does not dismiss that prompt: only a new
//! media edge does (ADR-0009), and there is none mid-call.
//!
//! It is driven by a ~1 Hz [`Input::Tick`] carrying the last-input
//! time rather than by `IdleWatcher`'s signals, because that watcher
//! reports only the first input after an idle period and cannot be
//! re-armed "from now" when a call ends.
//!
//! Every event the core emits is first checked against
//! [`transitions::next_payroll_state`], the Rust mirror of the
//! backend state machine, so the client never records a transition
//! the server would reject.
//!
//! Deferred states (ADR-0003 §1): CLOCKING_IN / CLOCKING_OUT, LOCKED,
//! SLEEPING, OFFLINE_PENDING_SYNC, ERROR_REQUIRING_ATTENTION. Bio/meal
//! break-cap nudges are also deferred.

pub mod driver;
pub mod sink;
pub mod transitions;

use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

pub use transitions::PayrollState;

/// `idle.prompt_options` identifiers. Mirrors
/// `user-prompt-response.schema.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptResponse {
    StillWorking,
    BioBreak,
    MealBreak,
    OnPhoneCall,
    WorkingAway,
    EndShift,
}

impl PromptResponse {
    pub const ALL: [PromptResponse; 6] = [
        PromptResponse::StillWorking,
        PromptResponse::BioBreak,
        PromptResponse::MealBreak,
        PromptResponse::OnPhoneCall,
        PromptResponse::WorkingAway,
        PromptResponse::EndShift,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            PromptResponse::StillWorking => "still_working",
            PromptResponse::BioBreak => "bio_break",
            PromptResponse::MealBreak => "meal_break",
            PromptResponse::OnPhoneCall => "on_phone_call",
            PromptResponse::WorkingAway => "working_away",
            PromptResponse::EndShift => "end_shift",
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|r| r.as_str() == s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakKind {
    Bio,
    Meal,
    Other,
}

impl BreakKind {
    pub fn as_str(self) -> &'static str {
        match self {
            BreakKind::Bio => "bio",
            BreakKind::Meal => "meal",
            BreakKind::Other => "other",
        }
    }
}

/// Only the reasons reachable from the prompt today. Manual
/// `USER_MARK_AWAY` (and its `meeting` / `other` reasons) has no
/// payload schema yet and is not wired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AwayReason {
    PhoneCall,
    WorkingAway,
}

/// Why the idle prompt opened (`INPUT_IDLE_5M.payload.trigger`,
/// ADR-0010).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleTrigger {
    /// No input for `idle_threshold` while `ACTIVE`.
    InputIdle,
    /// No input for `max_silent_call` while `ON_CALL`.
    SilentCall,
}

impl IdleTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            IdleTrigger::InputIdle => "input_idle",
            IdleTrigger::SilentCall => "silent_call",
        }
    }
}

/// Maximum `note` length (`user-prompt-response.schema.json`).
pub const NOTE_MAX_CHARS: usize = 500;

/// Policy knobs the core needs. Defaults are
/// `docs/policy/idle-policy-defaults.md`; real values come from the
/// policy endpoint once it exists.
#[derive(Debug, Clone)]
pub struct CoreConfig {
    /// `idle.threshold_seconds`.
    pub idle_threshold: Duration,
    /// `idle.grace_seconds`.
    pub grace: Duration,
    /// `idle.media_state_debounce_seconds` — how long mic/cam must
    /// stay off before a call counts as ended.
    pub media_off_debounce: Duration,
    /// `idle.suppress_prompt_when_media_active`. When false, media
    /// state is ignored entirely and `ON_CALL` is never entered.
    pub suppress_prompt_when_media_active: bool,
    /// `idle.max_silent_call_minutes` (ADR-0010): prompt anyway after
    /// this long on a call with no input. `None` disables the cap.
    pub max_silent_call: Option<Duration>,
    /// `idle.prompt_options`.
    pub prompt_options: Vec<PromptResponse>,
    /// Responses whose note is mandatory (`away.require_note`).
    pub note_required_for: Vec<PromptResponse>,
}

impl Default for CoreConfig {
    fn default() -> Self {
        Self {
            idle_threshold: Duration::from_secs(300),
            grace: Duration::from_secs(30),
            media_off_debounce: Duration::from_secs(5),
            suppress_prompt_when_media_active: true,
            max_silent_call: Some(Duration::from_secs(30 * 60)),
            prompt_options: PromptResponse::ALL.to_vec(),
            note_required_for: vec![PromptResponse::WorkingAway],
        }
    }
}

/// Desktop view of the session. Richer than [`PayrollState`]: it
/// carries the break kind, away reason, and the prompt timing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreState {
    ClockedOut,
    Active,
    OnCall,
    IdlePending {
        shown_at: SystemTime,
        deadline: SystemTime,
    },
    OnBreak {
        kind: BreakKind,
    },
    Away {
        reason: AwayReason,
    },
}

impl CoreState {
    /// Server-side equivalent. `None` when no session is open.
    pub fn payroll(&self) -> Option<PayrollState> {
        Some(match self {
            CoreState::ClockedOut => return None,
            CoreState::Active => PayrollState::Active,
            CoreState::OnCall => PayrollState::OnCall,
            CoreState::IdlePending { .. } => PayrollState::IdlePending,
            CoreState::OnBreak { .. } => PayrollState::OnBreak,
            CoreState::Away { .. } => PayrollState::Away,
        })
    }
}

/// Everything that can drive the core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    ClockIn,
    ClockOut,
    StartBreak(BreakKind),
    EndBreak,
    /// "I'm back" from `AWAY`.
    MarkBack,
    RespondToPrompt {
        response: PromptResponse,
        note: Option<String>,
    },
    /// Raw mic-OR-camera state from the watcher, before debounce.
    MediaInUse(bool),
    /// Periodic (~1 Hz) tick with the time of the last keyboard or
    /// pointer input.
    Tick {
        last_input_at: SystemTime,
    },
}

/// An event to record. Typed; encoding to the signed wire format
/// (ULID, sequence number, timestamps, signature) is the event sink's
/// job (PR C / slice 2b.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreEvent {
    UserClockIn,
    UserClockOut,
    UserStartBreak {
        kind: BreakKind,
    },
    UserEndBreak,
    UserMarkBack,
    UserPromptResponse {
        response: PromptResponse,
        note: Option<String>,
        prompt_shown_at: SystemTime,
    },
    InputIdle5m {
        trigger: IdleTrigger,
    },
    PromptTimeout30s,
    MediaDeviceState {
        in_use: bool,
    },
}

impl CoreEvent {
    pub fn event_type(&self) -> &'static str {
        match self {
            CoreEvent::UserClockIn => "USER_CLOCK_IN",
            CoreEvent::UserClockOut => "USER_CLOCK_OUT",
            CoreEvent::UserStartBreak { .. } => "USER_START_BREAK",
            CoreEvent::UserEndBreak => "USER_END_BREAK",
            CoreEvent::UserMarkBack => "USER_MARK_BACK",
            CoreEvent::UserPromptResponse { .. } => "USER_PROMPT_RESPONSE",
            CoreEvent::InputIdle5m { .. } => "INPUT_IDLE_5M",
            CoreEvent::PromptTimeout30s => "PROMPT_TIMEOUT_30S",
            CoreEvent::MediaDeviceState { .. } => "MEDIA_DEVICE_STATE",
        }
    }

    /// The payload fields the state machine reads. Timestamps and the
    /// note are added by the wire encoder.
    pub fn transition_payload(&self) -> Value {
        match self {
            CoreEvent::UserStartBreak { kind } => json!({ "break_kind": kind.as_str() }),
            CoreEvent::UserPromptResponse { response, .. } => {
                json!({ "response": response.as_str() })
            }
            CoreEvent::MediaDeviceState { in_use } => json!({ "in_use": in_use }),
            CoreEvent::InputIdle5m { trigger } => json!({ "trigger": trigger.as_str() }),
            _ => json!({}),
        }
    }
}

/// What the caller must do after an input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Emit {
        event: CoreEvent,
        at: SystemTime,
    },
    ShowPrompt {
        deadline: SystemTime,
    },
    /// Input pushed the grace deadline out (ADR-0008 §2).
    UpdatePromptDeadline {
        deadline: SystemTime,
    },
    HidePrompt,
    StateChanged(CoreState),
}

/// Why an input was refused. The core's state is unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejected {
    /// Not valid from the current state.
    InvalidTransition,
    /// Response not in `idle.prompt_options`.
    OptionNotOffered,
    /// Note required for this response but missing or blank.
    NoteRequired,
    /// Note longer than [`NOTE_MAX_CHARS`].
    NoteTooLong,
}

pub struct Core {
    cfg: CoreConfig,
    state: CoreState,
    /// Idle threshold is measured from max(last input, this).
    idle_armed_at: SystemTime,
    /// Debounced mic-OR-camera state.
    media_on: bool,
    /// Set while raw media is off but the debounce has not elapsed.
    media_off_since: Option<SystemTime>,
    /// When `ON_CALL` was last entered. The silent-call cap is
    /// measured from max(last input, this) (ADR-0010).
    on_call_since: SystemTime,
}

impl Core {
    pub fn new(cfg: CoreConfig, now: SystemTime) -> Self {
        Self {
            cfg,
            state: CoreState::ClockedOut,
            idle_armed_at: now,
            media_on: false,
            media_off_since: None,
            on_call_since: now,
        }
    }

    pub fn state(&self) -> CoreState {
        self.state
    }

    pub fn config(&self) -> &CoreConfig {
        &self.cfg
    }

    pub fn handle(&mut self, input: Input, now: SystemTime) -> Result<Vec<Effect>, Rejected> {
        let mut fx = Vec::new();
        match input {
            Input::ClockIn => {
                if self.state != CoreState::ClockedOut {
                    return Err(Rejected::InvalidTransition);
                }
                fx.push(Effect::Emit {
                    event: CoreEvent::UserClockIn,
                    at: now,
                });
                self.enter_active(now, &mut fx);
            }
            Input::ClockOut => {
                self.apply(CoreEvent::UserClockOut, now, &mut fx)?;
            }
            Input::StartBreak(kind) => {
                self.apply(CoreEvent::UserStartBreak { kind }, now, &mut fx)?;
            }
            Input::EndBreak => {
                self.apply(CoreEvent::UserEndBreak, now, &mut fx)?;
            }
            Input::MarkBack => {
                self.apply(CoreEvent::UserMarkBack, now, &mut fx)?;
            }
            Input::RespondToPrompt { response, note } => {
                let CoreState::IdlePending { shown_at, .. } = self.state else {
                    return Err(Rejected::InvalidTransition);
                };
                let note = self.validate_note(response, note)?;
                self.apply(
                    CoreEvent::UserPromptResponse {
                        response,
                        note,
                        prompt_shown_at: shown_at,
                    },
                    now,
                    &mut fx,
                )?;
            }
            Input::MediaInUse(raw) => self.media_raw(raw, now, &mut fx),
            Input::Tick { last_input_at } => self.tick(last_input_at, now, &mut fx),
        }
        Ok(fx)
    }

    fn validate_note(
        &self,
        response: PromptResponse,
        note: Option<String>,
    ) -> Result<Option<String>, Rejected> {
        if !self.cfg.prompt_options.contains(&response) {
            return Err(Rejected::OptionNotOffered);
        }
        let note = note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
        if self.cfg.note_required_for.contains(&response) && note.is_none() {
            return Err(Rejected::NoteRequired);
        }
        if note
            .as_ref()
            .is_some_and(|n| n.chars().count() > NOTE_MAX_CHARS)
        {
            return Err(Rejected::NoteTooLong);
        }
        Ok(note)
    }

    /// Check `event` against the server machine, emit it, and move to
    /// the resulting state.
    fn apply(
        &mut self,
        event: CoreEvent,
        now: SystemTime,
        fx: &mut Vec<Effect>,
    ) -> Result<(), Rejected> {
        let from = self.state.payroll().ok_or(Rejected::InvalidTransition)?;
        let payload = event.transition_payload();
        let to = transitions::next_payroll_state(from, event.event_type(), Some(&payload))
            .ok_or(Rejected::InvalidTransition)?;

        let was_pending = matches!(self.state, CoreState::IdlePending { .. });
        let next = match (to, &event) {
            (PayrollState::Closed, _) => CoreState::ClockedOut,
            (PayrollState::Active, _) => CoreState::Active,
            (PayrollState::OnCall, _) => CoreState::OnCall,
            (PayrollState::IdlePending, _) => CoreState::IdlePending {
                shown_at: now,
                deadline: now + self.cfg.grace,
            },
            (PayrollState::OnBreak, CoreEvent::UserStartBreak { kind }) => {
                CoreState::OnBreak { kind: *kind }
            }
            (PayrollState::OnBreak, CoreEvent::UserPromptResponse { response, .. }) => {
                CoreState::OnBreak {
                    kind: if *response == PromptResponse::MealBreak {
                        BreakKind::Meal
                    } else {
                        BreakKind::Bio
                    },
                }
            }
            (PayrollState::Away, CoreEvent::UserPromptResponse { response, .. }) => {
                CoreState::Away {
                    reason: if *response == PromptResponse::WorkingAway {
                        AwayReason::WorkingAway
                    } else {
                        AwayReason::PhoneCall
                    },
                }
            }
            // Unreachable given the events the core emits; refuse
            // rather than guess.
            _ => return Err(Rejected::InvalidTransition),
        };

        fx.push(Effect::Emit { event, at: now });
        if was_pending && !matches!(next, CoreState::IdlePending { .. }) {
            fx.push(Effect::HidePrompt);
        }
        match next {
            CoreState::Active => self.enter_active(now, fx),
            CoreState::IdlePending { deadline, .. } => {
                self.set_state(next, fx);
                fx.push(Effect::ShowPrompt { deadline });
            }
            CoreState::OnCall => {
                self.on_call_since = now;
                self.set_state(next, fx);
            }
            _ => self.set_state(next, fx),
        }
        Ok(())
    }

    /// Enter `ACTIVE`, re-arm the idle timer, and go straight to
    /// `ON_CALL` if a call is already in progress.
    fn enter_active(&mut self, now: SystemTime, fx: &mut Vec<Effect>) {
        self.idle_armed_at = now;
        self.set_state(CoreState::Active, fx);
        if self.media_on && self.cfg.suppress_prompt_when_media_active {
            // Infallible from ACTIVE.
            let _ = self.apply(CoreEvent::MediaDeviceState { in_use: true }, now, fx);
        }
    }

    fn set_state(&mut self, next: CoreState, fx: &mut Vec<Effect>) {
        self.state = next;
        fx.push(Effect::StateChanged(next));
    }

    fn media_raw(&mut self, raw: bool, now: SystemTime, fx: &mut Vec<Effect>) {
        if raw {
            self.media_off_since = None;
            if !self.media_on {
                self.media_on = true;
                self.media_edge(now, fx);
            }
        } else if self.media_on && self.media_off_since.is_none() {
            self.media_off_since = Some(now);
        }
    }

    fn media_edge(&mut self, now: SystemTime, fx: &mut Vec<Effect>) {
        if !self.cfg.suppress_prompt_when_media_active {
            return;
        }
        let event = CoreEvent::MediaDeviceState {
            in_use: self.media_on,
        };
        // Only state-changing edges are recorded: ACTIVE/IDLE_PENDING
        // → ON_CALL and ON_CALL → ACTIVE. Elsewhere (break, away,
        // clocked out) the edge is remembered in `media_on` and
        // applied when the user returns to ACTIVE.
        let changes = self.state.payroll().is_some_and(|from| {
            transitions::next_payroll_state(
                from,
                event.event_type(),
                Some(&event.transition_payload()),
            )
            .is_some_and(|to| to != from)
        });
        if changes {
            let _ = self.apply(event, now, fx);
        }
    }

    fn tick(&mut self, last_input_at: SystemTime, now: SystemTime, fx: &mut Vec<Effect>) {
        // A last-input time in the future (clock skew) counts as now.
        let last_input_at = last_input_at.min(now);

        if let Some(off_since) = self.media_off_since {
            if elapsed(off_since, now) >= self.cfg.media_off_debounce {
                self.media_off_since = None;
                self.media_on = false;
                self.media_edge(now, fx);
            }
        }

        match self.state {
            CoreState::Active => {
                let since = last_input_at.max(self.idle_armed_at);
                if elapsed(since, now) >= self.cfg.idle_threshold {
                    let event = CoreEvent::InputIdle5m {
                        trigger: IdleTrigger::InputIdle,
                    };
                    let _ = self.apply(event, now, fx);
                }
            }
            CoreState::OnCall => {
                if let Some(cap) = self.cfg.max_silent_call {
                    let since = last_input_at.max(self.on_call_since);
                    if elapsed(since, now) >= cap {
                        let event = CoreEvent::InputIdle5m {
                            trigger: IdleTrigger::SilentCall,
                        };
                        let _ = self.apply(event, now, fx);
                    }
                }
            }
            CoreState::IdlePending { shown_at, deadline } => {
                let mut deadline = deadline;
                if last_input_at > shown_at {
                    let pushed = last_input_at + self.cfg.grace;
                    if pushed > deadline {
                        deadline = pushed;
                        self.state = CoreState::IdlePending { shown_at, deadline };
                        fx.push(Effect::UpdatePromptDeadline { deadline });
                    }
                }
                if now >= deadline {
                    let _ = self.apply(CoreEvent::PromptTimeout30s, now, fx);
                }
            }
            _ => {}
        }
    }
}

fn elapsed(since: SystemTime, now: SystemTime) -> Duration {
    now.duration_since(since).unwrap_or(Duration::ZERO)
}

#[cfg(test)]
mod tests;
