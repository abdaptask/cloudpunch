//! The running agent: one [`Driver`] shared by the Tauri commands,
//! the tray menu, the OS-watcher drain thread, and a 1 Hz tick thread.
//!
//! [`Agent::handle`] locks the driver, runs the input, releases the
//! lock, and only then touches windows and the tray, so no UI call
//! ever happens under the lock.
//!
//! UI effects:
//!   - every handled input that produced effects broadcasts the new
//!     [`StateView`] as the `cp://state` event and refreshes the tray;
//!   - `ShowPrompt` opens the `idle-prompt` window (always on top,
//!     focused once, not closable); `HidePrompt` destroys it;
//!   - an auto clock-out from the grace timeout brings the main window
//!     forward so the user sees why.
//!
//! The prompt window is only ever *created* from the tick thread:
//! building a webview window inside a synchronous command or event
//! handler deadlocks on Windows (see `WebviewWindowBuilder::build`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::active_device::BlockedView;
use crate::call_type::{self, Rules};
use crate::machine::driver::Driver;
use crate::machine::{
    AwayReason, BreakKind, CallType, Core, CoreConfig, CoreState, Effect, IdleStretch, Input,
    Rejected,
};
use crate::policy::PolicyDoc;
use crate::recorder::{OutboxSink, Recorder};
use crate::reminders::{
    self, Inputs as ReminderInputs, NudgeInputs, NudgeState, Reminder, ReminderConfig,
    ReminderState,
};
use crate::timeline::{epoch_ms, SegmentView, Timeline};
use crate::tray::{self, TrayStateSnapshot};

/// Label of the idle prompt window. The frontend routes on it.
pub const PROMPT_WINDOW: &str = "idle-prompt";
/// Event carrying a [`StateView`] to every webview.
pub const STATE_EVENT: &str = "cp://state";
/// A break past its plan alerts again this often (ADR-0031 §3).
pub const BREAK_OVER_REPEAT: Duration = Duration::from_secs(2 * 60);

/// This build's version (shown on screen and in the tray, owner request).
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// What the webviews see. Timestamps are epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateView {
    /// clocked_out | active | on_call | idle_pending | on_break | away
    pub status: &'static str,
    pub break_kind: Option<&'static str>,
    pub away_reason: Option<&'static str>,
    /// phone | teams | zoom | other while `on_call` (ADR-0012).
    pub call_type: Option<&'static str>,
    pub prompt_deadline: Option<u64>,
    pub prompt_options: Vec<&'static str>,
    pub note_required_for: Vec<&'static str>,
    /// Set after a grace-timeout clock-out until the next clock-in.
    pub auto_clocked_out_at: Option<u64>,
    /// Clock-in time of the open session; `None` when clocked out.
    pub session_started_at: Option<u64>,
    /// Segments tracked on this device since the app started
    /// (`timeline` module). Display only, not payable hours.
    pub timeline: Vec<SegmentView>,
    /// Long-shift check showing (ADR-0013 §5).
    pub long_shift: bool,
    /// Start of the logged idle stretch while `idle` (ADR-0018).
    pub idle_since: Option<u64>,
    /// An idle stretch that just ended, waiting for "what were you
    /// doing?" (ADR-0018 §2).
    pub idle_return: Option<IdleReturnView>,
    /// Why `auto_clocked_out_at` happened: `idle_cap` or `prompt`.
    pub auto_clock_out_reason: Option<&'static str>,
    /// When the person signed in to the computer, if a clock-in may
    /// start then (ADR-0018 §4). Only while clocked out.
    pub signed_in_at: Option<u64>,
    /// The daily clock-in popup is showing.
    pub clock_in_prompt: bool,
    /// The popup is for a shift (ADR-0031): offer "Not working today".
    pub not_working_offered: bool,
    /// Policy's long day for the end-of-day summary, ms (ADR-0013 §8).
    pub long_day_ms: u64,
    /// The break types to offer, in menu order (ADR-0023 §1).
    pub break_options: Vec<crate::policy::BreakOption>,
    /// Offer Training as an Away reason (ADR-0023 §1).
    pub offer_training: bool,
    /// The current break's "Back in?" answer, minutes (ADR-0023 §2),
    /// with any "5 / 10 more min".
    pub planned_break_minutes: Option<u8>,
    /// When the planned break ran out, while it is still going
    /// (ADR-0031 §3): the red, blinking "Your break is over".
    pub break_over_since: Option<u64>,
    /// This build's version.
    pub app_version: &'static str,
    /// A downloaded update's version, waiting to install (ADR-0022).
    pub update_ready: Option<String>,
    /// The prompt or idle in progress is a presence check (ADR-0024):
    /// `continuous` or `periodic`.
    pub presence_check: Option<&'static str>,
    /// "Welcome back?" while Away (ADR-0027).
    pub away_check: Option<AwayCheckView>,
    /// Clocked in on another computer: no clock-in here (ADR-0028).
    pub blocked_elsewhere: Option<BlockedView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwayCheckView {
    /// When they started using the computer again (epoch ms).
    pub input_since: u64,
    /// Unanswered by then, Away ends on its own (epoch ms).
    pub deadline: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleReturnView {
    pub since: u64,
    pub until: u64,
}

impl StateView {
    pub fn with_idle_return(mut self, stretch: Option<IdleStretch>) -> Self {
        self.idle_return = stretch.map(|s| IdleReturnView {
            since: epoch_ms(s.since),
            until: epoch_ms(s.until),
        });
        self
    }

    pub fn with_clock_in_offer(mut self, offer: Option<SystemTime>, prompt: bool) -> Self {
        self.signed_in_at = offer.map(epoch_ms);
        self.clock_in_prompt = prompt;
        self
    }

    pub fn with_not_working_offered(mut self, offered: bool) -> Self {
        self.not_working_offered = offered;
        self
    }

    pub fn with_break_over(mut self, since: Option<SystemTime>) -> Self {
        self.break_over_since = since.map(epoch_ms);
        self
    }

    pub fn with_auto_clock_out_reason(mut self, reason: Option<&'static str>) -> Self {
        self.auto_clock_out_reason = reason;
        self
    }

    pub fn with_long_shift(mut self, long_shift: bool) -> Self {
        self.long_shift = long_shift;
        self
    }

    pub fn with_away_check(mut self, c: Option<crate::machine::AwayCheck>) -> Self {
        self.away_check = c.map(|c| AwayCheckView {
            input_since: epoch_ms(c.input_since),
            deadline: epoch_ms(c.deadline),
        });
        self
    }

    pub fn with_presence(mut self, p: Option<crate::machine::pattern::InputPattern>) -> Self {
        self.presence_check = p.map(|p| p.as_str());
        self
    }

    pub fn with_update_ready(mut self, version: Option<&str>) -> Self {
        self.update_ready = version.map(str::to_string);
        self
    }

    /// What the break menu offers, and the break in progress's plan.
    pub fn with_breaks(
        mut self,
        breaks: &crate::policy::Breaks,
        offer_training: bool,
        planned: Option<u8>,
    ) -> Self {
        self.break_options = breaks.offered();
        self.offer_training = offer_training;
        self.planned_break_minutes = if self.status == "on_break" {
            planned
        } else {
            None
        };
        self
    }

    pub fn with_long_day(mut self, long_day: Duration) -> Self {
        self.long_day_ms = u64::try_from(long_day.as_millis()).unwrap_or(u64::MAX);
        self
    }

    pub fn with_call_type(mut self, call_type: Option<CallType>) -> Self {
        self.call_type = call_type.map(CallType::as_str);
        self
    }

    pub fn with_blocked(mut self, blocked: Option<&BlockedView>) -> Self {
        self.blocked_elsewhere = blocked.cloned();
        self
    }

    pub fn with_timeline(mut self, timeline: &Timeline) -> Self {
        self.session_started_at = timeline.session_started_at().map(epoch_ms);
        self.timeline = timeline.views();
        self
    }
}

/// Pure: build the webview view of `state`.
pub fn view_of(
    state: CoreState,
    cfg: &CoreConfig,
    auto_clocked_out_at: Option<SystemTime>,
) -> StateView {
    let idle_since = match state {
        CoreState::Idle { since } => Some(epoch_ms(since)),
        _ => None,
    };
    let (status, break_kind, away_reason, prompt_deadline) = match state {
        CoreState::ClockedOut => ("clocked_out", None, None, None),
        CoreState::Idle { .. } => ("idle", None, None, None),
        CoreState::Active => ("active", None, None, None),
        CoreState::OnCall => ("on_call", None, None, None),
        CoreState::IdlePending { deadline, .. } => {
            ("idle_pending", None, None, Some(epoch_ms(deadline)))
        }
        CoreState::OnBreak { kind } => ("on_break", Some(kind.as_str()), None, None),
        CoreState::Away { reason } => ("away", None, Some(reason.as_str()), None),
    };
    StateView {
        status,
        break_kind,
        away_reason,
        call_type: None,
        prompt_deadline,
        prompt_options: cfg.prompt_options.iter().map(|r| r.as_str()).collect(),
        note_required_for: cfg.note_required_for.iter().map(|r| r.as_str()).collect(),
        auto_clocked_out_at: auto_clocked_out_at.map(epoch_ms),
        session_started_at: None,
        timeline: Vec::new(),
        long_shift: false,
        long_day_ms: 8 * 3_600_000,
        idle_since,
        idle_return: None,
        auto_clock_out_reason: None,
        signed_in_at: None,
        clock_in_prompt: false,
        not_working_offered: false,
        break_over_since: None,
        break_options: crate::policy::Breaks::default().offered(),
        offer_training: true,
        planned_break_minutes: None,
        app_version: APP_VERSION,
        update_ready: None,
        presence_check: None,
        away_check: None,
        blocked_elsewhere: None,
    }
}

/// Pure: tray label/menu variant for `state`.
pub fn tray_snapshot(state: CoreState, call_type: Option<CallType>) -> TrayStateSnapshot {
    match state {
        CoreState::ClockedOut => TrayStateSnapshot::NotClockedIn,
        CoreState::OnBreak { .. } => TrayStateSnapshot::OnBreak,
        CoreState::Away { reason } => TrayStateSnapshot::Away(reason),
        CoreState::OnCall => TrayStateSnapshot::OnCall(call_type.unwrap_or(CallType::Other)),
        // Idle is still clocked in; the tooltip says since when.
        CoreState::Active | CoreState::IdlePending { .. } | CoreState::Idle { .. } => {
            TrayStateSnapshot::ClockedIn
        }
    }
}

/// Wire string for a rejected input, returned to the webview.
pub fn rejection_code(r: &Rejected) -> &'static str {
    match r {
        Rejected::InvalidTransition => "invalid_transition",
        Rejected::OptionNotOffered => "option_not_offered",
        Rejected::NoteRequired => "note_required",
        Rejected::NoteTooLong => "note_too_long",
        Rejected::StartOutOfRange => "start_out_of_range",
        Rejected::ClockedInElsewhere => "clocked_in_elsewhere",
    }
}

