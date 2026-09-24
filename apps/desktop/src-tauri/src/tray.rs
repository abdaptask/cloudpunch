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
use crate::machine::{AwayReason, BreakKind, Input};

const TRAY_ID: &str = "cp-tray";

/// The states the tray distinguishes. `ClockedIn` covers active and
/// prompt pending. Calls are shown on the employee's own tray
/// (ADR-0011 §1); managers still see them as active.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayStateSnapshot {
    NotClockedIn,
    ClockedIn,
    OnCall,
    OnBreak,
    Away(AwayReason),
}

/// Human-readable status label for the first (disabled) tray menu
/// item. Pure fn — trivially unit-testable.
pub fn render_status_label(state: &TrayStateSnapshot) -> String {
    match state {
        TrayStateSnapshot::NotClockedIn => "Status: Not clocked in",
        TrayStateSnapshot::ClockedIn => "Status: Clocked in",
        TrayStateSnapshot::OnCall => "Status: On a call",
        TrayStateSnapshot::OnBreak => "Status: On break",
        TrayStateSnapshot::Away(AwayReason::Meeting) => "Status: In a meeting",
        TrayStateSnapshot::Away(AwayReason::PhoneCall) => "Status: On a phone call",
        TrayStateSnapshot::Away(AwayReason::WorkingAway) => "Status: Working away",
    }
    .to_string()
}

/// `(menu id, label)` for the state's action items. Pure.
pub fn action_items(state: TrayStateSnapshot) -> &'static [(&'static str, &'static str)] {
    match state {
        TrayStateSnapshot::NotClockedIn => &[("clock_in", "Clock in")],
        TrayStateSnapshot::ClockedIn => &[
            ("clock_out", "Clock out"),
            ("bio_break", "Bio break"),
            ("meal_break", "Meal break"),
            ("meeting", "In a meeting"),
            ("phone_call", "On a phone call"),
        ],
        // Away tags are not offered during a call (ADR-0009 §2).
        TrayStateSnapshot::OnCall => &[
            ("clock_out", "Clock out"),
            ("bio_break", "Bio break"),
            ("meal_break", "Meal break"),
        ],
        TrayStateSnapshot::OnBreak => &[("end_break", "End break"), ("clock_out", "Clock out")],
        TrayStateSnapshot::Away(_) => &[("mark_back", "I'm back"), ("clock_out", "Clock out")],
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
        "meeting" => Input::MarkAway {
            reason: AwayReason::Meeting,
            note: None,
        },
        "phone_call" => Input::MarkAway {
            reason: AwayReason::PhoneCall,
            note: None,
        },
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

    const ALL: [TrayStateSnapshot; 7] = [
        TrayStateSnapshot::NotClockedIn,
        TrayStateSnapshot::ClockedIn,
        TrayStateSnapshot::OnCall,
        TrayStateSnapshot::OnBreak,
        TrayStateSnapshot::Away(AwayReason::Meeting),
        TrayStateSnapshot::Away(AwayReason::PhoneCall),
        TrayStateSnapshot::Away(AwayReason::WorkingAway),
    ];

    fn ids(state: TrayStateSnapshot) -> Vec<&'static str> {
        action_items(state).iter().map(|(id, _)| *id).collect()
    }

    #[test]
    fn status_labels() {
        let labels: Vec<String> = ALL.iter().map(render_status_label).collect();
        assert_eq!(
            labels,
            [
                "Status: Not clocked in",
                "Status: Clocked in",
                "Status: On a call",
                "Status: On break",
                "Status: In a meeting",
                "Status: On a phone call",
                "Status: Working away",
            ]
        );
    }

    #[test]
    fn every_action_item_maps_to_an_input() {
        for state in ALL {
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
    fn clocked_in_offers_breaks_and_away_tags_not_other() {
        assert_eq!(
            ids(TrayStateSnapshot::ClockedIn),
            [
                "clock_out",
                "bio_break",
                "meal_break",
                "meeting",
                "phone_call"
            ]
        );
    }

    #[test]
    fn on_call_offers_no_away_tags() {
        assert_eq!(
            ids(TrayStateSnapshot::OnCall),
            ["clock_out", "bio_break", "meal_break"]
        );
    }

    #[test]
    fn away_offers_back_and_clock_out() {
        assert_eq!(
            ids(TrayStateSnapshot::Away(AwayReason::Meeting)),
            ["mark_back", "clock_out"]
        );
    }

    #[test]
    fn tag_ids_map_to_mark_away() {
        assert_eq!(
            input_for("meeting"),
            Some(Input::MarkAway {
                reason: AwayReason::Meeting,
                note: None
            })
        );
    }
}
