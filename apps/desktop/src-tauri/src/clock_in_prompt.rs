//! The daily clock-in popup (ADR-0018 §4): at 8:00 in the policy's zone
//! (America/New_York by default, so it follows US daylight saving), the
//! window comes forward for someone who is at the computer, signed in
//! and not clocked in yet, and offers to start from when they signed in
//! to the computer. Never an automatic clock-in.
//!
//! "Signed in to the computer" is the latest of the Windows logon, the
//! last unlock and the last wake from sleep: most people never sign
//! out, they unlock in the morning. Only that timestamp is kept.

use std::time::{Duration, SystemTime};

use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, Utc, Weekday};
use chrono_tz::Tz;

/// ADR-0018 §4 (and backend `MAX_START_BACKDATE_MS`): the furthest back
/// a clock-in may start.
pub const MAX_BACKDATE: Duration = Duration::from_secs(12 * 3600);
/// A sign-in this recent isn't worth offering over "Clock in now".
const MIN_BACKDATE: Duration = Duration::from_secs(60);
/// At the computer means input this recently (as the clock-in nudge).
const AT_COMPUTER_WITHIN: Duration = Duration::from_secs(5 * 60);

/// `reminders.clock_in_prompt_at` / `_tz`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PromptConfig {
    /// Local time in `tz`; `None` turns the popup off.
    pub at: Option<NaiveTime>,
    pub tz: Tz,
}

impl Default for PromptConfig {
    fn default() -> Self {
        Self {
            at: NaiveTime::from_hms_opt(8, 0, 0),
            tz: chrono_tz::America::New_York,
        }
    }
}