/// Tags the UI may set directly: `meeting` (ADR-0011 §2) and
/// `training` (ADR-0023 §1). Phone and working-away are prompt answers
/// only; `other` isn't offered.
pub fn parse_away_tag(s: &str) -> Option<AwayReason> {
    match s {
        "meeting" => Some(AwayReason::Meeting),
        "training" => Some(AwayReason::Training),
        _ => None,
    }
}

pub fn parse_break_kind(s: &str) -> Option<BreakKind> {
    BreakKind::from_wire(s)
}

/// A "Back in?" answer: one of [`PLANNED_MINUTES`], or `None` for
/// "Not sure". Anything else is refused (the server would too).
pub fn parse_planned_minutes(m: Option<u32>) -> Result<Option<u8>, &'static str> {
    match m {
        None => Ok(None),
        Some(m) => crate::machine::PLANNED_MINUTES
            .into_iter()
            .find(|p| u32::from(*p) == m)
            .map(Some)
            .ok_or("invalid_argument"),
    }
}

/// Window/tray work decided under the lock, applied after it.
#[derive(Debug, Default, PartialEq, Eq)]
struct UiPlan {
    broadcast: bool,
    show_prompt: bool,
    hide_prompt: bool,
    show_main: bool,
    /// Flash the taskbar / Dock (ADR-0031 §3).
    attention: bool,
    /// Refresh the tray colour and tooltip.
    tray: bool,
    tooltip: String,
    /// Notifications to show, as (title, body).
    notes: Vec<(String, String)>,
    /// Install this downloaded update now (ADR-0022 §2).
    install_update: Option<String>,
    /// A line for the update log (why an update waits).
    update_note: Option<String>,
}

/// The window/tray side of the agent. Production uses [`TauriUi`];
/// tests use a recording fake, which also keeps Tauri's window code
/// out of the unit-test binary (it needs the Windows app manifest,
/// which `tauri-build` only embeds into the real executable).
pub trait Ui: Send + Sync + 'static {
    fn show_prompt(&self);
    fn hide_prompt(&self);
    fn show_main(&self);
    /// Flash the taskbar / bounce the Dock until the window is used
    /// (ADR-0031 §3); works even when the OS won't bring it forward.
    fn request_attention(&self) {}
    fn state_changed(&self, view: &StateView, tray: TrayStateSnapshot);
    /// Main window shown and not minimised (reminders only fire when
    /// it isn't, ADR-0013 §2).
    fn main_visible(&self) -> bool;
    fn notify(&self, title: &str, body: &str);
    /// Tray icon colour and tooltip (ADR-0013 §3).
    fn tray_status(&self, tray: TrayStateSnapshot, tooltip: &str);
    /// Install the downloaded update `version` and restart (ADR-0022).
    fn install_update(&self, _version: &str) {}
    /// Append a line to the local update log.
    fn log_update(&self, _line: &str) {}
}

pub struct TauriUi {
    app: AppHandle,
}

impl TauriUi {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl Ui for TauriUi {
    fn install_update(&self, version: &str) {
        crate::updater::install(&self.app, version);
    }

    fn log_update(&self, line: &str) {
        crate::updater::log(&self.app, line);
    }

    fn show_prompt(&self) {
        open_prompt_window(&self.app);
    }

    fn hide_prompt(&self) {
        if let Some(w) = self.app.get_webview_window(PROMPT_WINDOW) {
            let _ = w.destroy();
        }
    }

    fn show_main(&self) {
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }

    fn request_attention(&self) {
        // Windows flashes the taskbar button, macOS bounces the Dock
        // icon, until the window is used.
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Critical));
        }
    }

    fn state_changed(&self, view: &StateView, tray_state: TrayStateSnapshot) {
        let _ = self.app.emit(STATE_EVENT, view);
        if let Err(e) = tray::update(&self.app, tray_state) {
            eprintln!("[cloudpunch] tray update failed: {e}");
        }
    }

    fn main_visible(&self) -> bool {
        self.app
            .get_webview_window("main")
            .is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
    }

    fn notify(&self, title: &str, body: &str) {
        use tauri_plugin_notification::NotificationExt;
        let shown = self
            .app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
        if let Err(e) = shown {
            eprintln!("[cloudpunch] notification failed: {e}");
        }
    }

    fn tray_status(&self, tray_state: TrayStateSnapshot, tooltip: &str) {
        if let Err(e) = tray::set_status(&self.app, tray_state, tooltip) {
            eprintln!("[cloudpunch] tray status failed: {e}");
        }
    }
}

struct Inner {
    driver: Driver<OutboxSink>,
    auto_clocked_out_at: Option<SystemTime>,
    auto_clock_out_reason: Option<&'static str>,
    /// Latest Windows logon / unlock / wake (ADR-0018 §4).
    signed_in_at: Option<SystemTime>,
    clock_in_prompt: bool,
    prompt_state: crate::clock_in_prompt::PromptState,
    /// The person's shift and any "Not working today" (ADR-0031).
    shift: crate::shift::ShiftInfo,
    /// The planned break ran out at this time and is still going.
    break_over_since: Option<SystemTime>,
    /// When the overrun alert last went off (it repeats, ADR-0031 §3).
    break_over_alerted_at: Option<SystemTime>,
    /// The shift popup waits until then ("Not now", or a clock-out).
    shift_snooze_until: Option<SystemTime>,
    timeline: Timeline,
    reminder_cfg: ReminderConfig,
    reminders: ReminderState,
    /// "Ready to clock in?" (ADR-0013 §7).
    nudge: NudgeState,
    /// Long-shift banner showing until "Still working" or clock-out.
    long_shift: bool,
    /// Last minute the tray tooltip was refreshed.
    tooltip_minute: Option<u64>,
    /// A fetched policy waiting for the session to end (ADR-0015 §6).
    pending_policy: Option<PendingPolicy>,
    /// Local minutes after midnight, for quiet hours; the OS clock
    /// outside tests.
    minute_of_day: fn() -> u16,
    /// The break catalogue and Training, from the policy (ADR-0023).
    breaks: crate::policy::Breaks,
    offer_training: bool,
    /// The current break's "Back in?" answer (ADR-0023 §2).
    planned_break: Option<u8>,
    /// A downloaded update waiting for its moment (ADR-0022 §2).
    update: crate::app_update::UpdateState,
    /// When this run started: an update may also install just after.
    started_at: SystemTime,
    /// Clocked in on another computer (ADR-0028): no clock-in here.
    blocked: Option<BlockedView>,
}

/// Core settings from a policy, adopted only while clocked out.
struct PendingPolicy {
    core: CoreConfig,
    rules: Rules,
    version: Option<String>,
}

impl Inner {
    fn view(&self) -> StateView {
        view_of(
            self.driver.state(),
            self.driver.core().config(),
            self.auto_clocked_out_at,
        )
        .with_call_type(self.driver.core().call_type())
        .with_timeline(&self.timeline)
        .with_long_shift(self.long_shift)
        .with_long_day(self.reminder_cfg.long_day)
        .with_breaks(&self.breaks, self.offer_training, self.planned_break)
        .with_update_ready(self.update.ready())
        .with_presence(self.driver.core().presence())
        .with_away_check(self.driver.core().away_check())
        .with_idle_return(self.driver.core().idle_return())
        .with_auto_clock_out_reason(self.auto_clock_out_reason)
        .with_clock_in_offer(self.clock_in_offer(SystemTime::now()), self.clock_in_prompt)
        .with_not_working_offered(
            self.clock_in_prompt && self.shift_window(SystemTime::now()).is_some(),
        )
        .with_break_over(self.break_over_since)
        .with_blocked(self.blocked.as_ref())
    }

    /// The shift window `now` is in, if the person has a shift (ADR-0031).
    fn shift_window(&self, now: SystemTime) -> Option<crate::shift::ShiftWindow> {
        self.shift
            .shift
            .as_ref()
            .and_then(|s| crate::shift::active_window(s, now))
    }

    /// The sign-in time a clock-in may start from, while clocked out.
    fn clock_in_offer(&self, now: SystemTime) -> Option<SystemTime> {
        if self.driver.state() != CoreState::ClockedOut {
            return None;
        }
        let last_end = self
            .timeline
            .segments()
            .iter()
            .filter_map(|s| s.ended_at)
            .max();
        crate::clock_in_prompt::offer(self.signed_in_at, now, last_end)
    }

    fn tooltip(&self, snapshot: TrayStateSnapshot, now: SystemTime) -> String {
        let elapsed = self
            .timeline
            .session_started_at()
            .map(|s| reminders::short_duration(now.duration_since(s).unwrap_or_default()));
        let tip = format!(
            "{}
Version {}",
            tray::tooltip(snapshot, elapsed.as_deref()),
            APP_VERSION
        );
        match self.update.ready() {
            // Never a surprise (ADR-0022 §2).
            Some(v) => format!(
                "{tip}
Update {v} ready: installs next time you sign in"
            ),
            None => tip,
        }
    }
}

