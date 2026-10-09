//! Small local log files in the app's log folder: `update.log`
//! (ADR-0022) and `popup.log` (ADR-0036 §2). Versions, states and
//! reasons only — never content (invariant 1). They stay on the
//! computer; an installed Windows build has no console for `eprintln!`.

use std::path::Path;
use std::time::SystemTime;

use tauri::{AppHandle, Manager};

/// Past this a log starts again (the old one is kept as `.old`).
const MAX_BYTES: u64 = 256 * 1024;

/// Append a timestamped line to `file`; never fails the caller.
pub fn write<R: tauri::Runtime>(app: &AppHandle<R>, file: &str, line: &str) {
    eprintln!("[cloudpunch] {line}");
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let _ = append(&dir, file, line, SystemTime::now());
}

pub(crate) fn append(dir: &Path, file: &str, line: &str, now: SystemTime) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    let path = dir.join(file);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, dir.join(format!("{file}.old")));
    }
    let at = chrono::DateTime::<chrono::Utc>::from(now).format("%Y-%m-%dT%H:%M:%SZ");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(f, "{at} {} {line}", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn appends_timestamped_lines_and_rolls_over() {
        let dir = std::env::temp_dir().join(format!("cp-log-{}", uuid::Uuid::new_v4()));
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_790_000_000);
        append(&dir, "update.log", "update 0.1.8 downloaded", t).unwrap();
        append(&dir, "update.log", "installing update 0.1.8", t).unwrap();
        append(&dir, "popup.log", "shift popup opened", t).unwrap();
        let text = std::fs::read_to_string(dir.join("update.log")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("2026-09-21T"), "{}", lines[0]);
        assert!(lines[0].ends_with(" update 0.1.8 downloaded"));
        let popup = std::fs::read_to_string(dir.join("popup.log")).unwrap();
        assert!(popup.trim_end().ends_with(" shift popup opened"));

        std::fs::write(dir.join("update.log"), vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
        append(&dir, "update.log", "after roll", t).unwrap();
        assert!(dir.join("update.log.old").exists());
        let fresh = std::fs::read_to_string(dir.join("update.log")).unwrap();
        assert_eq!(fresh.lines().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
