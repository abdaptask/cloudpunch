//! When to remind the user they're on the clock (ADR-0013).
//!
//! Pure: [`due`] looks at the core state, the current segment, window
//! visibility, and the local time of day, and returns the reminders to
//! show now. It remembers what it already fired in [`ReminderState`].
//! Delivery (notifications, the long-shift banner) is the agent's job.

use std::time::{Duration, SystemTime};

use crate::machine::{BreakKind, CoreState};

#[derive(Debug, Clone, PartialEq)]
pub struct ReminderConfig {
    /// `reminders.on_clock_minutes`.
    pub on_clock_every: Duration,
    /// `break.bio.max_minutes`.
    pub bio_cap: Duration,
    /// `break.meal.max_minutes`.
    pub meal_cap: Duration,
    /// `reminders.long_shift_hours`.
    pub long_shift: Duration,
    /// `reminders.long_shift_repeat_hours`.
    pub long_shift_repeat: Duration,
    /// `notifications.quiet_hours_start` / `_end`, minutes after local
    /// midnight. Start > end means the window wraps midnight.
    pub quiet_start: u16,
    pub quiet_end: u16,
    /// "Ready to clock in?" cadence; None disables (ADR-0013 §7).
    pub clock_in_nudge: Option<Duration>,
}

impl Default for ReminderConfig {
    fn default() -> Self {
        Self {
            on_clock_every: Duration::from_secs(30 * 60),
            bio_cap: Duration::from_secs(10 * 60),
            meal_cap: Duration::from_secs(60 * 60),
            long_shift: Duration::from_secs(9 * 3600),
            long_shift_repeat: Duration::from_secs(2 * 3600),
            quiet_start: 22 * 60,
            quiet_end: 7 * 60,
            clock_in_nudge: Some(Duration::from_secs(30 * 60)),
        }
    }
}

