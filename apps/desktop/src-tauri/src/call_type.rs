//! Kind of call, from the app holding the microphone (ADR-0012).
//!
//! Only the category leaves this module. The executable file name is
//! used transiently to classify and is never stored, logged, or sent.

/// `MEDIA_DEVICE_STATE.payload.call_type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CallType {
    Teams,
    Zoom,
    /// Any other app, a browser, or the camera alone.
    Other,
}

impl CallType {
    pub fn as_str(self) -> &'static str {
        match self {
            CallType::Teams => "teams",
            CallType::Zoom => "zoom",
            CallType::Other => "other",
        }
    }
}

/// Allowlist: executable file name (lower-case) → category. Compiled
/// in until policy fetch exists (`idle.call_type_apps`).
const ALLOWLIST: &[(&str, CallType)] = &[
    ("ms-teams.exe", CallType::Teams),
    ("teams.exe", CallType::Teams),
    ("zoom.exe", CallType::Zoom),
];

/// Apps that keep the microphone open while idle, so their microphone
/// use is never counted as a call (ADR-0012 §1a).
const IGNORED: &[&str] = &["ace dialer.exe"];

/// Lower-cased file name of a path, a file name, or a consent-store key
/// (which uses `#` as the path separator).
fn file_name(exe: &str) -> String {
    exe.rsplit(['\\', '/', '#'])
        .next()
        .unwrap_or(exe)
        .to_lowercase()
}

/// Category for one executable path or file name.
pub fn classify(exe: &str) -> CallType {
    let file = file_name(exe);
    ALLOWLIST
        .iter()
        .find(|(name, _)| *name == file)
        .map_or(CallType::Other, |(_, t)| *t)
}

/// True if this app's microphone use should never count as a call.
pub fn is_ignored(exe: &str) -> bool {
    IGNORED.contains(&file_name(exe).as_str())
}

/// When several apps capture at once: Teams, then Zoom, else Other.
/// `None` if nothing is capturing.
pub fn pick<I: IntoIterator<Item = CallType>>(types: I) -> Option<CallType> {
    let rank = |t: &CallType| match t {
        CallType::Teams => 0,
        CallType::Zoom => 1,
        CallType::Other => 2,
    };
    types.into_iter().min_by_key(rank)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_allowlisted_apps_case_insensitively() {
        assert_eq!(classify("ms-teams.exe"), CallType::Teams);
        assert_eq!(
            classify(r"C:\Users\x\AppData\Local\Microsoft\Teams\current\Teams.exe"),
            CallType::Teams
        );
        assert_eq!(
            classify(r"C:\Users\x\AppData\Roaming\Zoom\bin\Zoom.exe"),
            CallType::Zoom
        );
    }

    #[test]
    fn everything_else_is_other() {
        assert_eq!(
            classify(r"C:\Program Files\Google\Chrome\chrome.exe"),
            CallType::Other
        );
        assert_eq!(classify(""), CallType::Other);
    }

    #[test]
    fn idle_mic_holders_are_ignored_by_path_or_consent_key() {
        assert!(is_ignored(r"C:\Program Files\ApTask\ACE Dialer.exe"));
        assert!(is_ignored(r"C:#Program Files#ApTask#ace dialer.exe"));
        assert!(!is_ignored("ms-teams.exe"));
        assert!(!is_ignored("dialer.exe"));
    }

    #[test]
    fn pick_prefers_teams_then_zoom() {
        assert_eq!(pick([]), None);
        assert_eq!(
            pick([CallType::Other, CallType::Zoom]),
            Some(CallType::Zoom)
        );
        assert_eq!(
            pick([CallType::Zoom, CallType::Teams]),
            Some(CallType::Teams)
        );
        assert_eq!(pick([CallType::Other]), Some(CallType::Other));
    }

    #[test]
    fn wire_names() {
        let names: Vec<_> = [CallType::Teams, CallType::Zoom, CallType::Other]
            .iter()
            .map(|t| t.as_str())
            .collect();
        assert_eq!(names, ["teams", "zoom", "other"]);
    }
}
