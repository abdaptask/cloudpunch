//! When a downloaded update may install (ADR-0022 §2).
//!
//! The app always comes back clocked out after a restart, so an update
//! installs only when that costs nothing: clocked out, nothing tracked
//! yet in the current working day, and the person has just signed in to,
//! unlocked or woken the computer (or the app has just started). That's
//! normally first thing in the morning. Clocked in means never.
//!
//! Pure logic: the Tauri updater plugin downloads and installs.

use std::time::{Duration, SystemTime};

/// "Just signed in" or "just started": the moment an update may take.
pub const JUST_SIGNED_IN: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Copy)]
pub struct UpdateInputs {
    pub now: SystemTime,
    pub clocked_out: bool,
    /// Anything tracked in the current working day (ADR-0016 §1).
    pub worked_today: bool,
    /// The daily clock-in popup is open (ADR-0018 §4): don't pull it
    /// away from someone reading it.
    pub clock_in_prompt_open: bool,
    /// Latest Windows logon / unlock / wake.
    pub signed_in_at: Option<SystemTime>,
    /// When this run of the app started.
    pub started_at: SystemTime,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateState {
    /// A downloaded update's version, waiting to install.
    ready: Option<String>,
    /// The version an install was last started for: once per run, so a
    /// failing install can't loop.
    tried: Option<String>,
}

impl UpdateState {
    /// The updater has downloaded `version` and verified its signature.
    pub fn set_ready(&mut self, version: String) {
        self.ready = Some(version);
    }

    pub fn ready(&self) -> Option<&str> {
        self.ready.as_deref()
    }
}

fn recent(at: SystemTime, now: SystemTime) -> bool {
    now.duration_since(at)
        .is_ok_and(|ago| ago <= JUST_SIGNED_IN)
}

/// The version to install now, if this is the moment; marks it tried.
pub fn install_now(st: &mut UpdateState, inp: UpdateInputs) -> Option<String> {
    let version = st.ready.clone()?;
    if st.tried.as_ref() == Some(&version)
        || !inp.clocked_out
        || inp.worked_today
        || inp.clock_in_prompt_open
    {
        return None;
    }
    let moment =
        inp.signed_in_at.is_some_and(|at| recent(at, inp.now)) || recent(inp.started_at, inp.now);
    if !moment {
        return None;
    }
    st.tried = Some(version.clone());
    Some(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: Duration = Duration::from_secs(3600);

    fn morning() -> (UpdateState, UpdateInputs) {
        let now = SystemTime::UNIX_EPOCH + 1000 * HOUR;
        let mut st = UpdateState::default();
        st.set_ready("0.1.2".into());
        let inp = UpdateInputs {
            now,
            clocked_out: true,
            worked_today: false,
            clock_in_prompt_open: false,
            signed_in_at: Some(now - Duration::from_secs(60)),
            started_at: now - 20 * HOUR,
        };
        (st, inp)
    }

    #[test]
    fn installs_just_after_the_first_sign_in_of_the_day_once() {
        let (mut st, inp) = morning();
        assert_eq!(install_now(&mut st, inp).as_deref(), Some("0.1.2"));
        assert_eq!(install_now(&mut st, inp), None, "once per run");
        // A newer download is a new chance.
        st.set_ready("0.1.3".into());
        assert_eq!(install_now(&mut st, inp).as_deref(), Some("0.1.3"));
    }

    #[test]
    fn never_while_clocked_in_or_after_work_today() {
        let (mut st, inp) = morning();
        let clocked_in = UpdateInputs {
            clocked_out: false,
            ..inp
        };
        assert_eq!(install_now(&mut st, clocked_in), None);
        let worked = UpdateInputs {
            worked_today: true,
            ..inp
        };
        assert_eq!(install_now(&mut st, worked), None, "lunch unlock waits");
        let prompt = UpdateInputs {
            clock_in_prompt_open: true,
            ..inp
        };
        assert_eq!(install_now(&mut st, prompt), None);
        // None of those used up the attempt.
        assert_eq!(install_now(&mut st, inp).as_deref(), Some("0.1.2"));
    }

    #[test]
    fn only_just_after_a_sign_in_or_start() {
        let (mut st, inp) = morning();
        let long_ago = UpdateInputs {
            signed_in_at: Some(inp.now - JUST_SIGNED_IN - Duration::from_secs(1)),
            ..inp
        };
        assert_eq!(install_now(&mut st, long_ago), None);
        let never = UpdateInputs {
            signed_in_at: None,
            ..inp
        };
        assert_eq!(install_now(&mut st, never), None);
        let just_started = UpdateInputs {
            started_at: inp.now - Duration::from_secs(120),
            ..long_ago
        };
        assert_eq!(install_now(&mut st, just_started).as_deref(), Some("0.1.2"));
    }

    #[test]
    fn nothing_without_a_downloaded_update() {
        let (_, inp) = morning();
        assert_eq!(install_now(&mut UpdateState::default(), inp), None);
    }
}
