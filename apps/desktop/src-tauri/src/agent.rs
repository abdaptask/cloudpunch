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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::machine::driver::Driver;
use crate::machine::{
    AwayReason, BreakKind, CallType, Core, CoreConfig, CoreState, Effect, Input, Rejected,
};
use crate::recorder::{OutboxSink, Recorder};
use crate::reminders::{self, Inputs as ReminderInputs, Reminder, ReminderConfig, ReminderState};
use crate::timeline::{epoch_ms, SegmentView, Timeline};
use crate::tray::{self, TrayStateSnapshot};

/// Label of the idle prompt window. The frontend routes on it.
pub const PROMPT_WINDOW: &str = "idle-prompt";
/// Event carrying a [`StateView`] to every webview.
pub const STATE_EVENT: &str = "cp://state";

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
}

impl StateView {
    pub fn with_long_shift(mut self, long_shift: bool) -> Self {
        self.long_shift = long_shift;
        self
    }

    pub fn with_call_type(mut self, call_type: Option<CallType>) -> Self {
        self.call_type = call_type.map(CallType::as_str);
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
    let (status, break_kind, away_reason, prompt_deadline) = match state {
        CoreState::ClockedOut => ("clocked_out", None, None, None),
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
    }
}

/// Pure: tray label/menu variant for `state`.
pub fn tray_snapshot(state: CoreState, call_type: Option<CallType>) -> TrayStateSnapshot {
    match state {
        CoreState::ClockedOut => TrayStateSnapshot::NotClockedIn,
        CoreState::OnBreak { .. } => TrayStateSnapshot::OnBreak,
        CoreState::Away { reason } => TrayStateSnapshot::Away(reason),
        CoreState::OnCall => TrayStateSnapshot::OnCall(call_type.unwrap_or(CallType::Other)),
        CoreState::Active | CoreState::IdlePending { .. } => TrayStateSnapshot::ClockedIn,
    }
}

/// Wire string for a rejected input, returned to the webview.
pub fn rejection_code(r: &Rejected) -> &'static str {
    match r {
        Rejected::InvalidTransition => "invalid_transition",
        Rejected::OptionNotOffered => "option_not_offered",
        Rejected::NoteRequired => "note_required",
        Rejected::NoteTooLong => "note_too_long",
    }
}

/// Tags the UI may set directly: only `meeting` (ADR-0011 §2). Phone
/// and working-away are prompt answers only; `other` isn't offered.
pub fn parse_away_tag(s: &str) -> Option<AwayReason> {
    match s {
        "meeting" => Some(AwayReason::Meeting),
        _ => None,
    }
}

pub fn parse_break_kind(s: &str) -> Option<BreakKind> {
    match s {
        "bio" => Some(BreakKind::Bio),
        "meal" => Some(BreakKind::Meal),
        "other" => Some(BreakKind::Other),
        _ => None,
    }
}

/// Window/tray work decided under the lock, applied after it.
#[derive(Debug, Default, PartialEq, Eq)]
struct UiPlan {
    broadcast: bool,
    show_prompt: bool,
    hide_prompt: bool,
    show_main: bool,
    /// Refresh the tray colour and tooltip.
    tray: bool,
    tooltip: String,
    /// Notifications to show, as (title, body).
    notes: Vec<(String, String)>,
}

/// The window/tray side of the agent. Production uses [`TauriUi`];
/// tests use a recording fake, which also keeps Tauri's window code
/// out of the unit-test binary (it needs the Windows app manifest,
/// which `tauri-build` only embeds into the real executable).
pub trait Ui: Send + Sync + 'static {
    fn show_prompt(&self);
    fn hide_prompt(&self);
    fn show_main(&self);
    fn state_changed(&self, view: &StateView, tray: TrayStateSnapshot);
    /// Main window shown and not minimised (reminders only fire when
    /// it isn't, ADR-0013 §2).
    fn main_visible(&self) -> bool;
    fn notify(&self, title: &str, body: &str);
    /// Tray icon colour and tooltip (ADR-0013 §3).
    fn tray_status(&self, tray: TrayStateSnapshot, tooltip: &str);
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
    timeline: Timeline,
    reminder_cfg: ReminderConfig,
    reminders: ReminderState,
    /// Long-shift banner showing until "Still working" or clock-out.
    long_shift: bool,
    /// Last minute the tray tooltip was refreshed.
    tooltip_minute: Option<u64>,
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
    }

    fn tooltip(&self, snapshot: TrayStateSnapshot, now: SystemTime) -> String {
        let elapsed = self
            .timeline
            .session_started_at()
            .map(|s| reminders::short_duration(now.duration_since(s).unwrap_or_default()));
        tray::tooltip(snapshot, elapsed.as_deref())
    }
}

