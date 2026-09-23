//! Windows notification-area (tray) icon + menu.
//!
//! Menu shape:
//!   Status: <state>          (disabled label — reflects live state)
//!   ─────────
//!   Clock in / Clock out     (toggles based on state)
//!   Take a break             (only shown when state is ClockedIn)
//!   ─────────
//!   Show CloudPunch
//!   Quit
//!
//! Slice 2b.7.1 wires only the menu structure and the always-on
//! items (Show / Quit). "Clock in", "Clock out", and "Take a break"
//! log to stderr for now — real event enqueueing lands with the
//! state-machine slice. Live status-label updates land alongside.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

/// The three states the tray label reflects. Kept minimal so the
/// pure formatter is trivially testable. Actual state transitions
/// come from the state machine (later slice).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayStateSnapshot {
    NotClockedIn,
    ClockedIn,
    OnBreak,
}

/// Human-readable status label for the first (disabled) tray menu
/// item. Pure fn — trivially unit-testable.
pub fn render_status_label(state: &TrayStateSnapshot) -> String {
    match state {
        TrayStateSnapshot::NotClockedIn => "Status: Not clocked in".to_string(),
        TrayStateSnapshot::ClockedIn => "Status: Clocked in".to_string(),
        TrayStateSnapshot::OnBreak => "Status: On break".to_string(),
    }
}

/// Install the tray icon + menu on the given app. Called from
/// `lib.rs::run`'s `setup` closure so the runtime is ready.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // Bootstrap state; live updates come from the state machine
    // slice via `TrayIcon::set_menu` in a follow-up.
    let state = TrayStateSnapshot::NotClockedIn;

    let status_item =
        MenuItem::with_id(app, "status", render_status_label(&state), false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let clock_in = MenuItem::with_id(app, "clock_in", "Clock in", true, None::<&str>)?;
    let take_break = MenuItem::with_id(app, "take_break", "Take a break", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let show = MenuItem::with_id(app, "show", "Show CloudPunch", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&status_item, &sep1, &clock_in, &take_break, &sep2, &show, &quit],
    )?;

    let _ = TrayIconBuilder::with_id("cp-tray")
        .tooltip("CloudPunch")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("default_window_icon missing".to_string())
        })?)
        .menu(&menu)
        .show_menu_on_left_click(false) // right-click for menu; matches Windows convention
        .on_menu_event(|app, event| match event.id.as_ref() {
            "clock_in" => {
                #[cfg(debug_assertions)]
                eprintln!("[cloudpunch] tray: clock_in (state machine wiring TBD)");
            }
            "take_break" => {
                #[cfg(debug_assertions)]
                eprintln!("[cloudpunch] tray: take_break (state machine wiring TBD)");
            }
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            other => {
                #[cfg(debug_assertions)]
                eprintln!("[cloudpunch] tray: unhandled menu id {other}");
            }
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
}