impl PromptConfig {
    /// From policy strings; a bad time or zone keeps the default.
    pub fn from_policy(at: Option<&str>, tz: &str) -> Self {
        let d = Self::default();
        Self {
            at: match at {
                None => None,
                Some(s) => NaiveTime::parse_from_str(s, "%H:%M").ok().or(d.at),
            },
            tz: tz.parse().unwrap_or(d.tz),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PromptInputs {
    pub now: SystemTime,
    /// Signed in and enrolled: a clock-in would be recorded.
    pub ready: bool,
    pub clocked_out: bool,
    /// Anything tracked in the current working day (ADR-0016 §1).
    pub worked_today: bool,
    pub last_input_at: SystemTime,
}

#[derive(Debug, Clone, Default)]
pub struct PromptState {
    /// The zone's date the popup last opened for: once a day.
    shown_on: Option<NaiveDate>,
}

/// Why the popup is or isn't due now (ADR-0036 §2: logged on change).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Check {
    Due,
    /// Policy turned the 8:00 popup off.
    Off,
    /// Not signed in, not enrolled, or clocked in on another computer.
    NotReady,
    ClockedIn,
    /// The 8:00 popup: something is already tracked today.
    WorkedToday,
    /// No input for longer than [`AT_COMPUTER_WITHIN`].
    Away,
    Weekend,
    /// The 8:00 popup: before its time today.
    TooEarly,
    /// The 8:00 popup: it already opened today.
    ShownToday,
    /// A shift is set but `now` isn't in it.
    OutsideShift,
    /// "Not working today" for this shift.
    NotWorking,
    /// "Not now", or a clock-out mid-shift.
    Snoozed,
    /// A company holiday (ADR-0037 §2).
    Holiday,
}

impl Check {
    /// For `popup.log`: states only, no content.
    pub fn describe(self) -> &'static str {
        match self {
            Self::Due => "due",
            Self::Off => "waits: turned off by policy",
            Self::NotReady => {
                "waits: not ready (not signed in, not enrolled, or clocked in elsewhere)"
            }
            Self::ClockedIn => "waits: clocked in",
            Self::WorkedToday => "waits: already worked today",
            Self::Away => "waits: away from the computer",
            Self::Weekend => "waits: weekend",
            Self::TooEarly => "waits: before its time",
            Self::ShownToday => "waits: already shown today",
            Self::OutsideShift => "waits: outside the shift",
            Self::NotWorking => "waits: not working today",
            Self::Snoozed => "waits: snoozed",
            Self::Holiday => "waits: holiday",
        }
    }
}

fn at_computer(inp: &PromptInputs) -> bool {
    let idle_for = inp
        .now
        .duration_since(inp.last_input_at)
        .unwrap_or_default();
    idle_for <= AT_COMPUTER_WITHIN
}

/// Whether the popup should open now; marks it shown for the day.
pub fn due(cfg: &PromptConfig, inp: PromptInputs, st: &mut PromptState) -> bool {
    daily_check(cfg, inp, st) == Check::Due
}

/// [`due`], with the reason when it isn't.
pub fn daily_check(cfg: &PromptConfig, inp: PromptInputs, st: &mut PromptState) -> Check {
    let Some(at) = cfg.at else { return Check::Off };
    if !inp.ready {
        return Check::NotReady;
    }
    if !inp.clocked_out {
        return Check::ClockedIn;
    }
    if inp.worked_today {
        return Check::WorkedToday;
    }
    if !at_computer(&inp) {
        return Check::Away;
    }
    let local = DateTime::<Utc>::from(inp.now).with_timezone(&cfg.tz);
    if matches!(local.weekday(), Weekday::Sat | Weekday::Sun) {
        return Check::Weekend;
    }
    if local.time() < at {
        return Check::TooEarly;
    }
    let today = local.date_naive();
    if st.shown_on == Some(today) {
        return Check::ShownToday;
    }
    st.shown_on = Some(today);
    Check::Due
}

/// ADR-0031 §2: with a shift, the popup asks during it, while clocked
/// out and at the computer, unless snoozed ("Not now", or just clocked
/// out) or the person said "Not working today" for this shift. It may
/// ask again later the same day; `worked_today` doesn't stop it.
pub fn shift_due(
    window: Option<crate::shift::ShiftWindow>,
    not_working_on: Option<NaiveDate>,
    snooze_until: Option<SystemTime>,
    inp: PromptInputs,
) -> bool {
    shift_check(window, not_working_on, snooze_until, inp) == Check::Due
}

/// [`shift_due`], with the reason when it isn't.
pub fn shift_check(
    window: Option<crate::shift::ShiftWindow>,
    not_working_on: Option<NaiveDate>,
    snooze_until: Option<SystemTime>,
    inp: PromptInputs,
) -> Check {
    let Some(w) = window else {
        return Check::OutsideShift;
    };
    if !inp.ready {
        return Check::NotReady;
    }
    if !inp.clocked_out {
        return Check::ClockedIn;
    }
    if not_working_on == Some(w.date) {
        return Check::NotWorking;
    }
    if snooze_until.is_some_and(|until| inp.now < until) {
        return Check::Snoozed;
    }
    if !at_computer(&inp) {
        return Check::Away;
    }
    Check::Due
}

/// The start to offer: the sign-in, if it is at least a minute ago, at
/// most 12 hours ago, and after the last session ended.
pub fn offer(
    signed_in_at: Option<SystemTime>,
    now: SystemTime,
    last_session_end: Option<SystemTime>,
) -> Option<SystemTime> {
    let at = signed_in_at?;
    let back = now.duration_since(at).ok()?;
    if back < MIN_BACKDATE || back > MAX_BACKDATE {
        return None;
    }
    if last_session_end.is_some_and(|end| at <= end) {
        return None;
    }
    Some(at)
}

/// Start of this Windows logon session (`WTSSessionInfo.LogonTime`).
#[cfg(target_os = "windows")]
pub fn os_logon_time() -> Option<SystemTime> {
    use windows::core::PWSTR;
    use windows::Win32::System::RemoteDesktop::{
        WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfo, WTSINFOW,
        WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
    };
    let mut buf = PWSTR::null();
    let mut bytes = 0u32;
    // SAFETY: WTS allocates `buf`; it is read once as WTSINFOW when big
    // enough, then freed with WTSFreeMemory.
    unsafe {
        WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            WTS_CURRENT_SESSION,
            WTSSessionInfo,
            &mut buf,
            &mut bytes,
        )
        .ok()?;
        let logon = (bytes as usize >= std::mem::size_of::<WTSINFOW>())
            .then(|| (*(buf.0 as *const WTSINFOW)).LogonTime);
        WTSFreeMemory(buf.0 as *mut core::ffi::c_void);
        filetime_to_system(logon?)
    }
}

/// macOS: when the console user logged in (ADR-0026 §2); unlock and
/// wake count too, from the watcher.
#[cfg(target_os = "macos")]
pub fn os_logon_time() -> Option<SystemTime> {
    crate::macos::console_login_time()
}

/// Other platforms: unknown; unlock and wake still count.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn os_logon_time() -> Option<SystemTime> {
    None
}

