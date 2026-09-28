//! Pinned mini strip (ADR-0017): the main window shrinks to a small
//! always-on-top strip — status light, live timer, one action — and
//! grows back on unpin. Minimising the window while signed in pins it
//! instead, so the strip stays on the desktop.
//!
//! Only the strip's position is saved (`strip.json` in the app data
//! folder: two numbers, nothing about the user).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    WebviewWindow,
};

/// Event carrying `true` when the strip is pinned, `false` when unpinned.
pub const PIN_EVENT: &str = "cp://pinned";

/// Strip width (logical px). The height follows its content.
pub const STRIP_WIDTH: f64 = 320.0;
pub const STRIP_MIN_HEIGHT: f64 = 56.0;
pub const STRIP_MAX_HEIGHT: f64 = 220.0;
/// Gap from the work area's edge for the default top-right spot.
const MARGIN: f64 = 16.0;
const FILE: &str = "strip.json";

/// A rectangle in logical px.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
}

/// Pure: where the strip goes. The saved spot when the strip would be
/// on a screen that is still attached, else the top-right of `home`
/// (the work area the window is on).
pub fn strip_origin(saved: Option<(f64, f64)>, screens: &[Rect], home: Rect) -> (f64, f64) {
    if let Some((x, y)) = saved {
        // Its top-left and top-right corners, so it can still be dragged.
        let visible = |px: f64| screens.iter().any(|s| s.contains(px, y));
        if x.is_finite() && y.is_finite() && visible(x) && visible(x + STRIP_WIDTH - 1.0) {
            return (x, y);
        }
    }
    (
        (home.x + home.w - STRIP_WIDTH - MARGIN).max(home.x),
        home.y + MARGIN,
    )
}

/// Pure: the strip's height for its content.
pub fn clamp_strip_height(requested: f64) -> f64 {
    if requested.is_finite() {
        requested.clamp(STRIP_MIN_HEIGHT, STRIP_MAX_HEIGHT)
    } else {
        STRIP_MIN_HEIGHT
    }
}

#[derive(Default)]
struct Inner {
    pinned: bool,
    /// The full window's spot and size, to return to on unpin.
    restore: Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>,
}

/// Whether the main window is the strip right now.
#[derive(Default)]
pub struct Pin {
    inner: Mutex<Inner>,
}

impl Pin {
    pub fn is_pinned(&self) -> bool {
        self.lock().pinned
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Shrink `window` to the strip. No-op when already pinned.
    pub fn pin(&self, window: &WebviewWindow) -> tauri::Result<()> {
        let restore = (window.outer_position()?, window.inner_size()?);
        {
            let mut inner = self.lock();
            if inner.pinned {
                return Ok(());
            }
            inner.pinned = true;
            inner.restore = Some(restore);
        }
        // Lock released: moving the window can fire `Moved` right away,
        // and that handler takes the lock too.
        let saved = data_file(window.app_handle()).and_then(|p| load(&p));
        let (x, y) = strip_origin(saved, &screens(window), home(window));
        window.set_decorations(false)?;
        window.set_always_on_top(true)?;
        window.set_size(LogicalSize::new(STRIP_WIDTH, STRIP_MIN_HEIGHT))?;
        window.set_position(LogicalPosition::new(x, y))?;
        let _ = window.emit(PIN_EVENT, true);
        Ok(())
    }

    /// Back to the full window where it was. No-op when not pinned.
    pub fn unpin(&self, window: &WebviewWindow) -> tauri::Result<()> {
        let restore = {
            let mut inner = self.lock();
            if !inner.pinned {
                return Ok(());
            }
            inner.pinned = false;
            inner.restore.take()
        };
        window.set_always_on_top(false)?;
        window.set_decorations(true)?;
        if let Some((pos, size)) = restore {
            window.set_size(size)?;
            window.set_position(pos)?;
        }
        let _ = window.emit(PIN_EVENT, false);
        Ok(())
    }

    /// The strip was dragged: keep the spot for next time.
    pub fn moved(&self, window: &WebviewWindow, pos: PhysicalPosition<i32>) {
        if !self.is_pinned() {
            return;
        }
        let scale = window.scale_factor().unwrap_or(1.0);
        let logical: LogicalPosition<f64> = pos.to_logical(scale);
        if let Some(path) = data_file(window.app_handle()) {
            save(&path, (logical.x, logical.y));
        }
    }
}

/// Every attached screen's work area.
fn screens(window: &WebviewWindow) -> Vec<Rect> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(work_area)
        .collect()
}

