//! Tauri commands the webviews call. Thin: parse arguments, hand the
//! input to the [`Agent`], return the new [`StateView`] or a
//! rejection code. All validation that matters (transition legality,
//! prompt options, note rules) lives in the core, never in the UI.
//!
//! Commands are synchronous, and none of them can open a window: the
//! prompt window is only created from the tick thread (see `agent`).

use std::sync::Arc;

use tauri::{LogicalSize, State, WebviewWindow};

use crate::agent::{parse_away_tag, parse_break_kind, rejection_code, Agent, StateView};
use crate::machine::{Input, PromptResponse};

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

#[tauri::command]
pub fn clock_in(agent: State<'_, Arc<Agent>>) -> CommandResult {
    run(&agent, Input::ClockIn)
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

/// Voluntary away tag: `meeting` or `phone_call` (ADR-0011 §2).
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
