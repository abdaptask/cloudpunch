//! When a downloaded update installs (ADR-0022 §2, amended by ADR-0046).
//!
//! - Clocked out for two minutes: it installs by itself. Today's
//!   timeline comes back from its journal after the restart, so a day
//!   already worked no longer holds it back (it did, and updates almost
//!   never installed: ADR-0046 Context).
//! - Clocked in: it never installs on its own, except when the company
//!   pushed the update (`updates.required_by`) and that time has passed:
//!   then a 5-minute notice, then "update and clock back in" (clock out,
//!   install, clock in on the new version). A session is never carried
//!   across a restart.
//! - The person can always choose sooner (update and clock in, clock out
//!   and update, update and shut down); that is the commands' business.
//!
//! Pure logic: the Tauri updater plugin downloads and installs.

use std::time::{Duration, SystemTime};

/// Clocked out this long before an update installs by itself.
pub const CLOCKED_OUT_FOR: Duration = Duration::from_secs(2 * 60);
/// The notice before a pushed update clocks someone out and back in.
pub const NOTICE: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy)]
pub struct UpdateInputs {
    pub now: SystemTime,
    pub clocked_out: bool,
    /// Since when clocked out (the app's start, if it started so).
    pub clocked_out_since: Option<SystemTime>,
    /// A pushed update's deadline (ADR-0046 §3).
    pub required_by: Option<SystemTime>,
}

/// What to do with a downloaded update now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateAction {
    /// Clocked out: install and restart, quietly.
    Install(String),
    /// A pushed update is overdue while clocked in: say so; it happens
    /// at the end of the notice.
    Notice(String),
    /// The notice ran out: clock out, install, clock back in.
    UpdateAndClockBackIn(String),
}

#[derive(Debug, Clone, Default)]
pub struct UpdateState {
    /// A downloaded update's version, waiting to install.
    ready: Option<String>,
    /// The version an install was last started for: once per run, so a
    /// failing install can't loop.
    tried: Option<String>,
    /// The last reason logged for waiting, so the log says it once.
    logged_wait: Option<(String, &'static str)>,
    /// When a pushed update's notice runs out.
    notice_until: Option<SystemTime>,
}

impl UpdateState {
    /// The updater has downloaded `version` and verified its signature.
    pub fn set_ready(&mut self, version: String) {
        self.ready = Some(version);
    }

    pub fn ready(&self) -> Option<&str> {
        self.ready.as_deref()
    }

    /// When a pushed update will clock this person out and back in.
    pub fn notice_until(&self) -> Option<SystemTime> {
        self.notice_until
    }

    /// The person updated (or chose to): nothing more to do this run.
    pub fn mark_tried(&mut self) {
        self.tried = self.ready.clone();
        self.notice_until = None;
    }
}

/// Whether a push's deadline has passed: "Clock in now" is no longer offered.
pub fn overdue(inp: &UpdateInputs) -> bool {
    inp.required_by.is_some_and(|by| inp.now >= by)
}

/// Why a downloaded update isn't installing now (`None`: it can, or
/// the notice handles it).
fn wait_reason(inp: &UpdateInputs) -> Option<&'static str> {
    if inp.clocked_out {
        let long_enough = inp.clocked_out_since.is_some_and(|since| {
            inp.now
                .duration_since(since)
                .is_ok_and(|d| d >= CLOCKED_OUT_FOR)
        });
        return (!long_enough).then_some("just clocked out");
    }
    (!overdue(inp)).then_some("clocked in")
}

/// What to do now, if anything; installing marks the version tried.
pub fn decide(st: &mut UpdateState, inp: UpdateInputs) -> Option<UpdateAction> {
    let version = st.ready.clone()?;
    if st.tried.as_ref() == Some(&version) {
        return None;
    }
    if inp.clocked_out {
        st.notice_until = None;
        if wait_reason(&inp).is_some() {
            return None;
        }
        st.tried = Some(version.clone());
        return Some(UpdateAction::Install(version));
    }
    if !overdue(&inp) {
        st.notice_until = None;
        return None;
    }
    match st.notice_until {
        None => {
            st.notice_until = Some(inp.now + NOTICE);
            Some(UpdateAction::Notice(version))
        }
        Some(until) if inp.now >= until => {
            st.tried = Some(version.clone());
            st.notice_until = None;
            Some(UpdateAction::UpdateAndClockBackIn(version))
        }
        Some(_) => None,
    }
}