impl ReminderConfig {
    pub fn is_quiet(&self, minute_of_day: u16) -> bool {
        if self.quiet_start <= self.quiet_end {
            (self.quiet_start..self.quiet_end).contains(&minute_of_day)
        } else {
            minute_of_day >= self.quiet_start || minute_of_day < self.quiet_end
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reminder {
    /// "You're on the clock — 2h 30m this session."
    OnTheClock { elapsed: Duration },
    /// "Still on your bio break? (12 min)"
    BreakOverCap { kind: BreakKind, elapsed: Duration },
    /// "You've been clocked in for 9 hours — still working?"
    LongShift { elapsed: Duration },
    /// Signed in, using the computer, but not clocked in yet today.
    NotClockedIn,
}

/// What the scheduler needs to know right now.
#[derive(Debug, Clone, Copy)]
pub struct Inputs {
    pub now: SystemTime,
    pub state: CoreState,
    /// Clock-in time of the open session.
    pub session_started_at: Option<SystemTime>,
    /// Start of the current timeline segment (for break length).
    pub segment_started_at: Option<SystemTime>,
    pub window_visible: bool,
    /// Local minutes after midnight.
    pub minute_of_day: u16,
}

/// What has already fired.
#[derive(Debug, Clone, Default)]
pub struct ReminderState {
    last_on_clock: Option<SystemTime>,
    nudged_break: Option<SystemTime>,
    long_shift_next: Option<SystemTime>,
    session: Option<SystemTime>,
}

impl ReminderState {
    /// "Still working" on the long-shift banner: ask again later.
    pub fn ack_long_shift(&mut self, now: SystemTime, cfg: &ReminderConfig) {
        self.long_shift_next = Some(now + cfg.long_shift_repeat);
    }
}

fn since(from: SystemTime, now: SystemTime) -> Duration {
    now.duration_since(from).unwrap_or(Duration::ZERO)
}

/// Reminders to show now; updates `st` so each fires once.
pub fn due(cfg: &ReminderConfig, inp: Inputs, st: &mut ReminderState) -> Vec<Reminder> {
    let mut out = Vec::new();
    let Some(session_start) = inp.session_started_at else {
        *st = ReminderState::default();
        return out;
    };
    if st.session != Some(session_start) {
        *st = ReminderState {
            session: Some(session_start),
            long_shift_next: Some(session_start + cfg.long_shift),
            ..ReminderState::default()
        };
    }
    let quiet = cfg.is_quiet(inp.minute_of_day);
    let elapsed = since(session_start, inp.now);

    // Long shift: not muted by quiet hours (a forgotten overnight
    // clock-in is what it's for).
    if st.long_shift_next.is_some_and(|at| inp.now >= at) {
        out.push(Reminder::LongShift { elapsed });
        st.long_shift_next = None; // until acknowledged
    }

    match inp.state {
        CoreState::Active => {
            let from = st.last_on_clock.unwrap_or(session_start);
            if !inp.window_visible && !quiet && since(from, inp.now) >= cfg.on_clock_every {
                out.push(Reminder::OnTheClock { elapsed });
                st.last_on_clock = Some(inp.now);
            }
        }
        CoreState::OnBreak { kind } => {
            let cap = match kind {
                BreakKind::Bio => Some(cfg.bio_cap),
                BreakKind::Meal => Some(cfg.meal_cap),
                BreakKind::Other => None,
            };
            if let (Some(cap), Some(start)) = (cap, inp.segment_started_at) {
                let len = since(start, inp.now);
                if len >= cap && st.nudged_break != Some(start) && !quiet {
                    out.push(Reminder::BreakOverCap { kind, elapsed: len });
                    st.nudged_break = Some(start);
                }
            }
        }
        // On a call: wait until it ends (no pop-ups over meetings).
        // Prompt showing: the prompt is the reminder. Away: tagged.
        _ => {}
    }
    out
}

/// What the clock-in nudge needs to know (ADR-0013 §7).
#[derive(Debug, Clone, Copy)]
pub struct NudgeInputs {
    pub now: SystemTime,
    /// Signed in and enrolled: a clock-in would be recorded.
    pub ready: bool,
    pub clocked_out: bool,
    /// Any time tracked today already. Once someone has clocked in and
    /// out today, a nudge would nag about a finished day.
    pub worked_today: bool,
    pub last_input_at: SystemTime,
    pub window_visible: bool,
    pub minute_of_day: u16,
}

/// Using the computer means input within this long.
const ACTIVE_WITHIN: Duration = Duration::from_secs(5 * 60);
/// Let start-up (silent sign-in, enrollment) settle before the first nudge.
const FIRST_NUDGE_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Default)]
pub struct NudgeState {
    /// When the nudge conditions first held (this stretch).
    since: Option<SystemTime>,
    last: Option<SystemTime>,
}

/// "Ready to clock in?" if it's due now; updates `st`.
pub fn clock_in_nudge(
    cfg: &ReminderConfig,
    inp: NudgeInputs,
    st: &mut NudgeState,
) -> Option<Reminder> {
    let every = cfg.clock_in_nudge?;
    if !inp.ready || !inp.clocked_out || inp.worked_today {
        *st = NudgeState::default();
        return None;
    }
    let active = since(inp.last_input_at, inp.now) <= ACTIVE_WITHIN;
    if !active || cfg.is_quiet(inp.minute_of_day) {
        return None;
    }
    let first = *st.since.get_or_insert(inp.now);
    let due_at = match st.last {
        Some(last) => last + every,
        None => first + FIRST_NUDGE_AFTER,
    };
    // With the window open, its Clock in button already asks.
    if inp.now < due_at || inp.window_visible {
        return None;
    }
    st.last = Some(inp.now);
    Some(Reminder::NotClockedIn)
}

/// Local minutes after midnight, from the OS clock and time zone.
#[cfg(target_os = "windows")]
pub fn local_minute_of_day() -> u16 {
    // SAFETY: no arguments; returns a SYSTEMTIME by value.
    let st = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    st.wHour * 60 + st.wMinute
}

/// No local-time source off Windows until macOS parity (2b.8): UTC.
#[cfg(not(target_os = "windows"))]
pub fn local_minute_of_day() -> u16 {
    let secs = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    ((secs / 60) % (24 * 60)) as u16
}

/// "2h 30m" / "45m".
pub fn short_duration(d: Duration) -> String {
    let m = d.as_secs() / 60;
    if m >= 60 {
        format!("{}h {:02}m", m / 60, m % 60)
    } else {
        format!("{m}m")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn t(min: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_790_000_000 + min * 60)
    }

    fn inp(state: CoreState, now_min: u64) -> Inputs {
        Inputs {
            now: t(now_min),
            state,
            session_started_at: Some(t(0)),
            segment_started_at: Some(t(0)),
            window_visible: false,
            minute_of_day: 12 * 60,
        }
    }

    #[test]
    fn on_the_clock_every_30_minutes_while_hidden() {
        let cfg = ReminderConfig::default();
        let mut st = ReminderState::default();
        assert!(due(&cfg, inp(CoreState::Active, 29), &mut st).is_empty());
        assert_eq!(
            due(&cfg, inp(CoreState::Active, 30), &mut st),
            [Reminder::OnTheClock {
                elapsed: Duration::from_secs(30 * 60)
            }]
        );
        assert!(due(&cfg, inp(CoreState::Active, 31), &mut st).is_empty());
        assert_eq!(due(&cfg, inp(CoreState::Active, 60), &mut st).len(), 1);
    }

    #[test]
    fn no_reminder_while_window_visible_on_a_call_or_prompting() {
        let cfg = ReminderConfig::default();
        let mut st = ReminderState::default();
        let mut visible = inp(CoreState::Active, 45);
        visible.window_visible = true;
        assert!(due(&cfg, visible, &mut st).is_empty());
        assert!(due(&cfg, inp(CoreState::OnCall, 50), &mut st).is_empty());
        let prompting = CoreState::IdlePending {
            shown_at: t(50),
            deadline: t(51),
        };
        assert!(due(&cfg, inp(prompting, 51), &mut st).is_empty());
        // Call over and window hidden: the overdue reminder fires now.
        assert_eq!(due(&cfg, inp(CoreState::Active, 55), &mut st).len(), 1);
    }

    #[test]
    fn quiet_hours_mute_on_the_clock_and_break_nudges() {
        let cfg = ReminderConfig::default();
        let mut st = ReminderState::default();
        let mut night = inp(CoreState::Active, 40);
        night.minute_of_day = 23 * 60;
        assert!(due(&cfg, night, &mut st).is_empty());
        assert!(cfg.is_quiet(6 * 60 + 59));
        assert!(!cfg.is_quiet(7 * 60));
        assert!(cfg.is_quiet(22 * 60));
    }

    #[test]
    fn break_over_cap_nudges_once_per_break() {
        let cfg = ReminderConfig::default();
        let mut st = ReminderState::default();
        let bio = CoreState::OnBreak {
            kind: BreakKind::Bio,
        };
        let mut i = inp(bio, 9);
        i.segment_started_at = Some(t(0));
        assert!(due(&cfg, i, &mut st).is_empty());
        i.now = t(12);
        assert_eq!(
            due(&cfg, i, &mut st),
            [Reminder::BreakOverCap {
                kind: BreakKind::Bio,
                elapsed: Duration::from_secs(12 * 60)
            }]
        );
        i.now = t(20);
        assert!(due(&cfg, i, &mut st).is_empty(), "once per break");
        // A new bio break later nudges again.
        i.segment_started_at = Some(t(100));
        i.now = t(111);
        assert_eq!(due(&cfg, i, &mut st).len(), 1);
    }

    #[test]
    fn meal_cap_is_an_hour_and_other_breaks_never_nudge() {
        let cfg = ReminderConfig::default();
        let mut st = ReminderState::default();
        let meal = CoreState::OnBreak {
            kind: BreakKind::Meal,
        };
        assert!(due(&cfg, inp(meal, 59), &mut st).is_empty());
        assert_eq!(due(&cfg, inp(meal, 60), &mut st).len(), 1);
        let other = CoreState::OnBreak {
            kind: BreakKind::Other,
        };
        let mut st = ReminderState::default();
        assert!(due(&cfg, inp(other, 500), &mut st)
            .iter()
            .all(|r| !matches!(r, Reminder::BreakOverCap { .. })));
    }

    #[test]
    fn long_shift_at_9h_even_in_quiet_hours_then_every_2h_after_ack() {
        let cfg = ReminderConfig::default();
        let mut st = ReminderState::default();
        let mut i = inp(CoreState::OnCall, 539);
        i.minute_of_day = 2 * 60; // 2 a.m.
        assert!(due(&cfg, i, &mut st).is_empty());
        i.now = t(540);
        assert_eq!(
            due(&cfg, i, &mut st),
            [Reminder::LongShift {
                elapsed: Duration::from_secs(9 * 3600)
            }]
        );
        i.now = t(600);
        assert!(due(&cfg, i, &mut st).is_empty(), "waits for an answer");
        st.ack_long_shift(t(600), &cfg);
        i.now = t(719);
        assert!(due(&cfg, i, &mut st).is_empty());
        i.now = t(720);
        assert_eq!(due(&cfg, i, &mut st).len(), 1);
    }

    #[test]
    fn a_new_session_resets_everything() {
        let cfg = ReminderConfig::default();
        let mut st = ReminderState::default();
        due(&cfg, inp(CoreState::Active, 30), &mut st);
        let mut next = inp(CoreState::Active, 1000);
        next.session_started_at = Some(t(990));
        assert!(
            due(&cfg, next, &mut st).is_empty(),
            "10 min into new session"
        );
        let mut out = inp(CoreState::ClockedOut, 2000);
        out.session_started_at = None;
        assert!(due(&cfg, out, &mut st).is_empty());
    }

    #[test]
    fn short_durations() {
        assert_eq!(short_duration(Duration::from_secs(45 * 60)), "45m");
        assert_eq!(short_duration(Duration::from_secs(150 * 60)), "2h 30m");
    }

    fn nudge_inputs(now: SystemTime) -> NudgeInputs {
        NudgeInputs {
            now,
            ready: true,
            clocked_out: true,
            worked_today: false,
            last_input_at: now,
            window_visible: false,
            minute_of_day: 10 * 60,
        }
    }

    fn at(secs: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_790_000_000 + secs)
    }