/// Notification text for a reminder (ADR-0013 §2, §4, §5, §7; the
/// break's own name from the policy, ADR-0023).
fn reminder_text(r: &Reminder, breaks: &crate::policy::Breaks) -> (String, String) {
    match r {
        Reminder::NotClockedIn => (
            "Ready to clock in?".into(),
            "You're signed in to CloudPunch but haven't clocked in yet today. Open CloudPunch to start your day.".into(),
        ),
        Reminder::OnTheClock { elapsed } => (
            "You're on the clock".into(),
            format!(
                "{} this session. CloudPunch is running in the system tray.",
                reminders::short_duration(*elapsed)
            ),
        ),
        Reminder::BreakOverCap { kind, elapsed } => (
            "Still on your break?".into(),
            format!(
                "{}: {} min so far. End it in CloudPunch when you're back.",
                breaks.get(*kind).label,
                elapsed.as_secs() / 60
            ),
        ),
        Reminder::StillAway { reason, elapsed } => (
            match reason {
                AwayReason::PhoneCall => "Still on your phone call?",
                AwayReason::WorkingAway => "Still working away from the computer?",
                AwayReason::Meeting => "Still in your meeting?",
                AwayReason::Training => "Still in training?",
            }
            .into(),
            format!(
                "{} so far. Click I'm back in CloudPunch when you return.",
                reminders::short_duration(*elapsed)
            ),
        ),
        Reminder::BackYet { planned } => (
            "Back yet?".into(),
            format!(
                "You planned {} min. End your break in CloudPunch when you're back.",
                planned.as_secs() / 60
            ),
        ),
        Reminder::LongShift { elapsed } => (
            "Still working?".into(),
            format!(
                "You've been clocked in for {}. Open CloudPunch to confirm or clock out.",
                reminders::short_duration(*elapsed)
            ),
        ),
    }
}

pub struct Agent<U: Ui = TauriUi> {
    inner: Mutex<Inner>,
    ui: OnceLock<U>,
    tray_notice: AtomicBool,
    /// Told which policy version the core runs under.
    recorder: Recorder,
}

impl<U: Ui> Agent<U> {
    /// An agent whose events are only logged (tests).
    pub fn new(cfg: CoreConfig) -> Arc<Self> {
        Self::with_recorder(cfg, &Recorder::log_only())
    }

    /// An agent recording signed events through `recorder` (2b.4 F3c).
    pub fn with_recorder(cfg: CoreConfig, recorder: &Recorder) -> Arc<Self> {
        let core = Core::new(cfg, SystemTime::now());
        Arc::new(Self {
            inner: Mutex::new(Inner {
                driver: Driver::new(core, recorder.sink()),
                auto_clocked_out_at: None,
                auto_clock_out_reason: None,
                signed_in_at: None,
                clock_in_prompt: false,
                prompt_state: Default::default(),
                shift: Default::default(),
                shift_snooze_until: None,
                break_over_since: None,
                break_over_alerted_at: None,
                timeline: Timeline::new(),
                reminder_cfg: ReminderConfig::default(),
                reminders: ReminderState::default(),
                nudge: NudgeState::default(),
                long_shift: false,
                tooltip_minute: None,
                pending_policy: None,
                minute_of_day: reminders::local_minute_of_day,
                update: Default::default(),
                started_at: SystemTime::now(),
                breaks: Default::default(),
                offer_training: true,
                planned_break: None,
                blocked: None,
            }),
            ui: OnceLock::new(),
            tray_notice: AtomicBool::new(false),
            recorder: recorder.clone(),
        })
    }

    /// Apply a policy (ADR-0015 §6): reminders and quiet hours now; the
    /// state machine's settings and call-app rules while clocked out —
    /// now, or as soon as the current session ends. `version` is None
    /// for the compiled-in defaults.
    pub fn apply_policy(&self, doc: &PolicyDoc, version: Option<String>) {
        let mut inner = self.lock();
        inner.reminder_cfg = doc.reminder_config();
        // What to offer changes at once; a break in progress keeps going.
        inner.breaks = doc.breaks.clone();
        inner.offer_training = doc.away.offer_training;
        inner.pending_policy = Some(PendingPolicy {
            core: doc.core_config(),
            rules: doc.call_rules(),
            version,
        });
        self.adopt_pending(&mut inner);
    }

    /// Adopt the pending policy if clocked out; otherwise keep waiting.
    fn adopt_pending(&self, inner: &mut Inner) {
        if inner.driver.state() != CoreState::ClockedOut {
            return;
        }
        let Some(p) = inner.pending_policy.take() else {
            return;
        };
        if inner.driver.core_mut().set_config(p.core).is_ok() {
            call_type::set_rules(p.rules);
            self.recorder.set_policy_version(p.version);
        }
    }

    /// Give the agent its UI. Inputs handled before this (e.g. the
    /// watcher's first media reading) still update the core; there is
    /// just no UI to refresh yet.
    pub fn attach(&self, ui: U) {
        let _ = self.ui.set(ui);
    }

    pub fn state(&self) -> CoreState {
        self.lock().driver.state()
    }

    pub fn view(&self) -> StateView {
        self.lock().view()
    }

    /// The updater downloaded and verified `version` (ADR-0022 §2); it
    /// installs at the next safe moment.
    pub fn update_ready(&self, version: String) {
        let (view, snapshot, tooltip) = {
            let mut inner = self.lock();
            inner.update.set_ready(version);
            let snapshot = tray_snapshot(inner.driver.state(), inner.driver.core().call_type());
            let tooltip = inner.tooltip(snapshot, SystemTime::now());
            (inner.view(), snapshot, tooltip)
        };
        // The window's "Restart to update" and the tray say so now.
        if let Some(ui) = self.ui.get() {
            ui.state_changed(&view, snapshot);
            ui.tray_status(snapshot, &tooltip);
        }
    }

    /// Clocked out: a restart the person asks for loses nothing, even
    /// after work today (the day's timeline comes back, ADR-0022).
    pub fn clocked_out(&self) -> bool {
        self.lock().driver.state() == CoreState::ClockedOut
    }

    /// Clocked out with nothing tracked today, so a restart now loses
    /// nothing: checked again just before installing (ADR-0022 §2).
    pub fn safe_to_restart(&self) -> bool {
        let inner = self.lock();
        inner.driver.state() == CoreState::ClockedOut
            && inner
                .timeline
                .current_day_start(SystemTime::now())
                .is_none()
    }

    /// Whether the policy offers this break type now (ADR-0023 §1).
    pub fn break_offered(&self, kind: BreakKind) -> bool {
        self.lock()
            .breaks
            .offered()
            .iter()
            .any(|o| o.id == kind.as_str())
    }

    /// Whether this away tag is offered (Training can be switched off).
    pub fn away_offered(&self, reason: AwayReason) -> bool {
        reason != AwayReason::Training || self.lock().offer_training
    }

    /// Block or allow clocking in here (ADR-0028). Newly blocked, the
    /// clock-in popup closes and, with `show`, the window comes forward
    /// to say why.
    pub fn set_blocked(&self, blocked: Option<BlockedView>, show: bool) {
        let (view, snapshot, changed) = {
            let mut inner = self.lock();
            let changed = inner.blocked != blocked;
            if blocked.is_some() {
                inner.clock_in_prompt = false;
            }
            inner.blocked = blocked;
            let snapshot = tray_snapshot(inner.driver.state(), inner.driver.core().call_type());
            (inner.view(), snapshot, changed)
        };
        if !changed {
            return;
        }
        if let Some(ui) = self.ui.get() {
            if show && view.blocked_elsewhere.is_some() {
                ui.show_main();
            }
            ui.state_changed(&view, snapshot);
        }
    }

    /// Whether clocking in is blocked here (ADR-0028).
    pub fn is_blocked(&self) -> bool {
        self.lock().blocked.is_some()
    }

    /// Back to clocked out **without** recording a clock-out (ADR-0028):
    /// the server refused this session or already closed it. With
    /// `only`, only if that is the session being recorded. Returns
    /// whether a session was left.
    pub fn abandon_session(&self, only: Option<&str>) -> bool {
        let now = SystemTime::now();
        let (view, plan, snapshot) = {
            let mut inner = self.lock();
            if inner.driver.state() == CoreState::ClockedOut {
                return false;
            }
            if let Some(id) = only {
                if inner.driver.sink().session_id() != Some(id) {
                    return false;
                }
            }
            let effects = inner.driver.abandon_session();
            inner.timeline.record(CoreState::ClockedOut, None, now);
            self.recorder.save_day(&inner.timeline.to_json());
            inner.long_shift = false;
            inner.planned_break = None;
            self.adopt_pending(&mut inner);
            let snapshot = tray_snapshot(inner.driver.state(), inner.driver.core().call_type());
            let plan = UiPlan {
                broadcast: true,
                hide_prompt: effects.contains(&Effect::HidePrompt),
                show_main: true,
                tray: true,
                tooltip: inner.tooltip(snapshot, now),
                ..UiPlan::default()
            };
            (inner.view(), plan, snapshot)
        };
        self.apply(&view, &plan, snapshot);
        true
    }

    /// The person signed in to, unlocked or woke the computer at `at`.
    pub fn note_signed_in(&self, at: SystemTime) {
        let mut inner = self.lock();
        if inner.signed_in_at.map_or(true, |prev| at > prev) {
            inner.signed_in_at = Some(at);
        }
    }

    /// Close the daily clock-in popup without clocking in. With a shift
    /// it comes back after [`crate::shift::SNOOZE`] (ADR-0031 §2).
    pub fn dismiss_clock_in_prompt(&self) -> StateView {
        let view = {
            let mut inner = self.lock();
            inner.clock_in_prompt = false;
            inner.shift_snooze_until = Some(SystemTime::now() + crate::shift::SNOOZE);
            inner.view()
        };
        if let Some(ui) = self.ui.get() {
            ui.state_changed(&view, tray_snapshot(self.state(), None));
        }
        view
    }

