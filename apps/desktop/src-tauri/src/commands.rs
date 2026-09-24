//! Tauri commands the webviews call. Thin: parse arguments, hand the
//! input to the [`Agent`], return the new [`StateView`] or a
//! rejection code. All validation that matters (transition legality,
//! prompt options, note rules) lives in the core, never in the UI.
//!
//! Commands are synchronous, and none of them can open a window: the
//! prompt window is only created from the tick thread (see `agent`).
//! The exception is `sign_in`, which is async and runs the browser
//! round trip on a blocking worker, off the UI thread.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, WebviewWindow};

use crate::agent::{parse_away_tag, parse_break_kind, rejection_code, Agent, StateView};
use crate::auth::{open_system_browser, AuthManager, AuthStatus};
use crate::keystore::OsStore;
use crate::machine::{CoreState, Input, PromptResponse};

/// The app's sign-in manager (ADR-0002 §5).
pub type Auth = AuthManager<OsStore>;

/// Event carrying an [`AuthStatus`] after sign-in, sign-out, or the
/// silent start-up restore.
pub const AUTH_EVENT: &str = "cp://auth";

/// How long the browser round trip may take.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

type CommandResult = Result<StateView, String>;

fn run(agent: &Agent, input: Input) -> CommandResult {
    agent
        .handle(input)
        .map_err(|r| rejection_code(&r).to_string())
}

/// Fixed width of the main window (logical px), from `tauri.conf.json`.
pub const MAIN_WIDTH: f64 = 420.0;
/// Never shrink below this, so the window stays usable.
pub const MIN_HEIGHT: f64 = 360.0;

/// Pure: clamp a requested content height to [MIN_HEIGHT, max].
/// `max` comes from the monitor's work area; non-finite input
/// (a broken measurement) falls back to MIN_HEIGHT.
pub fn clamp_height(requested: f64, max: f64) -> f64 {
    let max = if max.is_finite() {
        max.max(MIN_HEIGHT)
    } else {
        MIN_HEIGHT
    };
    if !requested.is_finite() {
        return MIN_HEIGHT;
    }
    requested.clamp(MIN_HEIGHT, max)
}

/// Resize the main window to fit its content. The webview measures
/// its own height and asks; the page gets no window permissions of its
/// own (least privilege).
#[tauri::command]
pub fn fit_window(window: WebviewWindow, height: f64) -> Result<(), String> {
    if window.label() != "main" {
        return Err("invalid_argument".to_string());
    }
    let max = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let scale = m.scale_factor();
            f64::from(m.work_area().size.height) / scale - 40.0
        })
        .unwrap_or(900.0);
    window
        .set_size(LogicalSize::new(MAIN_WIDTH, clamp_height(height, max)))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_state(agent: State<'_, Arc<Agent>>) -> StateView {
    agent.view()
}

/// Clocking in needs a signed-in user: every event is attributed to
/// one (2b.4).
#[tauri::command]
pub fn clock_in(agent: State<'_, Arc<Agent>>, auth: State<'_, Arc<Auth>>) -> CommandResult {
    if auth.oid().is_none() {
        return Err("not_signed_in".to_string());
    }
    run(&agent, Input::ClockIn)
}

#[tauri::command]
pub fn auth_status(auth: State<'_, Arc<Auth>>) -> AuthStatus {
    auth.status()
}

/// Interactive sign-in through the system browser.
#[tauri::command]
pub async fn sign_in(app: AppHandle, auth: State<'_, Arc<Auth>>) -> Result<AuthStatus, String> {
    let auth = auth.inner().clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        auth.sign_in(&open_system_browser, SIGN_IN_TIMEOUT)
    })
    .await
    .map_err(|_| "internal".to_string())?
    .map_err(|e| e.code().to_string())?;
    let _ = app.emit(AUTH_EVENT, &status);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(status)
}

/// Stop a sign-in waiting on the browser (e.g. the tab was closed).
#[tauri::command]
pub fn cancel_sign_in(auth: State<'_, Arc<Auth>>) {
    auth.cancel_sign_in();
}

