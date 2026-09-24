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
use crate::commands::Auth;
use crate::machine::{AwayReason, BreakKind, CallType, Input};

const TRAY_ID: &str = "cp-tray";

/// Asks the main window to show the close / quit dialog (ADR-0013 §1).
pub const CLOSE_REQUESTED_EVENT: &str = "cp://close-requested";

/// The states the tray distinguishes. `ClockedIn` covers active and
/// prompt pending. Calls show their kind (ADR-0012).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayStateSnapshot {
    NotClockedIn,
    ClockedIn,
    /// Kind of call (ADR-0012).
    OnCall(CallType),
    OnBreak,
    Away(AwayReason),
}

/// Human-readable status label for the first (disabled) tray menu
/// item. Pure fn — trivially unit-testable.
pub fn render_status_label(state: &TrayStateSnapshot) -> String {
    match state {
        TrayStateSnapshot::NotClockedIn => "Status: Not clocked in",
        TrayStateSnapshot::ClockedIn => "Status: Clocked in",
        TrayStateSnapshot::OnCall(CallType::Teams) => "Status: On a Teams call",
        TrayStateSnapshot::OnCall(CallType::Zoom) => "Status: On a Zoom call",
        TrayStateSnapshot::OnCall(CallType::Other) => "Status: On a call",
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
        ],
        // Away tags are not offered during a call (ADR-0009 §2).
        TrayStateSnapshot::OnCall(_) => &[
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

/// Status colour and tooltip on the tray icon (ADR-0013 §3).
pub fn set_status<R: Runtime>(
    app: &AppHandle<R>,
    state: TrayStateSnapshot,
    tooltip: &str,
) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let rgba = status_icon_rgba(status_color(state));
        tray.set_icon(Some(tauri::image::Image::new(&rgba, ICON_SIZE, ICON_SIZE)))?;
        tray.set_tooltip(Some(tooltip))?;
    }
    Ok(())
}

/// Green on the clock (working, calls, away), amber on a break, grey
/// clocked out. Pure.
pub fn status_color(state: TrayStateSnapshot) -> [u8; 3] {
    match state {
        TrayStateSnapshot::NotClockedIn => [0x9c, 0xa3, 0xaf],
        TrayStateSnapshot::OnBreak => [0xd9, 0x77, 0x06],
        TrayStateSnapshot::ClockedIn
        | TrayStateSnapshot::OnCall(_)
        | TrayStateSnapshot::Away(_) => [0x16, 0xa3, 0x4a],
    }
}

/// "CloudPunch — Clocked in · 2h 30m". Pure.
pub fn tooltip(state: TrayStateSnapshot, session: Option<&str>) -> String {
    let status = render_status_label(&state);
    let status = status.trim_start_matches("Status: ");
    match session {
        Some(elapsed) if state != TrayStateSnapshot::NotClockedIn => {
            format!("CloudPunch — {status} · {elapsed}")
        }
        _ => format!("CloudPunch — {status}"),
    }
}

const ICON_SIZE: u32 = 32;

/// A 32×32 RGBA disc in `color` with white clock hands. Pure, so no
/// icon files are needed per state.
pub fn status_icon_rgba(color: [u8; 3]) -> Vec<u8> {
    let n = ICON_SIZE as i32;
    let c = (n as f32 - 1.0) / 2.0;
    let mut px = vec![0u8; (n * n * 4) as usize];
    for y in 0..n {
        for x in 0..n {
            let (dx, dy) = (x as f32 - c, y as f32 - c);
            let r = (dx * dx + dy * dy).sqrt();
            let i = ((y * n + x) * 4) as usize;
            // Anti-aliased disc edge.
            let alpha = (15.5 - r).clamp(0.0, 1.0);
            if alpha == 0.0 {
                continue;
            }
            // Hands: 12 o'clock and 3 o'clock from the centre.
            let hand = (dx.abs() <= 1.3 && (-9.0..=0.5).contains(&dy))
                || (dy.abs() <= 1.3 && (-0.5..=7.0).contains(&dx));
            let rgb = if hand { [255, 255, 255] } else { color };
            px[i..i + 3].copy_from_slice(&rgb);
            px[i + 3] = (alpha * 255.0) as u8;
        }
    }
    px
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
            // Never exit mid-session: while clocked in, ask in the
            // window (clock out & quit, or keep running) (ADR-0013 §1).
            "quit" => {
                let clocked_in = app
                    .try_state::<Arc<Agent>>()
                    .is_some_and(|a| a.state() != crate::machine::CoreState::ClockedOut);
                if clocked_in {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                        let _ = tauri::Emitter::emit(&w, CLOSE_REQUESTED_EVENT, ());
                    }
                } else {
                    app.exit(0);
                }
            }
            // Clocking in needs a signed-in user; send them to the
            // window's sign-in screen instead (2b.4 F2).
            "clock_in"
                if app
                    .try_state::<Arc<Auth>>()
                    .is_some_and(|a| a.oid().is_none()) =>
            {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
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
        TrayStateSnapshot::OnCall(CallType::Teams),
        TrayStateSnapshot::OnBreak,
        TrayStateSnapshot::Away(AwayReason::Meeting),
        TrayStateSnapshot::Away(AwayReason::PhoneCall),
        TrayStateSnapshot::Away(AwayReason::WorkingAway),
    ];

    fn ids(state: TrayStateSnapshot) -> Vec<&'static str> {
        action_items(state).iter().map(|(id, _)| *id).collect()
    }

    #[test]
    fn status_colours_and_tooltips() {
        assert_eq!(
            status_color(TrayStateSnapshot::NotClockedIn),
            [0x9c, 0xa3, 0xaf]
        );
        assert_eq!(status_color(TrayStateSnapshot::OnBreak), [0xd9, 0x77, 0x06]);
        assert_eq!(
            status_color(TrayStateSnapshot::OnCall(CallType::Teams)),
            status_color(TrayStateSnapshot::ClockedIn)
        );
        assert_eq!(
            tooltip(TrayStateSnapshot::ClockedIn, Some("2h 30m")),
            "CloudPunch — Clocked in · 2h 30m"
        );
        assert_eq!(
            tooltip(TrayStateSnapshot::NotClockedIn, Some("5m")),
            "CloudPunch — Not clocked in"
        );
    }

    #[test]
    fn status_icon_is_a_32px_disc_with_transparent_corners() {
        let px = status_icon_rgba([1, 2, 3]);
        assert_eq!(px.len(), 32 * 32 * 4);
        assert_eq!(px[3], 0, "corner transparent");
        let edge = ((16 * 32 + 1) * 4) as usize; // left edge, mid-height
        assert_eq!(&px[edge..edge + 3], &[1, 2, 3]);
        let centre = ((16 * 32 + 16) * 4) as usize;
        assert_eq!(&px[centre..centre + 3], &[255, 255, 255], "hands");
    }

    #[test]
    fn status_labels() {
        let labels: Vec<String> = ALL.iter().map(render_status_label).collect();
        assert_eq!(
            labels,
            [
                "Status: Not clocked in",
                "Status: Clocked in",
                "Status: On a Teams call",
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
            ["clock_out", "bio_break", "meal_break", "meeting"]
        );
    }

    #[test]
    fn on_call_offers_no_away_tags() {
        assert_eq!(
            ids(TrayStateSnapshot::OnCall(CallType::Zoom)),
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