    /// The shift fetched with the policy (ADR-0031). Takes effect at the
    /// next tick; "Not working today" for the shift showing closes it.
    pub fn apply_shift(&self, info: crate::shift::ShiftInfo) {
        let changed = {
            let mut inner = self.lock();
            if inner.shift == info {
                return;
            }
            inner.shift = info;
            let now = SystemTime::now();
            let silenced = inner
                .shift_window(now)
                .is_some_and(|w| inner.shift.not_working_on == Some(w.date));
            if silenced && inner.clock_in_prompt {
                inner.clock_in_prompt = false;
                true
            } else {
                false
            }
        };
        if changed {
            self.broadcast();
        }
    }

    /// "Not working today", recorded on the server for shift `date`:
    /// no more asking until the next shift (ADR-0031 §2).
    pub fn mark_not_working(&self, date: chrono::NaiveDate) -> StateView {
        {
            let mut inner = self.lock();
            inner.shift.not_working_on = Some(date);
            inner.clock_in_prompt = false;
        }
        self.broadcast();
        self.view()
    }

    fn broadcast(&self) {
        let view = self.view();
        if let Some(ui) = self.ui.get() {
            ui.state_changed(&view, tray_snapshot(self.state(), None));
        }
    }

    /// "5 more min" / "10 more min" on a break that ran over (ADR-0031
    /// §3): recorded, the plan grows, and the alert starts over.
    pub fn extend_break(&self, minutes: u8) -> Result<StateView, Rejected> {
        if !matches!(minutes, 5 | 10) {
            return Err(Rejected::InvalidTransition);
        }
        if self.lock().planned_break.is_none() {
            return Err(Rejected::InvalidTransition);
        }
        self.handle(Input::ExtendBreak { minutes })?;
        {
            let mut inner = self.lock();
            inner.planned_break = inner.planned_break.map(|m| m.saturating_add(minutes));
            inner.break_over_since = None;
            inner.break_over_alerted_at = None;
        }
        self.broadcast();
        Ok(self.view())
    }

    /// Clock in from the sign-in time, if it is still on offer.
    pub fn clock_in_from_sign_in(&self) -> Result<StateView, Rejected> {
        let offer = self
            .lock()
            .clock_in_offer(SystemTime::now())
            .ok_or(Rejected::StartOutOfRange)?;
        self.handle(Input::ClockInFrom(offer))
    }

    pub fn handle(&self, input: Input) -> Result<StateView, Rejected> {
        self.handle_at(input, SystemTime::now())
    }

    fn handle_at(&self, input: Input, now: SystemTime) -> Result<StateView, Rejected> {
        let is_tick = matches!(input, Input::Tick { .. });
        let last_input_at = match &input {
            Input::Tick { last_input_at } => Some(*last_input_at),
            _ => None,
        };
        let is_clock_in = matches!(input, Input::ClockIn | Input::ClockInFrom(_));
        // A clock-in from the sign-in time starts the day's timeline there.
        let started_from = match input {
            Input::ClockInFrom(at) => Some(at),
            _ => None,
        };
        // A break's "Back in?" answer (ADR-0023 §2).
        let planned_in = match input {
            Input::StartBreak {
                planned_minutes, ..
            } => Some(planned_minutes),
            _ => None,
        };
        let visible = self.ui.get().is_some_and(|u| u.main_visible());

        let (view, plan, snapshot) = {
            let mut inner = self.lock();
            // Clocked in on another computer (ADR-0028): the tray and
            // the popup land here too, not only the window's button.
            if is_clock_in && inner.blocked.is_some() {
                return Err(Rejected::ClockedInElsewhere);
            }
            let before = inner.driver.state();
            let call_before = inner.driver.core().call_type();
            let outcome = inner.driver.handle(input, now)?;
            let after = inner.driver.state();
            match (after, planned_in) {
                (CoreState::OnBreak { .. }, Some(p)) => inner.planned_break = p,
                (CoreState::OnBreak { .. }, None) => {}
                _ => inner.planned_break = None,
            }
            // A policy that arrived mid-session takes over once it ends.
            if after == CoreState::ClockedOut && before != CoreState::ClockedOut {
                // A clock-out mid-shift: ask again in a while, not at once.
                inner.shift_snooze_until = Some(now + crate::shift::SNOOZE);
                self.adopt_pending(&mut inner);
            }
            let call_after = inner.driver.core().call_type();
            if after != before || call_after != call_before {
                // Record at the event's own time: idle starts at the last
                // input, and the idle cap is dated when it was reached,
                // even if the laptop slept past it (ADR-0018).
                let at = match after {
                    CoreState::Idle { since } => since,
                    _ if started_from.is_some() && before == CoreState::ClockedOut => {
                        started_from.unwrap_or(now)
                    }
                    _ => outcome.last_emit_at.unwrap_or(now),
                };
                inner.timeline.record(after, call_after, at);
                // Journal the day so a restart keeps it on screen.
                self.recorder.save_day(&inner.timeline.to_json());
            }

            if let Some(err) = &outcome.sink_error {
                eprintln!("[cloudpunch] {err}; {} event(s) waiting", outcome.backlog);
            }

            let mut plan = UiPlan {
                broadcast: !outcome.effects.is_empty(),
                ..UiPlan::default()
            };
            for effect in &outcome.effects {
                match effect {
                    Effect::ShowPrompt { .. } => plan.show_prompt = true,
                    Effect::HidePrompt => plan.hide_prompt = true,
                    // Back from idle: bring the window up to ask.
                    Effect::IdleReturned(_) => {
                        plan.show_main = true;
                        plan.broadcast = true;
                    }
                    // "Welcome back?" while Away (ADR-0027).
                    Effect::AwayCheckOpened(_) => {
                        plan.show_main = true;
                        plan.broadcast = true;
                    }
                    Effect::AwayCheckClosed => plan.broadcast = true,
                    _ => {}
                }
            }
            // Only the idle cap (or, before ADR-0018, the grace
            // timeout) clocks out from a tick.
            if is_tick && after == CoreState::ClockedOut {
                if let CoreState::Idle { since } = before {
                    let cap = inner.driver.core().config().max_idle.unwrap_or_default();
                    inner.auto_clocked_out_at = Some(since + cap);
                    inner.auto_clock_out_reason = Some("idle_cap");
                    plan.show_main = true;
                } else if matches!(before, CoreState::IdlePending { .. }) {
                    inner.auto_clocked_out_at = Some(now);
                    inner.auto_clock_out_reason = Some("prompt");
                    plan.show_main = true;
                }
            }
            if is_clock_in {
                inner.auto_clocked_out_at = None;
                inner.auto_clock_out_reason = None;
                inner.clock_in_prompt = false;
            }
            if after == CoreState::ClockedOut {
                inner.long_shift = false;
            }
            if !matches!(after, CoreState::OnBreak { .. }) && inner.break_over_since.is_some() {
                inner.break_over_since = None;
                inner.break_over_alerted_at = None;
                plan.broadcast = true;
            }
            if is_tick {
                let inputs = ReminderInputs {
                    now,
                    state: after,
                    session_started_at: inner.timeline.session_started_at(),
                    segment_started_at: inner.timeline.open_segment_started_at(),
                    planned_break: match after {
                        CoreState::OnBreak { .. } => inner
                            .planned_break
                            .map(|m| Duration::from_secs(u64::from(m) * 60)),
                        _ => None,
                    },
                    window_visible: visible,
                    minute_of_day: (inner.minute_of_day)(),
                };
                let cfg = inner.reminder_cfg.clone();
                if let Some(last_input_at) = last_input_at {
                    // The daily clock-in popup (ADR-0018 §4).
                    // Nothing to offer while blocked (ADR-0028).
                    let ready = self.recorder.is_armed() && inner.blocked.is_none();
                    let prompt = crate::clock_in_prompt::PromptInputs {
                        now,
                        ready,
                        clocked_out: after == CoreState::ClockedOut,
                        worked_today: inner.timeline.current_day_start(now).is_some(),
                        last_input_at,
                    };
                    let prompt_cfg = cfg.clock_in_prompt;
                    if inner.shift.shift.is_some() {
                        // A shift decides (ADR-0031 §2): ask during it,
                        // again after "Not now"; stop when it ends.
                        let window = inner.shift_window(now);
                        if window.is_none() && inner.clock_in_prompt {
                            inner.clock_in_prompt = false;
                            plan.broadcast = true;
                        }
                        let due = crate::clock_in_prompt::shift_due(
                            window,
                            inner.shift.not_working_on,
                            inner.shift_snooze_until,
                            prompt,
                        );
                        if due && !inner.clock_in_prompt {
                            inner.clock_in_prompt = true;
                            plan.show_main = true;
                            plan.broadcast = true;
                        }
                    } else if crate::clock_in_prompt::due(
                        &prompt_cfg,
                        prompt,
                        &mut inner.prompt_state,
                    ) {
                        inner.clock_in_prompt = true;
                        plan.show_main = true;
                        plan.broadcast = true;
                    }
                    let nudge = NudgeInputs {
                        now,
                        ready,
                        clocked_out: after == CoreState::ClockedOut,
                        // The current working day, not the date (ADR-0016 §1).
                        worked_today: inner.timeline.current_day_start(now).is_some(),
                        last_input_at,
                        window_visible: visible,
                        minute_of_day: (inner.minute_of_day)(),
                    };
                    if let Some(r) = reminders::clock_in_nudge(&cfg, nudge, &mut inner.nudge) {
                        plan.notes.push(reminder_text(&r, &inner.breaks));
                    }
                }
                let update = crate::app_update::UpdateInputs {
                    now,
                    clocked_out: after == CoreState::ClockedOut,
                    worked_today: inner.timeline.current_day_start(now).is_some(),
                    signed_in_at: inner.signed_in_at,
                    started_at: inner.started_at,
                };
                plan.update_note = crate::app_update::wait_note(&mut inner.update, update);
                plan.install_update = crate::app_update::install_now(&mut inner.update, update);
                for r in reminders::due(&cfg, inputs, &mut inner.reminders) {
                    // The overrun alert below says it, louder.
                    if matches!(r, Reminder::BackYet { .. }) {
                        continue;
                    }
                    if matches!(r, Reminder::LongShift { .. }) {
                        inner.long_shift = true;
                        plan.show_main = true;
                        plan.broadcast = true;
                    }
                    plan.notes.push(reminder_text(&r, &inner.breaks));
                }
                // ADR-0031 §3: a planned break past its end. The window
                // comes forward, the taskbar flashes and a notification
                // goes off, again every BREAK_OVER_REPEAT; not muted in
                // quiet hours (someone on a break is clocked in).
                let ends = match (after, inner.planned_break, inputs.segment_started_at) {
                    (CoreState::OnBreak { .. }, Some(m), Some(start)) => {
                        Some((start + Duration::from_secs(u64::from(m) * 60), m))
                    }
                    _ => None,
                };
                if let Some((end, planned)) = ends.filter(|(end, _)| now >= *end) {
                    if inner.break_over_since.is_none() {
                        inner.break_over_since = Some(end);
                        plan.broadcast = true;
                    }
                    let again = inner.break_over_alerted_at.map_or(true, |at| {
                        now.duration_since(at).unwrap_or_default() >= BREAK_OVER_REPEAT
                    });
                    if again {
                        inner.break_over_alerted_at = Some(now);
                        plan.show_main = true;
                        plan.attention = true;
                        plan.notes.push((
                            "Your break is over".to_string(),
                            format!(
                                "You planned {}. Back now, or a few more minutes?",
                                reminders::short_duration(Duration::from_secs(
                                    u64::from(planned) * 60
                                ))
                            ),
                        ));
                    }
                }
                let minute = epoch_ms(now) / 60_000;
                if inner.tooltip_minute != Some(minute) {
                    inner.tooltip_minute = Some(minute);
                    plan.tray = true;
                }
            }
            let snapshot = if inner.break_over_since.is_some() {
                TrayStateSnapshot::BreakOver
            } else {
                tray_snapshot(after, call_after)
            };
            plan.tray |= plan.broadcast;
            plan.tooltip = inner.tooltip(snapshot, now);
            (inner.view(), plan, snapshot)
        };

        self.apply(&view, &plan, snapshot);
        Ok(view)
    }