    #[test]
    fn clock_in_nudge_after_a_minute_then_every_thirty() {
        let cfg = ReminderConfig::default();
        let mut st = NudgeState::default();
        assert_eq!(clock_in_nudge(&cfg, nudge_inputs(at(0)), &mut st), None);
        assert_eq!(clock_in_nudge(&cfg, nudge_inputs(at(59)), &mut st), None);
        assert_eq!(
            clock_in_nudge(&cfg, nudge_inputs(at(60)), &mut st),
            Some(Reminder::NotClockedIn)
        );
        assert_eq!(clock_in_nudge(&cfg, nudge_inputs(at(600)), &mut st), None);
        assert_eq!(
            clock_in_nudge(&cfg, nudge_inputs(at(60 + 1800)), &mut st),
            Some(Reminder::NotClockedIn)
        );
    }

    #[test]
    fn clock_in_nudge_stays_quiet_when_it_should() {
        let cfg = ReminderConfig::default();
        let quiet = |f: &dyn Fn(&mut NudgeInputs)| {
            let mut st = NudgeState::default();
            let mut first = nudge_inputs(at(0));
            f(&mut first);
            clock_in_nudge(&cfg, first, &mut st);
            let mut later = nudge_inputs(at(120));
            f(&mut later);
            clock_in_nudge(&cfg, later, &mut st)
        };
        assert_eq!(
            quiet(&|i| i.ready = false),
            None,
            "not signed in / enrolled"
        );
        assert_eq!(
            quiet(&|i| i.clocked_out = false),
            None,
            "already clocked in"
        );
        assert_eq!(
            quiet(&|i| i.worked_today = true),
            None,
            "day already worked"
        );
        assert_eq!(
            quiet(&|i| i.window_visible = true),
            None,
            "window already asks"
        );
        assert_eq!(quiet(&|i| i.minute_of_day = 23 * 60), None, "quiet hours");
        assert_eq!(
            quiet(&|i| i.last_input_at = i.now - Duration::from_secs(600)),
            None,
            "not at the computer"
        );
        let off = ReminderConfig {
            clock_in_nudge: None,
            ..ReminderConfig::default()
        };
        let mut st = NudgeState::default();
        clock_in_nudge(&off, nudge_inputs(at(0)), &mut st);
        assert_eq!(
            clock_in_nudge(&off, nudge_inputs(at(120)), &mut st),
            None,
            "disabled"
        );
    }
}
