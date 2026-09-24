//! Windows notification-area (tray) icon + menu.
//!
//! Menu shape:
//!   Status: <state>          (disabled label — reflects live state)
//!   ─────────
//!   <actions for the state>  (see [`action_items`])
//!   ─────────
//!   Show CloudPunch
//!   Quit
//!
//! Action items drive the same [`Agent`] as the Tauri commands; the
//! agent rebuilds this menu via [`update`] after every state change.

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

use crate::agent::Agent;
use crate::machine::{BreakKind, Input};

const TRAY_ID: &str = "cp-tray";

/// The states the tray distinguishes. `ClockedIn` covers active, on
/// a call, and prompt pending — the tray does not surface calls
/// (ADR-0003 §1: `ON_CALL` is reported as `ACTIVE`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayStateSnapshot {
    NotClockedIn,
    ClockedIn,
    OnBreak,
    Away,
}

/// Human-readable status label for the first (disabled) tray menu
/// item. Pure fn — trivially unit-testable.
pub fn render_status_label(state: &TrayStateSnapshot) -> String {
    match state {
        TrayStateSnapshot::NotClockedIn => "Status: Not clocked in".to_string(),
        TrayStateSnapshot::ClockedIn => "Status: Clocked in".to_string(),
        TrayStateSnapshot::OnBreak => "Status: On break".to_string(),
        TrayStateSnapshot::Away => "Status: Away".to_string(),
    }
}

/// `(menu id, label)` for the state's action items. Pure.
pub fn action_items(state: TrayStateSnapshot) -> &'static [(&'static str, &'static str)] {
    match state {
        TrayStateSnapshot::NotClockedIn => &[("clock_in", "Clock in")],
        TrayStateSnapshot::ClockedIn => &[
            ("clock_out", "Clock out"),
            ("bio_break", "Bio break"),
            ("meal_break", "Meal break"),
        ],
        TrayStateSnapshot::OnBreak => &[("end_break", "End break"), ("clock_out", "Clock out")],
        TrayStateSnapshot::Away => &[("mark_back", "I'm back"), ("clock_out", "Clock out")],
    }
}

/// Core input for an action menu id. Pure.
pub fn input_for(id: &str) -> Option<Input> {
    Some(match id {
        "clock_in" => Input::ClockIn,
        "clock_out" => Input::ClockOut,
        "bio_break" => Input::StartBreak(BreakKind::Bio),
        "meal_break" => Input::StartBreak(BreakKind::Meal),
        "end_break" => Input::EndBreak,
        "mark_back" => Input::MarkBack,
        _ => return None,
    })
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, state: TrayStateSnapshot) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "status",
        render_status_label(&state),
        false,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (id, label) in action_items(state) {
        menu.append(&MenuItem::with_id(app, *id, *label, true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "show",
        "Show CloudPunch",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

/// Rebuild the menu for `state`. No-op if the tray isn't installed.
pub fn update<R: Runtime>(app: &AppHandle<R>, state: TrayStateSnapshot) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(build_menu(app, state)?))?;
    }
    Ok(())
}

/// Install the tray icon + menu on the given app. Called from
/// `lib.rs::run`'s `setup` closure so the runtime is ready.
pub fn install<R: Runtime>(app: &AppHandle<R>, state: TrayStateSnapshot) -> tauri::Result<()> {
    let menu = build_menu(app, state)?;

    let _ = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("CloudPunch")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("default_window_icon missing".to_string())
        })?)
        .menu(&menu)
        .show_menu_on_left_click(false) // right-click for menu; matches Windows convention
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            id => match (input_for(id), app.try_state::<Arc<Agent>>()) {
                (Some(input), Some(agent)) => {
                    if let Err(r) = agent.handle(input) {
                        eprintln!("[cloudpunch] tray: {id} rejected: {r:?}");
                    }
                }
                _ => {
                    #[cfg(debug_assertions)]
                    eprintln!("[cloudpunch] tray: unhandled menu id {id}");
                }
            },
        })
        .build(app)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_label_for_not_clocked_in() {
        assert_eq!(
            render_status_label(&TrayStateSnapshot::NotClockedIn),
            "Status: Not clocked in"
        );
    }

    #[test]
    fn render_label_for_clocked_in() {
        assert_eq!(
            render_status_label(&TrayStateSnapshot::ClockedIn),
            "Status: Clocked in"
        );
    }

    #[test]
    fn render_label_for_on_break() {
        assert_eq!(
            render_status_label(&TrayStateSnapshot::OnBreak),
            "Status: On break"
        );
    }

    #[test]
    fn render_label_for_away() {
        assert_eq!(
            render_status_label(&TrayStateSnapshot::Away),
            "Status: Away"
        );
    }

    #[test]
    fn every_action_item_maps_to_an_input() {
        for state in [
            TrayStateSnapshot::NotClockedIn,
            TrayStateSnapshot::ClockedIn,
            TrayStateSnapshot::OnBreak,
            TrayStateSnapshot::Away,
        ] {
            for (id, _) in action_items(state) {
                assert!(input_for(id).is_some(), "{id} has no input");
            }
        }
    }

    #[test]
    fn show_and_quit_are_not_core_inputs() {
        assert_eq!(input_for("show"), None);
        assert_eq!(input_for("quit"), None);
    }

    #[test]
    fn clocked_in_offers_bio_and_meal_not_other() {
        let ids: Vec<_> = action_items(TrayStateSnapshot::ClockedIn)
            .iter()
            .map(|(id, _)| *id)
            .collect();
        assert_eq!(ids, ["clock_out", "bio_break", "meal_break"]);
    }
}
