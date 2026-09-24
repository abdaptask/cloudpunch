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
use crate::machine::sink::LogSink;
use crate::machine::{AwayReason, BreakKind, Core, CoreConfig, CoreState, Effect, Input, Rejected};
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
    pub prompt_deadline: Option<u64>,
    pub prompt_options: Vec<&'static str>,
    pub note_required_for: Vec<&'static str>,
    /// Set after a grace-timeout clock-out until the next clock-in.
    pub auto_clocked_out_at: Option<u64>,
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
        CoreState::Away { reason } => (
            "away",
            None,
            Some(match reason {
                AwayReason::PhoneCall => "phone_call",
                AwayReason::WorkingAway => "working_away",
            }),
            None,
        ),
    };
    StateView {
        status,
        break_kind,
        away_reason,
        prompt_deadline,
        prompt_options: cfg.prompt_options.iter().map(|r| r.as_str()).collect(),
        note_required_for: cfg.note_required_for.iter().map(|r| r.as_str()).collect(),
        auto_clocked_out_at: auto_clocked_out_at.map(epoch_ms),
    }
}

/// Pure: tray label/menu variant for `state`.
pub fn tray_snapshot(state: CoreState) -> TrayStateSnapshot {
    match state {
        CoreState::ClockedOut => TrayStateSnapshot::NotClockedIn,
        CoreState::OnBreak { .. } => TrayStateSnapshot::OnBreak,
        CoreState::Away { .. } => TrayStateSnapshot::Away,
        CoreState::Active | CoreState::OnCall | CoreState::IdlePending { .. } => {
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

fn epoch_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Window/tray work decided under the lock, applied after it.
#[derive(Debug, Default, PartialEq, Eq)]
struct UiPlan {
    broadcast: bool,
    show_prompt: bool,
    hide_prompt: bool,
    show_main: bool,
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
}

struct Inner {
    driver: Driver<LogSink>,
    auto_clocked_out_at: Option<SystemTime>,
}

pub struct Agent<U: Ui = TauriUi> {
    inner: Mutex<Inner>,
    ui: OnceLock<U>,
}

impl<U: Ui> Agent<U> {
    pub fn new(cfg: CoreConfig) -> Arc<Self> {
        let core = Core::new(cfg, SystemTime::now());
        Arc::new(Self {
            inner: Mutex::new(Inner {
                driver: Driver::new(core, LogSink),
                auto_clocked_out_at: None,
            }),
            ui: OnceLock::new(),
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
        let inner = self.lock();
        view_of(
            inner.driver.state(),
            inner.driver.core().config(),
            inner.auto_clocked_out_at,
        )
    }

    pub fn handle(&self, input: Input) -> Result<StateView, Rejected> {
        self.handle_at(input, SystemTime::now())
    }

    fn handle_at(&self, input: Input, now: SystemTime) -> Result<StateView, Rejected> {
        let is_tick = matches!(input, Input::Tick { .. });
        let is_clock_in = input == Input::ClockIn;

        let (view, plan, snapshot) = {
            let mut inner = self.lock();
            let before = inner.driver.state();
            let outcome = inner.driver.handle(input, now)?;
            let after = inner.driver.state();

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
            let view = view_of(
                after,
                inner.driver.core().config(),
                inner.auto_clocked_out_at,
            );
            (view, plan, tray_snapshot(after))
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
            tray_snapshot(CoreState::ClockedOut),
            TrayStateSnapshot::NotClockedIn
        );
        assert_eq!(
            tray_snapshot(CoreState::OnCall),
            TrayStateSnapshot::ClockedIn
        );
        assert_eq!(
            tray_snapshot(CoreState::OnBreak {
                kind: BreakKind::Bio
            }),
            TrayStateSnapshot::OnBreak
        );
        assert_eq!(
            tray_snapshot(CoreState::Away {
                reason: AwayReason::PhoneCall
            }),
            TrayStateSnapshot::Away
        );
    }

    #[test]
    fn parse_and_rejection_codes() {
        assert_eq!(parse_break_kind("bio"), Some(BreakKind::Bio));
        assert_eq!(parse_break_kind("nap"), None);
        assert_eq!(rejection_code(&Rejected::NoteRequired), "note_required");
    }

    /// Records UI calls as short strings.
    #[derive(Default)]
    struct FakeUi {
        calls: Mutex<Vec<String>>,
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
    fn clock_in_clears_auto_clock_out_notice() {
        let agent = Agent::<Arc<FakeUi>>::new(CoreConfig::default());
        agent.lock().auto_clocked_out_at = Some(t(1));
        assert!(agent.view().auto_clocked_out_at.is_some());
        agent.handle(Input::ClockIn).unwrap();
        assert_eq!(agent.view().auto_clocked_out_at, None);
    }
}