/// FILETIME (100 ns since 1601-01-01) to `SystemTime`; 0 means unknown.
pub fn filetime_to_system(ft: i64) -> Option<SystemTime> {
    const UNIX_EPOCH_AS_FILETIME: i64 = 116_444_736_000_000_000;
    let since_unix = ft.checked_sub(UNIX_EPOCH_AS_FILETIME)?;
    if ft <= 0 || since_unix < 0 {
        return None;
    }
    let ns = u64::try_from(since_unix).ok()?.checked_mul(100)?;
    Some(SystemTime::UNIX_EPOCH + Duration::from_nanos(ns))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// A UTC instant for a wall time in New York.
    fn ny(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> SystemTime {
        chrono_tz::America::New_York
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .unwrap()
            .with_timezone(&Utc)
            .into()
    }

    fn inputs(now: SystemTime) -> PromptInputs {
        PromptInputs {
            now,
            ready: true,
            clocked_out: true,
            worked_today: false,
            last_input_at: now,
        }
    }

    fn shift(start: &str, end: &str) -> crate::shift::Shift {
        crate::shift::Shift {
            days: vec![1, 2, 3, 4, 5],
            start: start.into(),
            end: end.into(),
            tz_iana: "America/New_York".into(),
        }
    }

    #[test]
    fn with_a_shift_it_asks_during_it_again_after_not_now_and_after_working() {
        let s = shift("09:00", "17:00");
        let at = |h, m| ny(2026, 9, 28, h, m);
        let w = |now| crate::shift::active_window(&s, now);
        // Never early.
        assert!(!shift_due(w(at(8, 59)), None, None, inputs(at(8, 59))));
        assert!(shift_due(w(at(9, 0)), None, None, inputs(at(9, 0))));
        // "Not now" at 09:00: quiet for five minutes, then asks again.
        let snooze = Some(at(9, 0) + crate::shift::SNOOZE);
        assert!(!shift_due(w(at(9, 4)), None, snooze, inputs(at(9, 4))));
        assert!(shift_due(w(at(9, 5)), None, snooze, inputs(at(9, 5))));
        // Worked earlier today and clocked out: still asks (unlike the daily popup).
        let worked = PromptInputs {
            worked_today: true,
            ..inputs(at(13, 0))
        };
        assert!(shift_due(w(at(13, 0)), None, None, worked));
        // After the shift, or while clocked in: no.
        assert!(!shift_due(w(at(17, 0)), None, None, inputs(at(17, 0))));
        let working = PromptInputs {
            clocked_out: false,
            ..inputs(at(10, 0))
        };
        assert!(!shift_due(w(at(10, 0)), None, None, working));
    }

    #[test]
    fn not_working_today_silences_only_that_shift_and_away_from_the_computer_waits() {
        let s = shift("09:00", "17:00");
        let mon = ny(2026, 9, 28, 10, 0);
        let tue = ny(2026, 9, 29, 10, 0);
        let said = NaiveDate::from_ymd_opt(2026, 9, 28);
        let w = |now| crate::shift::active_window(&s, now);
        assert!(!shift_due(w(mon), said, None, inputs(mon)));
        assert!(shift_due(w(tue), said, None, inputs(tue)));
        let away = PromptInputs {
            last_input_at: tue - Duration::from_secs(6 * 60),
            ..inputs(tue)
        };
        assert!(!shift_due(w(tue), None, None, away));
    }

    #[test]
    fn says_why_it_waits() {
        let s = shift("09:00", "17:00");
        let at = |h, m| ny(2026, 9, 28, h, m);
        let w = |now| crate::shift::active_window(&s, now);
        assert_eq!(
            shift_check(w(at(8, 59)), None, None, inputs(at(8, 59))),
            Check::OutsideShift
        );
        let away = PromptInputs {
            last_input_at: at(9, 0) - Duration::from_secs(6 * 60),
            ..inputs(at(9, 0))
        };
        assert_eq!(shift_check(w(at(9, 0)), None, None, away), Check::Away);
        let signed_out = PromptInputs {
            ready: false,
            ..inputs(at(9, 0))
        };
        assert_eq!(
            shift_check(w(at(9, 0)), None, None, signed_out),
            Check::NotReady
        );
        let snooze = Some(at(9, 5));
        assert_eq!(
            shift_check(w(at(9, 1)), None, snooze, inputs(at(9, 1))),
            Check::Snoozed
        );
        let mon = NaiveDate::from_ymd_opt(2026, 9, 28);
        assert_eq!(
            shift_check(w(at(9, 1)), mon, None, inputs(at(9, 1))),
            Check::NotWorking
        );
        assert_eq!(
            shift_check(w(at(9, 1)), None, None, inputs(at(9, 1))),
            Check::Due
        );

        let cfg = PromptConfig::default();
        let mut st = PromptState::default();
        assert_eq!(
            daily_check(&cfg, inputs(at(7, 59)), &mut st),
            Check::TooEarly
        );
        let worked = PromptInputs {
            worked_today: true,
            ..inputs(at(8, 0))
        };
        assert_eq!(daily_check(&cfg, worked, &mut st), Check::WorkedToday);
        assert_eq!(daily_check(&cfg, inputs(at(8, 0)), &mut st), Check::Due);
        assert_eq!(
            daily_check(&cfg, inputs(at(8, 1)), &mut st),
            Check::ShownToday
        );
        let sat = ny(2026, 10, 3, 8, 30);
        assert_eq!(daily_check(&cfg, inputs(sat), &mut st), Check::Weekend);
    }

    #[test]
    fn opens_at_8_new_york_time_once_a_weekday() {
        let cfg = PromptConfig::default();
        let mut st = PromptState::default();
        // Monday 28 Sep 2026 (EDT): 07:59 no, 08:00 yes, then not again.
        assert!(!due(&cfg, inputs(ny(2026, 9, 28, 7, 59)), &mut st));
        assert!(due(&cfg, inputs(ny(2026, 9, 28, 8, 0)), &mut st));
        assert!(!due(&cfg, inputs(ny(2026, 9, 28, 9, 0)), &mut st));
        // Tuesday: again.
        assert!(due(&cfg, inputs(ny(2026, 9, 29, 8, 30)), &mut st));
        // Saturday: never.
        assert!(!due(&cfg, inputs(ny(2026, 10, 3, 8, 30)), &mut st));
    }

    #[test]
    fn follows_daylight_saving() {
        let cfg = PromptConfig::default();
        // 8:00 EDT in September is 12:00 UTC (17:30 IST) ...
        let sept = ny(2026, 9, 28, 8, 0);
        let utc: DateTime<Utc> = sept.into();
        assert_eq!(utc.format("%H:%M").to_string(), "12:00");
        // ... and 8:00 EST in December is 13:00 UTC (18:30 IST).
        let dec = ny(2026, 12, 7, 8, 0);
        let utc: DateTime<Utc> = dec.into();
        assert_eq!(utc.format("%H:%M").to_string(), "13:00");
        let mut st = PromptState::default();
        assert!(!due(&cfg, inputs(dec - Duration::from_secs(60)), &mut st));
        assert!(due(&cfg, inputs(dec), &mut st));
    }

    #[test]
    fn only_for_someone_at_the_computer_and_not_clocked_in_today() {
        let cfg = PromptConfig::default();
        let now = ny(2026, 9, 28, 8, 10);
        let mut st = PromptState::default();
        let away = PromptInputs {
            last_input_at: now - Duration::from_secs(6 * 60),
            ..inputs(now)
        };
        assert!(!due(&cfg, away, &mut st));
        for blocked in [
            PromptInputs {
                ready: false,
                ..inputs(now)
            },
            PromptInputs {
                clocked_out: false,
                ..inputs(now)
            },
            PromptInputs {
                worked_today: true,
                ..inputs(now)
            },
        ] {
            assert!(!due(&cfg, blocked, &mut st));
        }
        // None of that used up the day.
        assert!(due(&cfg, inputs(now), &mut st));
    }

    #[test]
    fn policy_can_move_or_turn_it_off() {
        let off = PromptConfig::from_policy(None, "America/New_York");
        assert!(!due(
            &off,
            inputs(ny(2026, 9, 28, 9, 0)),
            &mut PromptState::default()
        ));
        let india = PromptConfig::from_policy(Some("09:30"), "Asia/Kolkata");
        assert_eq!(india.at, NaiveTime::from_hms_opt(9, 30, 0));
        assert_eq!(india.tz, chrono_tz::Asia::Kolkata);
        let bad = PromptConfig::from_policy(Some("25:00"), "Mars/Base");
        assert_eq!(bad, PromptConfig::default());
    }

    #[test]
    fn offers_a_sign_in_between_1_minute_and_12_hours_ago_after_the_last_session() {
        let now = ny(2026, 9, 28, 8, 30);
        let min = |m: u64| now - Duration::from_secs(m * 60);
        assert_eq!(offer(Some(min(25)), now, None), Some(min(25)));
        assert_eq!(offer(None, now, None), None);
        assert_eq!(offer(Some(min(0)), now, None), None, "just now");
        assert_eq!(offer(Some(now + Duration::from_secs(60)), now, None), None);
        assert_eq!(offer(Some(min(12 * 60 + 1)), now, None), None, "too early");
        // Signed in before the last session ended: that time is taken.
        assert_eq!(offer(Some(min(25)), now, Some(min(10))), None);
        assert_eq!(offer(Some(min(25)), now, Some(min(40))), Some(min(25)));
    }

    #[test]
    fn filetime_conversion() {
        assert_eq!(filetime_to_system(0), None);
        assert_eq!(
            filetime_to_system(116_444_736_000_000_000),
            Some(SystemTime::UNIX_EPOCH)
        );
        assert_eq!(
            filetime_to_system(116_444_736_000_000_000 + 10_000_000),
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1))
        );
    }
}