/// A line for the update log when the reason a downloaded update waits
/// changes (once per version and reason, not every tick).
pub fn wait_note(st: &mut UpdateState, inp: UpdateInputs) -> Option<String> {
    let version = st.ready.clone()?;
    if st.tried.as_ref() == Some(&version) {
        return None;
    }
    let reason = wait_reason(&inp)?;
    let key = (version.clone(), reason);
    if st.logged_wait.as_ref() == Some(&key) {
        return None;
    }
    st.logged_wait = Some(key);
    Some(format!("update {version} waits: {reason}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: Duration = Duration::from_secs(60);

    fn ready() -> (UpdateState, UpdateInputs) {
        let now = SystemTime::UNIX_EPOCH + 1000 * 60 * MIN;
        let mut st = UpdateState::default();
        st.set_ready("0.1.2".into());
        let inp = UpdateInputs {
            now,
            clocked_out: true,
            clocked_out_since: Some(now - 3 * MIN),
            required_by: None,
        };
        (st, inp)
    }

    #[test]
    fn clocked_out_for_two_minutes_it_installs_once_whatever_was_worked() {
        let (mut st, inp) = ready();
        assert_eq!(
            decide(&mut st, inp),
            Some(UpdateAction::Install("0.1.2".into()))
        );
        assert_eq!(decide(&mut st, inp), None, "once per run");
        st.set_ready("0.1.3".into());
        assert_eq!(
            decide(&mut st, inp),
            Some(UpdateAction::Install("0.1.3".into()))
        );
    }

    #[test]
    fn just_clocked_out_it_waits_and_says_why_once() {
        let (mut st, inp) = ready();
        let just = UpdateInputs {
            clocked_out_since: Some(inp.now - MIN),
            ..inp
        };
        assert_eq!(decide(&mut st, just), None);
        assert_eq!(
            wait_note(&mut st, just).as_deref(),
            Some("update 0.1.2 waits: just clocked out")
        );
        assert_eq!(wait_note(&mut st, just), None);
    }

    #[test]
    fn clocked_in_never_unless_a_push_is_overdue_then_notice_then_clock_back_in() {
        let (mut st, inp) = ready();
        let working = UpdateInputs {
            clocked_out: false,
            clocked_out_since: None,
            ..inp
        };
        assert_eq!(decide(&mut st, working), None);
        assert_eq!(
            wait_note(&mut st, working).as_deref(),
            Some("update 0.1.2 waits: clocked in")
        );
        // Pushed, not yet due.
        let pushed = UpdateInputs {
            required_by: Some(inp.now + 60 * MIN),
            ..working
        };
        assert_eq!(decide(&mut st, pushed), None);
        assert!(!overdue(&pushed));
        // Due: a notice first, nothing more for five minutes, then the update.
        let due = UpdateInputs {
            required_by: Some(inp.now - MIN),
            ..working
        };
        assert!(overdue(&due));
        assert_eq!(
            decide(&mut st, due),
            Some(UpdateAction::Notice("0.1.2".into()))
        );
        assert_eq!(st.notice_until(), Some(inp.now + NOTICE));
        let later = UpdateInputs {
            now: inp.now + 4 * MIN,
            ..due
        };
        assert_eq!(decide(&mut st, later), None);
        let end = UpdateInputs {
            now: inp.now + NOTICE,
            ..due
        };
        assert_eq!(
            decide(&mut st, end),
            Some(UpdateAction::UpdateAndClockBackIn("0.1.2".into()))
        );
        assert_eq!(decide(&mut st, end), None, "once");
    }

    #[test]
    fn clocking_out_during_the_notice_installs_quietly_instead() {
        let (mut st, inp) = ready();
        let due = UpdateInputs {
            clocked_out: false,
            clocked_out_since: None,
            required_by: Some(inp.now - MIN),
            ..inp
        };
        assert!(matches!(
            decide(&mut st, due),
            Some(UpdateAction::Notice(_))
        ));
        assert!(st.notice_until().is_some());
        let out = UpdateInputs {
            now: inp.now + 3 * MIN,
            clocked_out: true,
            clocked_out_since: Some(inp.now),
            ..due
        };
        assert_eq!(
            decide(&mut st, out),
            Some(UpdateAction::Install("0.1.2".into()))
        );
        assert_eq!(st.notice_until(), None);
    }

    #[test]
    fn nothing_downloaded_nothing_to_do() {
        let (_, inp) = ready();
        let mut st = UpdateState::default();
        assert_eq!(decide(&mut st, inp), None);
        assert_eq!(wait_note(&mut st, inp), None);
    }
}