    fn apply(&self, view: &StateView, plan: &UiPlan, snapshot: TrayStateSnapshot) {
        let Some(ui) = self.ui.get() else {
            return;
        };
        if plan.hide_prompt {
            ui.hide_prompt();
        }
        if plan.show_prompt {
            ui.show_prompt();
        }
        if plan.show_main {
            ui.show_main();
        }
        if plan.attention {
            ui.request_attention();
        }
        if plan.broadcast {
            ui.state_changed(view, snapshot);
        }
        if plan.tray {
            ui.tray_status(snapshot, &plan.tooltip);
        }
        for (title, body) in &plan.notes {
            ui.notify(title, body);
        }
        if let Some(line) = &plan.update_note {
            ui.log_update(line);
        }
        if let Some(version) = &plan.install_update {
            ui.install_update(version);
        }
    }

    /// Put back today's timeline from the journal after a restart. If
    /// they already clocked in (the popup can beat the restore after an
    /// update), the history goes in ahead of that session instead of
    /// being skipped. A segment a crash left open closes at the
    /// recovered session's last heartbeat.
    pub fn restore_today(&self) {
        let Some(json) = self.recorder.load_today() else {
            return;
        };
        let close_at = self
            .recorder
            .take_recovered_heartbeat()
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let (view, snapshot) = {
            let mut inner = self.lock();
            if !inner.timeline.restore(&json, close_at) {
                return;
            }
            // Only the current working day comes back.
            inner.timeline.prune(SystemTime::now());
            self.recorder.save_day(&inner.timeline.to_json());
            let snapshot = tray_snapshot(inner.driver.state(), inner.driver.core().call_type());
            (inner.view(), snapshot)
        };
        eprintln!("[cloudpunch] today's timeline restored");
        if let Some(ui) = self.ui.get() {
            ui.state_changed(&view, snapshot);
        }
    }

    /// Whether the day's earlier history may be missing: nothing on
    /// screen, or only the session running now.
    pub fn lacks_history(&self) -> bool {
        self.lock().timeline.lacks_history()
    }

    /// Put back today's timeline from the server's day views (after
    /// signing in again, the journal is gone), only the current working
    /// day. If they already clocked in, the history goes in ahead of
    /// that session. The result is journaled, so a restart keeps it.
    /// Returns whether anything was restored.
    pub fn restore_today_from_server(&self, json: &str) -> bool {
        let (view, snapshot) = {
            let mut inner = self.lock();
            if !inner.timeline.restore(json, SystemTime::now()) {
                return false;
            }
            inner.timeline.prune(SystemTime::now());
            self.recorder.save_day(&inner.timeline.to_json());
            let snapshot = tray_snapshot(inner.driver.state(), inner.driver.core().call_type());
            (inner.view(), snapshot)
        };
        eprintln!("[cloudpunch] today's timeline restored from the server");
        if let Some(ui) = self.ui.get() {
            ui.state_changed(&view, snapshot);
        }
        true
    }

    /// Forget the day on screen (sign-out: the next user starts clean).
    pub fn clear_timeline(&self) {
        let (view, snapshot) = {
            let mut inner = self.lock();
            inner.timeline.clear();
            let snapshot = tray_snapshot(inner.driver.state(), inner.driver.core().call_type());
            (inner.view(), snapshot)
        };
        if let Some(ui) = self.ui.get() {
            ui.state_changed(&view, snapshot);
        }
    }

    /// "Still working" on the long-shift banner (ADR-0013 §5).
    pub fn ack_long_shift(&self) -> StateView {
        let now = SystemTime::now();
        let (view, snapshot) = {
            let mut inner = self.lock();
            inner.long_shift = false;
            let cfg = inner.reminder_cfg.clone();
            inner.reminders.ack_long_shift(now, &cfg);
            let snapshot = tray_snapshot(inner.driver.state(), inner.driver.core().call_type());
            (inner.view(), snapshot)
        };
        if let Some(ui) = self.ui.get() {
            ui.state_changed(&view, snapshot);
        }
        view
    }

