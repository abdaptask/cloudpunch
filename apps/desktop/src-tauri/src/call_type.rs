//! Kind of call, from the app holding the microphone (ADR-0012).
//!
//! Only the category leaves this module. The executable file name is
//! used transiently to classify and is never stored, logged, or sent.

/// `MEDIA_DEVICE_STATE.payload.call_type`.
use std::sync::RwLock;

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

/// Call-app rules from policy (`idle.call_type_apps` /
/// `idle.call_type_ignored`, ADR-0015 §8). Configuration only: the app
/// name picks a category and is never recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rules {
    pub apps: Vec<(String, CallType)>,
    pub ignored: Vec<String>,
}

impl Rules {
    /// Names are matched on the lower-cased file name.
    pub fn new(apps: Vec<(String, CallType)>, ignored: Vec<String>) -> Self {
        Self {
            apps: apps
                .into_iter()
                .map(|(n, t)| (n.to_lowercase(), t))
                .collect(),
            ignored: ignored.into_iter().map(|n| n.to_lowercase()).collect(),
        }
    }

    /// The compiled-in lists (the schema defaults).
    pub fn builtin() -> Self {
        Self::new(
            ALLOWLIST.iter().map(|(n, t)| (n.to_string(), *t)).collect(),
            IGNORED.iter().map(|n| n.to_string()).collect(),
        )
    }

    pub fn classify(&self, exe: &str) -> CallType {
        let file = file_name(exe);
        self.apps
            .iter()
            .find(|(name, _)| *name == file)
            .map_or(CallType::Other, |(_, t)| *t)
    }

    pub fn is_ignored(&self, exe: &str) -> bool {
        let file = file_name(exe);
        self.ignored.contains(&file)
    }
}

/// The rules in force; `None` means the built-in lists.
static RULES: RwLock<Option<Rules>> = RwLock::new(None);

/// Replace the rules in force (from the adopted policy).
pub fn set_rules(rules: Rules) {
    *RULES.write().unwrap_or_else(|p| p.into_inner()) = Some(rules);
}

fn with_rules<T>(f: impl FnOnce(&Rules) -> T) -> T {
    let guard = RULES.read().unwrap_or_else(|p| p.into_inner());
    match guard.as_ref() {
        Some(r) => f(r),
        None => f(&Rules::builtin()),
    }
}

/// Category for one executable path or file name.
pub fn classify(exe: &str) -> CallType {
    with_rules(|r| r.classify(exe))
}

/// True if this app's microphone use should never count as a call.
pub fn is_ignored(exe: &str) -> bool {
    with_rules(|r| r.is_ignored(exe))
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
    fn policy_rules_replace_the_builtin_lists() {
        let rules = Rules::new(
            vec![
                ("Webex.exe".into(), CallType::Other),
                ("zoom.exe".into(), CallType::Zoom),
            ],
            vec!["Softphone.exe".into()],
        );
        assert_eq!(rules.classify(r"C:\Apps\webex.exe"), CallType::Other);
        assert_eq!(rules.classify("zoom.exe"), CallType::Zoom);
        // Teams is no longer listed, so it is just "other".
        assert_eq!(rules.classify("ms-teams.exe"), CallType::Other);
        assert!(rules.is_ignored(r"C:\Apps\softphone.exe"));
        assert!(!rules.is_ignored("ace dialer.exe"));
        assert_eq!(Rules::builtin().classify("teams.exe"), CallType::Teams);
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