/// Notification text for a reminder (ADR-0013 §2, §4, §5).
fn reminder_text(r: &Reminder) -> (String, String) {
    match r {
        Reminder::OnTheClock { elapsed } => (
            "You're on the clock".into(),
            format!(
                "{} this session. CloudPunch is running in the system tray.",
                reminders::short_duration(*elapsed)
            ),
        ),
        Reminder::BreakOverCap { kind, elapsed } => (
            format!("Still on your {} break?", kind.as_str()),
            format!(
                "{} min so far. End it in CloudPunch when you're back.",
                elapsed.as_secs() / 60
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
                timeline: Timeline::new(),
                reminder_cfg: ReminderConfig::default(),
                reminders: ReminderState::default(),
                long_shift: false,
                tooltip_minute: None,
            }),
            ui: OnceLock::new(),
            tray_notice: AtomicBool::new(false),
        })
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

    pub fn handle(&self, input: Input) -> Result<StateView, Rejected> {
        self.handle_at(input, SystemTime::now())
    }

    fn handle_at(&self, input: Input, now: SystemTime) -> Result<StateView, Rejected> {
        let is_tick = matches!(input, Input::Tick { .. });
        let is_clock_in = input == Input::ClockIn;
        let visible = self.ui.get().is_some_and(|u| u.main_visible());

        let (view, plan, snapshot) = {
            let mut inner = self.lock();
            let before = inner.driver.state();
            let call_before = inner.driver.core().call_type();
            let outcome = inner.driver.handle(input, now)?;
            let after = inner.driver.state();
            let call_after = inner.driver.core().call_type();
            if after != before || call_after != call_before {
                inner.timeline.record(after, call_after, now);
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
                    _ => {}
                }
            }
            // Only the grace timeout clocks out from a tick.
            if is_tick
                && matches!(before, CoreState::IdlePending { .. })
                && after == CoreState::ClockedOut
            {
                inner.auto_clocked_out_at = Some(now);
                plan.show_main = true;
            }
            if is_clock_in {
                inner.auto_clocked_out_at = None;
            }
            if after == CoreState::ClockedOut {
                inner.long_shift = false;
            }
            if is_tick {
                let inputs = ReminderInputs {
                    now,
                    state: after,
                    session_started_at: inner.timeline.session_started_at(),
                    segment_started_at: inner.timeline.open_segment_started_at(),
                    window_visible: visible,
                    minute_of_day: reminders::local_minute_of_day(),
                };
                let cfg = inner.reminder_cfg.clone();
                for r in reminders::due(&cfg, inputs, &mut inner.reminders) {
                    if matches!(r, Reminder::LongShift { .. }) {
                        inner.long_shift = true;
                        plan.show_main = true;
                        plan.broadcast = true;
                    }
                    plan.notes.push(reminder_text(&r));
                }
                let minute = epoch_ms(now) / 60_000;
                if inner.tooltip_minute != Some(minute) {
                    inner.tooltip_minute = Some(minute);
                    plan.tray = true;
                }
            }
            let snapshot = tray_snapshot(after, call_after);
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
        if plan.broadcast {
            ui.state_changed(view, snapshot);
        }
        if plan.tray {
            ui.tray_status(snapshot, &plan.tooltip);
        }
        for (title, body) in &plan.notes {
            ui.notify(title, body);
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
        .unwrap_or(UNIX_EPOCH)
}

/// No input source off Windows until macOS parity (2b.8): report
/// "input just now", so the idle prompt never fires there.
#[cfg(not(target_os = "windows"))]
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
    use crate::machine::PromptResponse;

    fn t(ms: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(ms)
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
    fn tray_notice_only_once_per_run() {
        let (agent, ui) = agent_with_ui();
        assert!(agent.notice_hidden_to_tray());
        assert!(!agent.notice_hidden_to_tray());
        assert_eq!(notes(&ui), ["notify:CloudPunch is still running"]);
    }

    fn agent_with_ui() -> (Arc<Agent<Arc<FakeUi>>>, Arc<FakeUi>) {
        let agent = Agent::<Arc<FakeUi>>::new(CoreConfig::default());
        let ui = Arc::new(FakeUi::default());
        agent.attach(ui.clone());
        (agent, ui)
    }

    #[test]
    fn state_changes_broadcast_view_and_tray() {
        let (agent, ui) = agent_with_ui();
        agent.handle(Input::ClockIn).unwrap();
        agent.handle(Input::StartBreak(BreakKind::Bio)).unwrap();
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
    fn idle_opens_prompt_then_timeout_clocks_out_and_shows_main() {
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
        assert_eq!(view.status, "clocked_out");
        assert_eq!(
            view.auto_clocked_out_at,
            Some(epoch_ms(base + Duration::from_secs(330)))
        );
        assert_eq!(
            *ui.calls.lock().unwrap(),
            ["hide_prompt", "show_main", "state:clocked_out:NotClockedIn"]
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
                Input::StartBreak(BreakKind::Meal),
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
}