    /// First time this run the window goes to the tray, say so once
    /// (ADR-0013 §1). Returns whether the notice was shown.
    pub fn notice_hidden_to_tray(&self) -> bool {
        if self.tray_notice.swap(true, Ordering::AcqRel) {
            return false;
        }
        if let Some(ui) = self.ui.get() {
            ui.notify(
                "CloudPunch is still running",
                "It keeps tracking your time from the system tray. Open it from the tray icon.",
            );
        }
        true
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panic while holding the lock would leave the core in a
        // state we can't trust; recovering the guard keeps the agent
        // usable, and every transition is still server-validated.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Start the 1 Hz tick thread. Dropping the guard stops it.
    pub fn start_ticker(self: &Arc<Self>) -> TickerGuard {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_t = stop.clone();
        let agent = self.clone();
        let thread = thread::Builder::new()
            .name("cp-core-tick".into())
            .spawn(move || {
                while !stop_t.load(Ordering::Acquire) {
                    let _ = agent.handle(Input::Tick {
                        last_input_at: last_input_at(),
                    });
                    thread::sleep(Duration::from_secs(1));
                }
            })
            .expect("failed to spawn cp-core-tick thread");
        TickerGuard {
            stop,
            thread: Some(thread),
        }
    }
}

pub struct TickerGuard {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Drop for TickerGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Wall-clock time of the last keyboard/pointer input.
#[cfg(target_os = "windows")]
fn last_input_at() -> SystemTime {
    use crate::watchers::idle::{LastInputSource, WindowsLastInput};
    let ms = WindowsLastInput.ms_since_last_input();
    let now = SystemTime::now();
    now.checked_sub(Duration::from_millis(u64::from(ms)))
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// macOS: CoreGraphics' seconds since the last input (ADR-0026 §2).
#[cfg(target_os = "macos")]
fn last_input_at() -> SystemTime {
    crate::macos::last_input_at()
}

/// No input source on other platforms: report "input just now", so the
/// idle prompt never fires there.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn last_input_at() -> SystemTime {
    SystemTime::now()
}

fn open_prompt_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PROMPT_WINDOW) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, PROMPT_WINDOW, WebviewUrl::App("index.html".into()))
        .title("CloudPunch — are you still there?")
        .inner_size(420.0, 520.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .always_on_top(true)
        .focused(true)
        .center()
        .build();
    if let Err(e) = built {
        eprintln!("[cloudpunch] could not open idle prompt window: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine::IdleExplanation;
    use crate::machine::PromptResponse;

    fn t(ms: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_millis(ms)
    }

    #[test]
    fn view_of_each_state() {
        let cfg = CoreConfig::default();
        let v = view_of(CoreState::ClockedOut, &cfg, None);
        assert_eq!(v.status, "clocked_out");
        assert_eq!(v.prompt_deadline, None);

        let v = view_of(
            CoreState::IdlePending {
                shown_at: t(1_000),
                deadline: t(31_000),
                idle_since: t(0),
            },
            &cfg,
            None,
        );
        assert_eq!(v.status, "idle_pending");
        assert_eq!(v.prompt_deadline, Some(31_000));

        let v = view_of(
            CoreState::OnBreak {
                kind: BreakKind::Meal,
            },
            &cfg,
            None,
        );
        assert_eq!((v.status, v.break_kind), ("on_break", Some("meal")));

        let v = view_of(
            CoreState::Away {
                reason: AwayReason::WorkingAway,
            },
            &cfg,
            None,
        );
        assert_eq!((v.status, v.away_reason), ("away", Some("working_away")));

        assert_eq!(view_of(CoreState::OnCall, &cfg, None).status, "on_call");
        assert_eq!(view_of(CoreState::Active, &cfg, None).status, "active");
    }

    #[test]
    fn view_carries_policy_options_and_auto_clock_out() {
        let cfg = CoreConfig::default();
        let v = view_of(CoreState::ClockedOut, &cfg, Some(t(5_000)));
        assert_eq!(v.prompt_options.len(), PromptResponse::ALL.len());
        assert_eq!(v.note_required_for, ["working_away"]);
        assert_eq!(v.auto_clocked_out_at, Some(5_000));
    }

    #[test]
    fn view_serialises_camel_case_with_nulls() {
        let v = view_of(CoreState::Active, &CoreConfig::default(), None);
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["status"], "active");
        assert!(json["promptDeadline"].is_null());
        assert!(json["autoClockedOutAt"].is_null());
        assert!(json.get("prompt_deadline").is_none());
    }

    #[test]
    fn tray_snapshot_mapping() {
        assert_eq!(
            tray_snapshot(CoreState::ClockedOut, None),
            TrayStateSnapshot::NotClockedIn
        );
        assert_eq!(
            tray_snapshot(CoreState::Active, None),
            TrayStateSnapshot::ClockedIn
        );
        let bio = CoreState::OnBreak {
            kind: BreakKind::Bio,
        };
        assert_eq!(tray_snapshot(bio, None), TrayStateSnapshot::OnBreak);
        let phone_away = CoreState::Away {
            reason: AwayReason::PhoneCall,
        };
        assert_eq!(
            tray_snapshot(phone_away, None),
            TrayStateSnapshot::Away(AwayReason::PhoneCall)
        );
        assert_eq!(
            tray_snapshot(CoreState::OnCall, Some(CallType::Teams)),
            TrayStateSnapshot::OnCall(CallType::Teams)
        );
        assert_eq!(
            tray_snapshot(CoreState::OnCall, None),
            TrayStateSnapshot::OnCall(CallType::Other)
        );
        assert_eq!(parse_away_tag("meeting"), Some(AwayReason::Meeting));
        assert_eq!(parse_away_tag("working_away"), None);
        assert_eq!(parse_away_tag("phone_call"), None);
    }

    #[test]
    fn parse_and_rejection_codes() {
        assert_eq!(parse_break_kind("bio"), Some(BreakKind::Bio));
        assert_eq!(parse_break_kind("nap"), None);
        assert_eq!(rejection_code(&Rejected::NoteRequired), "note_required");
    }

    /// Records UI calls as short strings. Tray status refreshes aren't
    /// recorded (they follow every broadcast); `visible` fakes the main
    /// window being open.
    #[derive(Default)]
    struct FakeUi {
        calls: Mutex<Vec<String>>,
        visible: AtomicBool,
    }

    impl Ui for Arc<FakeUi> {
        fn show_prompt(&self) {
            self.calls.lock().unwrap().push("show_prompt".into());
        }
        fn request_attention(&self) {
            self.calls.lock().unwrap().push("attention".into());
        }
        fn hide_prompt(&self) {
            self.calls.lock().unwrap().push("hide_prompt".into());
        }
        fn show_main(&self) {
            self.calls.lock().unwrap().push("show_main".into());
        }
        fn state_changed(&self, view: &StateView, tray: TrayStateSnapshot) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("state:{}:{tray:?}", view.status));
        }
        fn main_visible(&self) -> bool {
            self.visible.load(Ordering::Acquire)
        }
        fn notify(&self, title: &str, _body: &str) {
            self.calls.lock().unwrap().push(format!("notify:{title}"));
        }
        fn tray_status(&self, _tray: TrayStateSnapshot, _tooltip: &str) {}
        fn install_update(&self, version: &str) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("install_update:{version}"));
        }
    }

    fn notes(ui: &FakeUi) -> Vec<String> {
        ui.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.starts_with("notify:"))
            .cloned()
            .collect()
    }

    #[test]
    fn on_the_clock_reminder_every_30_minutes_while_hidden() {
        let (agent, ui) = agent_with_ui();
        let base = SystemTime::now();
        agent.handle_at(Input::ClockIn, base).unwrap();
        // Recent input keeps the idle prompt away; 30 minutes pass.
        let tick = |secs: u64| {
            let now = base + Duration::from_secs(secs);
            agent
                .handle_at(Input::Tick { last_input_at: now }, now)
                .unwrap()
        };
        tick(29 * 60);
        assert!(notes(&ui).is_empty());
        tick(30 * 60);
        assert_eq!(notes(&ui), ["notify:You're on the clock"]);
        ui.visible.store(true, Ordering::Release);
        tick(61 * 60);
        assert_eq!(notes(&ui).len(), 1, "not while the window is open");
    }

    #[test]
    fn a_ready_update_installs_at_sign_in_only_while_clocked_out_with_nothing_today() {
        let installs = |ui: &FakeUi| {
            ui.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.starts_with("install_update:"))
                .cloned()
                .collect::<Vec<_>>()
        };
        let now = SystemTime::now();
        let tick = |agent: &Agent<Arc<FakeUi>>| {
            agent
                .handle_at(Input::Tick { last_input_at: now }, now)
                .unwrap();
        };

        // Clocked in: the update waits, and a restart isn't safe.
        let (agent, ui) = agent_with_ui();
        agent.handle(Input::ClockIn).unwrap();
        agent.update_ready("9.9.9".into());
        agent.note_signed_in(now);
        tick(&agent);
        assert!(installs(&ui).is_empty());
        assert!(!agent.safe_to_restart());

        // Morning: clocked out, nothing today, just signed in.
        let (agent, ui) = agent_with_ui();
        agent.update_ready("9.9.9".into());
        agent.note_signed_in(now);
        assert!(agent.safe_to_restart());
        tick(&agent);
        tick(&agent);
        assert_eq!(installs(&ui), ["install_update:9.9.9"], "once");
    }

    #[test]
    fn long_shift_raises_the_banner_and_still_working_clears_it() {
        let (agent, ui) = agent_with_ui();
        let base = SystemTime::now() - Duration::from_secs(10 * 3600);
        agent.handle_at(Input::ClockIn, base).unwrap();
        let now = base + Duration::from_secs(9 * 3600);
        let view = agent
            .handle_at(Input::Tick { last_input_at: now }, now)
            .unwrap();
        assert!(view.long_shift);
        assert!(ui.calls.lock().unwrap().contains(&"show_main".to_string()));
        assert!(notes(&ui).contains(&"notify:Still working?".to_string()));
        assert!(!agent.ack_long_shift().long_shift);
    }

    #[test]
    fn clocking_out_clears_the_long_shift_banner() {
        let (agent, _ui) = agent_with_ui();
        let base = SystemTime::now() - Duration::from_secs(10 * 3600);
        agent.handle_at(Input::ClockIn, base).unwrap();
        let now = base + Duration::from_secs(9 * 3600);
        agent
            .handle_at(Input::Tick { last_input_at: now }, now)
            .unwrap();
        assert!(!agent.handle(Input::ClockOut).unwrap().long_shift);
    }

    #[test]
    fn a_break_past_its_plan_alerts_loudly_and_repeats_until_extended_or_ended() {
        let (agent, ui) = agent_with_ui();
        let base = SystemTime::now() - Duration::from_secs(3600);
        let at = |m: u64| base + Duration::from_secs(m * 60);
        agent.handle_at(Input::ClockIn, base).unwrap();
        agent
            .handle_at(
                Input::StartBreak {
                    kind: BreakKind::Rest,
                    planned_minutes: Some(5),
                },
                at(1),
            )
            .unwrap();
        let tick = |t: SystemTime| {
            agent
                .handle_at(Input::Tick { last_input_at: t }, t)
                .unwrap()
        };
        let alerts = |ui: &FakeUi| {
            ui.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| *c == "attention")
                .count()
        };
        // Planned 5 min from minute 1: quiet until minute 6.
        assert_eq!(tick(at(5)).break_over_since, None);
        assert_eq!(alerts(&ui), 0);
        let view = tick(at(6));
        assert_eq!(view.break_over_since, Some(epoch_ms(at(6))));
        assert_eq!(alerts(&ui), 1);
        assert!(notes(&ui).contains(&"notify:Your break is over".to_string()));
        assert!(ui.calls.lock().unwrap().contains(&"show_main".to_string()));
        // Again two minutes later, not before.
        tick(at(7));
        assert_eq!(alerts(&ui), 1);
        tick(at(8));
        assert_eq!(alerts(&ui), 2);

        // "5 more min": recorded, the alert stops, the plan is 10 min.
        let view = agent.extend_break(5).unwrap();
        assert_eq!(view.break_over_since, None);
        assert_eq!(view.planned_break_minutes, Some(10));
        assert_eq!(view.status, "on_break");
        assert!(agent.extend_break(7).is_err());

        // Ending the break clears everything.
        let view = agent.handle(Input::EndBreak).unwrap();
        assert_eq!(view.break_over_since, None);
        assert!(agent.extend_break(5).is_err());
    }

    #[test]
    fn tray_notice_only_once_per_run() {
        let (agent, ui) = agent_with_ui();
        assert!(agent.notice_hidden_to_tray());
        assert!(!agent.notice_hidden_to_tray());
        assert_eq!(notes(&ui), ["notify:CloudPunch is still running"]);
    }

    fn agent_with_ui() -> (Arc<Agent<Arc<FakeUi>>>, Arc<FakeUi>) {
        let agent = Agent::<Arc<FakeUi>>::new(CoreConfig::default());
        // Noon, outside quiet hours whenever the tests run.
        agent.lock().minute_of_day = || 12 * 60;
        let ui = Arc::new(FakeUi::default());
        agent.attach(ui.clone());
        (agent, ui)
    }

    #[test]
    fn state_changes_broadcast_view_and_tray() {
        let (agent, ui) = agent_with_ui();
        agent.handle(Input::ClockIn).unwrap();
        agent
            .handle(Input::StartBreak {
                kind: BreakKind::Bio,
                planned_minutes: None,
            })
            .unwrap();
        assert_eq!(
            *ui.calls.lock().unwrap(),
            ["state:active:ClockedIn", "state:on_break:OnBreak"]
        );
    }

    #[test]
    fn rejected_input_touches_no_ui() {
        let (agent, ui) = agent_with_ui();
        assert!(agent.handle(Input::EndBreak).is_err());
        assert!(ui.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn quiet_tick_touches_no_ui() {
        let (agent, ui) = agent_with_ui();
        agent.handle(Input::ClockIn).unwrap();
        ui.calls.lock().unwrap().clear();
        agent
            .handle(Input::Tick {
                last_input_at: SystemTime::now(),
            })
            .unwrap();
        assert!(ui.calls.lock().unwrap().is_empty());
    }

    fn tick_at(agent: &Agent<Arc<FakeUi>>, base: SystemTime, secs: u64) -> StateView {
        agent
            .handle_at(
                Input::Tick {
                    last_input_at: base,
                },
                base + Duration::from_secs(secs),
            )
            .unwrap()
    }

    #[test]
    fn unanswered_prompt_logs_idle_then_welcome_back_shows_main() {
        // ADR-0018: no clock-out on timeout; idle from the last input.
        let (agent, ui) = agent_with_ui();
        let base = SystemTime::now();
        agent.handle_at(Input::ClockIn, base).unwrap();
        ui.calls.lock().unwrap().clear();

        let view = tick_at(&agent, base, 300);
        assert_eq!(view.status, "idle_pending");
        assert_eq!(
            *ui.calls.lock().unwrap(),
            ["show_prompt", "state:idle_pending:ClockedIn"]
        );
        ui.calls.lock().unwrap().clear();

        let view = tick_at(&agent, base, 330);
        assert_eq!(view.status, "idle");
        assert_eq!(view.idle_since, Some(epoch_ms(base)));
        assert_eq!(view.auto_clocked_out_at, None);
        assert_eq!(
            *ui.calls.lock().unwrap(),
            ["hide_prompt", "state:idle:ClockedIn"]
        );
        // The timeline shows idle from the clock-in (the last input).
        let kinds: Vec<_> = view.timeline.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, ["idle"]);
        ui.calls.lock().unwrap().clear();

        // Input returns: working again, and the window asks.
        let back = base + Duration::from_secs(900);
        let view = agent
            .handle_at(
                Input::Tick {
                    last_input_at: back,
                },
                back,
            )
            .unwrap();
        assert_eq!(view.status, "active");
        let ret = view.idle_return.expect("asks what happened");
        assert_eq!((ret.since, ret.until), (epoch_ms(base), epoch_ms(back)));
        assert!(ui.calls.lock().unwrap().contains(&"show_main".to_string()));
        let kinds: Vec<_> = view.timeline.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, ["idle", "working"]);

        let view = agent
            .handle_at(
                Input::ExplainIdle {
                    explanation: IdleExplanation::Meeting,
                    note: None,
                },
                back,
            )
            .unwrap();
        assert!(view.idle_return.is_none());
    }

    #[test]
    fn a_sign_in_is_offered_and_starts_the_timeline_there() {
        let agent = Agent::<Arc<FakeUi>>::new(CoreConfig::default());
        let now = SystemTime::now();
        assert_eq!(agent.view().signed_in_at, None);
        let signed_in = now - Duration::from_secs(25 * 60);
        agent.note_signed_in(signed_in - Duration::from_secs(3600));
        agent.note_signed_in(signed_in);
        // An older one never replaces a newer one.
        agent.note_signed_in(signed_in - Duration::from_secs(7200));
        assert_eq!(agent.view().signed_in_at, Some(epoch_ms(signed_in)));

        let view = agent.handle(Input::ClockInFrom(signed_in)).unwrap();
        assert_eq!(view.status, "active");
        assert_eq!(view.session_started_at, Some(epoch_ms(signed_in)));
        assert_eq!(view.timeline[0].started_at, epoch_ms(signed_in));
        // Clocked in: nothing on offer.
        assert_eq!(view.signed_in_at, None);

        // After this session ends, that sign-in is used up.
        let view = agent.handle(Input::ClockOut).unwrap();
        assert_eq!(view.signed_in_at, None);
    }

    #[test]
    fn the_idle_cap_clocks_out_at_the_cap_and_says_why() {
        let (agent, _ui) = agent_with_ui();
        let base = SystemTime::now();
        agent.handle_at(Input::ClockIn, base).unwrap();
        tick_at(&agent, base, 300);
        tick_at(&agent, base, 330);
        // Asleep well past the 2-hour cap.
        let view = tick_at(&agent, base, 20_000);
        assert_eq!(view.status, "clocked_out");
        assert_eq!(view.auto_clock_out_reason, Some("idle_cap"));
        assert_eq!(
            view.auto_clocked_out_at,
            Some(epoch_ms(base + Duration::from_secs(7_200)))
        );
        // The idle segment ends at the cap, not at wake-up.
        let last = view.timeline.last().unwrap();
        assert_eq!(last.kind, "idle");
        assert_eq!(
            last.ended_at,
            Some(epoch_ms(base + Duration::from_secs(7_200)))
        );
    }

    #[test]
    fn answering_the_prompt_hides_it_without_showing_main() {
        let (agent, ui) = agent_with_ui();
        let base = SystemTime::now();
        agent.handle_at(Input::ClockIn, base).unwrap();
        tick_at(&agent, base, 300);
        ui.calls.lock().unwrap().clear();

        let view = agent
            .handle_at(
                Input::RespondToPrompt {
                    response: PromptResponse::EndShift,
                    note: None,
                },
                base + Duration::from_secs(310),
            )
            .unwrap();
        assert_eq!(view.status, "clocked_out");
        assert_eq!(view.auto_clocked_out_at, None);
        assert_eq!(
            *ui.calls.lock().unwrap(),
            ["hide_prompt", "state:clocked_out:NotClockedIn"]
        );
    }

    #[test]
    fn agent_without_ui_still_runs_the_core() {
        let agent = Agent::<Arc<FakeUi>>::new(CoreConfig::default());
        assert_eq!(agent.view().status, "clocked_out");
        assert_eq!(agent.handle(Input::ClockIn).unwrap().status, "active");
        assert_eq!(
            agent.handle(Input::ClockIn),
            Err(Rejected::InvalidTransition)
        );
        assert_eq!(agent.handle(Input::ClockOut).unwrap().status, "clocked_out");
    }

    #[test]
    fn view_carries_session_start_and_timeline() {
        let (agent, _ui) = agent_with_ui();
        let base = SystemTime::now();
        agent.handle_at(Input::ClockIn, base).unwrap();
        agent
            .handle_at(
                Input::StartBreak {
                    kind: BreakKind::Meal,
                    planned_minutes: None,
                },
                base + Duration::from_secs(60),
            )
            .unwrap();
        let v = agent.view();
        assert_eq!(v.session_started_at, Some(epoch_ms(base)));
        let kinds: Vec<_> = v.timeline.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, ["working", "meal_break"]);
        assert_eq!(
            v.timeline[0].ended_at,
            Some(epoch_ms(base + Duration::from_secs(60)))
        );

        agent
            .handle_at(Input::ClockOut, base + Duration::from_secs(120))
            .unwrap();
        let v = agent.view();
        assert_eq!(v.session_started_at, None);
        assert_eq!(v.timeline.len(), 2, "clocking out keeps today's segments");
    }

    #[test]
    fn clock_in_clears_auto_clock_out_notice() {
        let agent = Agent::<Arc<FakeUi>>::new(CoreConfig::default());
        agent.lock().auto_clocked_out_at = Some(t(1));
        assert!(agent.view().auto_clocked_out_at.is_some());
        agent.handle(Input::ClockIn).unwrap();
        assert_eq!(agent.view().auto_clocked_out_at, None);
    }

    fn policy(threshold: u64, bio_cap_min: u64) -> PolicyDoc {
        PolicyDoc::from_value(&serde_json::json!({
            "idle": { "threshold_seconds": threshold },
            "break": { "bio": { "max_minutes": bio_cap_min } }
        }))
    }

    fn idle_threshold(agent: &Agent<Arc<FakeUi>>) -> Duration {
        agent.lock().driver.core().config().idle_threshold
    }

    #[test]
    fn adr_0023_a_planned_break_says_back_yet_by_name_and_the_menu_follows_policy() {
        let (agent, ui) = agent_with_ui();
        let base = SystemTime::now();
        agent.handle_at(Input::ClockIn, base).unwrap();
        let view = agent
            .handle_at(
                Input::StartBreak {
                    kind: BreakKind::Personal,
                    planned_minutes: Some(20),
                },
                base,
            )
            .unwrap();
        assert_eq!(view.planned_break_minutes, Some(20));
        assert_eq!(view.break_kind, Some("personal"));
        let tick = |min: u64| {
            let now = base + Duration::from_secs(min * 60);
            agent
                .handle_at(Input::Tick { last_input_at: now }, now)
                .unwrap()
        };
        tick(19);
        assert!(notes(&ui).is_empty());
        tick(20);
        // ADR-0031 §3: the louder overrun alert replaces "Back yet?".
        assert_eq!(notes(&ui), ["notify:Your break is over"]);
        tick(30);
        assert_eq!(notes(&ui)[1], "notify:Still on your break?");
        assert_eq!(
            agent
                .handle_at(Input::EndBreak, base + Duration::from_secs(1860))
                .unwrap()
                .planned_break_minutes,
            None
        );

        // A renamed Tea break, Meal switched off, Training off.
        agent.apply_policy(
            &PolicyDoc::from_value(&serde_json::json!({
                "break": { "rest": { "label": "Chai break" }, "meal": { "enabled": false } },
                "away": { "offer_training": false }
            })),
            None,
        );
        let v = agent.view();
        let menu: Vec<_> = v
            .break_options
            .iter()
            .map(|o| (o.id, o.label.as_str()))
            .collect();
        assert_eq!(
            menu,
            [
                ("bio", "Bio break"),
                ("rest", "Chai break"),
                ("personal", "Personal")
            ]
        );
        assert!(!v.offer_training);
        assert!(!agent.break_offered(BreakKind::Meal));
        assert!(agent.break_offered(BreakKind::Rest));
        assert!(!agent.away_offered(AwayReason::Training));
        assert!(agent.away_offered(AwayReason::Meeting));
    }

    #[test]
    fn the_view_carries_the_version_and_a_ready_update() {
        let (agent, ui) = agent_with_ui();
        let v = agent.view();
        assert_eq!(v.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(v.update_ready, None);
        assert!(agent.clocked_out());
        agent.update_ready("9.9.9".into());
        assert_eq!(agent.view().update_ready.as_deref(), Some("9.9.9"));
        // The window heard at once (its Restart to update button).
        assert!(ui
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.starts_with("state:clocked_out")));
        let tip = agent
            .lock()
            .tooltip(TrayStateSnapshot::NotClockedIn, SystemTime::now());
        assert!(tip.contains(&format!("Version {}", env!("CARGO_PKG_VERSION"))));
        assert!(tip.contains("Update 9.9.9 ready"));
        agent.handle(Input::ClockIn).unwrap();
        assert!(!agent.clocked_out());
    }

    #[test]
    fn planned_minutes_only_from_the_fixed_list() {
        assert_eq!(parse_planned_minutes(None), Ok(None));
        assert_eq!(parse_planned_minutes(Some(20)), Ok(Some(20)));
        for bad in [0, 7, 61, 120] {
            assert!(parse_planned_minutes(Some(bad)).is_err());
        }
        assert_eq!(parse_break_kind("rest"), Some(BreakKind::Rest));
        assert_eq!(parse_break_kind("prayer"), None);
        assert_eq!(parse_away_tag("training"), Some(AwayReason::Training));
    }

    #[test]
    fn a_policy_while_clocked_out_applies_at_once() {
        let agent = Agent::<Arc<FakeUi>>::new(CoreConfig::default());
        agent.apply_policy(&policy(600, 20), Some("v1".into()));
        assert_eq!(idle_threshold(&agent), Duration::from_secs(600));
        assert_eq!(
            agent.lock().reminder_cfg.bio_cap,
            Duration::from_secs(20 * 60)
        );
    }

    #[test]
    fn a_policy_mid_session_waits_for_the_session_to_end_except_reminders() {
        let agent = Agent::<Arc<FakeUi>>::new(CoreConfig::default());
        agent.handle(Input::ClockIn).unwrap();
        agent.apply_policy(&policy(900, 15), Some("v2".into()));
        // The session keeps its idle rule; the nudge cadence changes now.
        assert_eq!(idle_threshold(&agent), Duration::from_secs(120));
        assert_eq!(
            agent.lock().reminder_cfg.bio_cap,
            Duration::from_secs(15 * 60)
        );

        agent.handle(Input::ClockOut).unwrap();
        assert_eq!(idle_threshold(&agent), Duration::from_secs(900));
        assert!(agent.lock().pending_policy.is_none());
    }

    #[test]
    fn only_the_latest_pending_policy_is_adopted() {
        let agent = Agent::<Arc<FakeUi>>::new(CoreConfig::default());
        agent.handle(Input::ClockIn).unwrap();
        agent.apply_policy(&policy(900, 10), Some("v2".into()));
        agent.apply_policy(&policy(1200, 10), Some("v3".into()));
        agent.handle(Input::ClockOut).unwrap();
        assert_eq!(idle_threshold(&agent), Duration::from_secs(1200));
    }

    fn blocked() -> BlockedView {
        BlockedView {
            os: Some("windows"),
            opened_at: Some(1_790_000_000_000),
        }
    }

    /// ADR-0028: blocked, no clock-in from anywhere (window, popup,
    /// tray all end in `handle`); unblocked, clocking in works again.
    #[test]
    fn blocked_refuses_clock_in_until_unblocked() {
        let (agent, ui) = agent_with_ui();
        agent.set_blocked(Some(blocked()), true);
        assert!(agent.is_blocked());
        let view = agent.view();
        assert_eq!(view.blocked_elsewhere, Some(blocked()));
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["blockedElsewhere"]["os"], "windows");
        assert_eq!(json["blockedElsewhere"]["openedAt"], 1_790_000_000_000u64);
        assert!(ui.calls.lock().unwrap().contains(&"show_main".to_string()));

        assert_eq!(
            agent.handle(Input::ClockIn),
            Err(Rejected::ClockedInElsewhere)
        );
        assert_eq!(
            agent.handle(Input::ClockInFrom(SystemTime::now())),
            Err(Rejected::ClockedInElsewhere)
        );
        assert_eq!(agent.state(), CoreState::ClockedOut);
        assert_eq!(
            rejection_code(&Rejected::ClockedInElsewhere),
            "clocked_in_elsewhere"
        );

        agent.set_blocked(None, false);
        assert!(!agent.is_blocked());
        assert!(agent.view().blocked_elsewhere.is_none());
        agent.handle(Input::ClockIn).unwrap();
        assert_eq!(agent.state(), CoreState::Active);
    }

    #[test]
    fn blocking_again_with_the_same_details_changes_nothing() {
        let (agent, ui) = agent_with_ui();
        agent.set_blocked(Some(blocked()), false);
        let n = ui.calls.lock().unwrap().len();
        agent.set_blocked(Some(blocked()), true);
        assert_eq!(ui.calls.lock().unwrap().len(), n);
    }

    /// ADR-0028: a refused or remotely closed session ends here without
    /// a clock-out event; only the named session is left.
    #[test]
    fn abandoning_the_session_clocks_out_without_an_event() {
        use crate::recorder::Target;
        use ed25519_dalek::SigningKey;

        let id = crate::enroll::Identity {
            oid: "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b".into(),
            device_id: "33333333-3333-4333-8333-333333333333".into(),
            employee_id: "44444444-4444-4444-8444-444444444444".into(),
        };
        let recorder = Recorder::new();
        recorder.arm(Target::in_memory(id, SigningKey::from_bytes(&[7u8; 32])));
        let agent = Agent::<Arc<FakeUi>>::with_recorder(CoreConfig::default(), &recorder);
        let ui = Arc::new(FakeUi::default());
        agent.attach(ui.clone());

        assert!(!agent.abandon_session(None), "nothing to leave");
        agent.handle(Input::ClockIn).unwrap();
        agent
            .handle(Input::StartBreak {
                kind: BreakKind::Bio,
                planned_minutes: None,
            })
            .unwrap();
        assert_eq!(recorder.unsent().unwrap(), 2);
        assert!(!agent.abandon_session(Some("another-session")));
        assert_ne!(agent.state(), CoreState::ClockedOut);

        assert!(agent.abandon_session(None));
        assert_eq!(agent.state(), CoreState::ClockedOut);
        assert_eq!(recorder.unsent().unwrap(), 2, "no clock-out recorded");
        let view = agent.view();
        assert_eq!(view.session_started_at, None);
        assert!(view.timeline.iter().all(|s| s.ended_at.is_some()));
        assert!(ui
            .calls
            .lock()
            .unwrap()
            .contains(&"state:clocked_out:NotClockedIn".to_string()));
        // Clocking in again starts a fresh session.
        agent.handle(Input::ClockIn).unwrap();
        assert_eq!(recorder.unsent().unwrap(), 3);
    }

    #[test]
    fn today_is_journaled_and_restored_after_a_restart() {
        use crate::recorder::Target;
        use ed25519_dalek::SigningKey;

        let id = crate::enroll::Identity {
            oid: "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b".into(),
            device_id: "33333333-3333-4333-8333-333333333333".into(),
            employee_id: "44444444-4444-4444-8444-444444444444".into(),
        };
        let recorder = Recorder::new();
        recorder.arm(Target::in_memory(id, SigningKey::from_bytes(&[7u8; 32])));
        let first = Agent::<Arc<FakeUi>>::with_recorder(CoreConfig::default(), &recorder);
        first.handle(Input::ClockIn).unwrap();
        first
            .handle(Input::StartBreak {
                kind: BreakKind::Meal,
                planned_minutes: None,
            })
            .unwrap();
        first.handle(Input::EndBreak).unwrap();
        first.handle(Input::ClockOut).unwrap();
        let before = first.view().timeline;
        assert_eq!(before.len(), 3);

        // "Restart": a new agent on the same (still armed) outbox.
        let second = Agent::<Arc<FakeUi>>::with_recorder(CoreConfig::default(), &recorder);
        assert!(second.view().timeline.is_empty());
        second.restore_today();
        assert_eq!(second.view().timeline, before);

        // Restoring again never duplicates, and sign-out clears it.
        second.restore_today();
        assert_eq!(second.view().timeline.len(), 3);
        second.clear_timeline();
        assert!(second.view().timeline.is_empty());
    }

    #[test]
    fn clocking_in_before_the_restore_keeps_the_morning() {
        use crate::recorder::Target;
        use ed25519_dalek::SigningKey;

        let id = crate::enroll::Identity {
            oid: "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b".into(),
            device_id: "33333333-3333-4333-8333-333333333333".into(),
            employee_id: "44444444-4444-4444-8444-444444444444".into(),
        };
        let recorder = Recorder::new();
        recorder.arm(Target::in_memory(id, SigningKey::from_bytes(&[7u8; 32])));
        let first = Agent::<Arc<FakeUi>>::with_recorder(CoreConfig::default(), &recorder);
        first.handle(Input::ClockIn).unwrap();
        first.handle(Input::ClockOut).unwrap();
        let morning = first.view().timeline;
        assert_eq!(morning.len(), 1);

        // After the update: clocked in from the popup before signing-in
        // finished, then today comes back from the server.
        std::thread::sleep(Duration::from_millis(5));
        let fresh = Recorder::new();
        let second = Agent::<Arc<FakeUi>>::with_recorder(CoreConfig::default(), &fresh);
        second.handle(Input::ClockIn).unwrap();
        assert!(second.lacks_history());
        let server = serde_json::to_string(&morning).unwrap();
        assert!(second.restore_today_from_server(&server));
        let day = second.view().timeline;
        assert_eq!(day.len(), 2);
        assert_eq!(day[0], morning[0]);
        assert_eq!((day[0].session, day[1].session), (1, 2));
        assert!(day[1].ended_at.is_none());
        assert!(!second.lacks_history());
    }
}