/// Sign out: only while clocked out, so no session is left open.
#[tauri::command]
pub fn sign_out(
    app: AppHandle,
    agent: State<'_, Arc<Agent>>,
    auth: State<'_, Arc<Auth>>,
) -> Result<AuthStatus, String> {
    if agent.state() != CoreState::ClockedOut {
        return Err("clock_out_first".to_string());
    }
    auth.sign_out().map_err(|e| e.code().to_string())?;
    let status = auth.status();
    let _ = app.emit(AUTH_EVENT, &status);
    Ok(status)
}

/// Close dialog: "Keep running in tray" (ADR-0013 §1).
#[tauri::command]
pub fn hide_to_tray(window: WebviewWindow, agent: State<'_, Arc<Agent>>) -> Result<(), String> {
    if window.label() != "main" {
        return Err("invalid_argument".to_string());
    }
    window.hide().map_err(|e| e.to_string())?;
    agent.notice_hidden_to_tray();
    Ok(())
}

/// Close dialog: "Quit" — only while clocked out; clocked in must use
/// "Clock out & quit" so no session is left open.
#[tauri::command]
pub fn quit_app(app: AppHandle, agent: State<'_, Arc<Agent>>) -> Result<(), String> {
    if agent.state() != CoreState::ClockedOut {
        return Err("clock_out_first".to_string());
    }
    app.exit(0);
    Ok(())
}

/// Close dialog: "Clock out & quit".
#[tauri::command]
pub fn clock_out_and_quit(app: AppHandle, agent: State<'_, Arc<Agent>>) -> Result<(), String> {
    if agent.state() != CoreState::ClockedOut {
        run(&agent, Input::ClockOut)?;
    }
    app.exit(0);
    Ok(())
}

/// Long-shift banner: "Still working" (ADR-0013 §5).
#[tauri::command]
pub fn ack_long_shift(agent: State<'_, Arc<Agent>>) -> StateView {
    agent.ack_long_shift()
}

#[tauri::command]
pub fn clock_out(agent: State<'_, Arc<Agent>>) -> CommandResult {
    run(&agent, Input::ClockOut)
}

#[tauri::command]
pub fn start_break(agent: State<'_, Arc<Agent>>, kind: String) -> CommandResult {
    let kind = parse_break_kind(&kind).ok_or_else(|| "invalid_argument".to_string())?;
    run(&agent, Input::StartBreak(kind))
}

#[tauri::command]
pub fn end_break(agent: State<'_, Arc<Agent>>) -> CommandResult {
    run(&agent, Input::EndBreak)
}

/// Voluntary away tag: `meeting` (ADR-0011 §2).
#[tauri::command]
pub fn mark_away(
    agent: State<'_, Arc<Agent>>,
    reason: String,
    note: Option<String>,
) -> CommandResult {
    let reason = parse_away_tag(&reason).ok_or_else(|| "invalid_argument".to_string())?;
    run(&agent, Input::MarkAway { reason, note })
}

#[tauri::command]
pub fn mark_back(agent: State<'_, Arc<Agent>>) -> CommandResult {
    run(&agent, Input::MarkBack)
}

#[tauri::command]
pub fn respond_to_prompt(
    agent: State<'_, Arc<Agent>>,
    response: String,
    note: Option<String>,
) -> CommandResult {
    let response =
        PromptResponse::from_wire(&response).ok_or_else(|| "invalid_argument".to_string())?;
    run(&agent, Input::RespondToPrompt { response, note })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_height_bounds() {
        assert_eq!(clamp_height(500.0, 900.0), 500.0);
        assert_eq!(clamp_height(100.0, 900.0), MIN_HEIGHT);
        assert_eq!(clamp_height(2_000.0, 900.0), 900.0);
    }

    #[test]
    fn clamp_height_survives_bad_input() {
        assert_eq!(clamp_height(f64::NAN, 900.0), MIN_HEIGHT);
        assert_eq!(clamp_height(f64::INFINITY, 900.0), MIN_HEIGHT);
        assert_eq!(clamp_height(500.0, f64::NAN), MIN_HEIGHT);
        // A tiny screen never pushes max below the minimum.
        assert_eq!(clamp_height(500.0, 200.0), MIN_HEIGHT);
    }
}