/// The work area of the screen the window is on.
fn home(window: &WebviewWindow) -> Rect {
    window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| work_area(&m))
        .unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            w: 1280.0,
            h: 720.0,
        })
}

fn work_area(m: &tauri::Monitor) -> Rect {
    let s = m.scale_factor();
    let a = m.work_area();
    Rect {
        x: f64::from(a.position.x) / s,
        y: f64::from(a.position.y) / s,
        w: f64::from(a.size.width) / s,
        h: f64::from(a.size.height) / s,
    }
}

fn data_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(FILE))
}

fn load(path: &Path) -> Option<(f64, f64)> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    Some((v["x"].as_f64()?, v["y"].as_f64()?))
}

fn save(path: &Path, (x, y): (f64, f64)) {
    let body = serde_json::json!({ "x": x, "y": y }).to_string();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(path, body) {
        eprintln!("[cloudpunch] could not save the strip position: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEFT: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 1920.0,
        h: 1040.0,
    };
    const RIGHT: Rect = Rect {
        x: 1920.0,
        y: 0.0,
        w: 1280.0,
        h: 680.0,
    };

    #[test]
    fn defaults_to_the_top_right_of_the_home_screen() {
        assert_eq!(
            strip_origin(None, &[LEFT], LEFT),
            (1920.0 - STRIP_WIDTH - MARGIN, MARGIN)
        );
        assert_eq!(
            strip_origin(None, &[LEFT, RIGHT], RIGHT),
            (3200.0 - STRIP_WIDTH - MARGIN, MARGIN)
        );
    }

    #[test]
    fn keeps_a_saved_spot_that_is_still_on_a_screen() {
        assert_eq!(
            strip_origin(Some((100.0, 200.0)), &[LEFT], LEFT),
            (100.0, 200.0)
        );
        // Spanning two side-by-side screens is fine.
        assert_eq!(
            strip_origin(Some((1800.0, 10.0)), &[LEFT, RIGHT], LEFT),
            (1800.0, 10.0)
        );
    }

    #[test]
    fn drops_a_saved_spot_that_is_off_screen() {
        let default = strip_origin(None, &[LEFT], LEFT);
        // The second screen was unplugged.
        assert_eq!(strip_origin(Some((2500.0, 10.0)), &[LEFT], LEFT), default);
        // Hanging off the right edge.
        assert_eq!(strip_origin(Some((1800.0, 10.0)), &[LEFT], LEFT), default);
        assert_eq!(strip_origin(Some((10.0, -50.0)), &[LEFT], LEFT), default);
        assert_eq!(strip_origin(Some((f64::NAN, 10.0)), &[LEFT], LEFT), default);
    }

    #[test]
    fn strip_height_is_clamped() {
        assert_eq!(clamp_strip_height(10.0), STRIP_MIN_HEIGHT);
        assert_eq!(clamp_strip_height(120.0), 120.0);
        assert_eq!(clamp_strip_height(900.0), STRIP_MAX_HEIGHT);
        assert_eq!(clamp_strip_height(f64::NAN), STRIP_MIN_HEIGHT);
    }

    #[test]
    fn the_position_file_round_trips() {
        let dir = std::env::temp_dir().join(format!("cp-strip-{}", std::process::id()));
        let path = dir.join(FILE);
        assert_eq!(load(&path), None);
        save(&path, (12.5, 40.0));
        assert_eq!(load(&path), Some((12.5, 40.0)));
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load(&path), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
