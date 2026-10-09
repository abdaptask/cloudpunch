//! The person's shift (ADR-0031): fetched with the policy, it decides
//! when the clock-in popup asks. Pure window maths plus the two calls.
//!
//! - The window is the shift's start to end in the shift's own zone, on
//!   its weekdays. An end at or before the start is the next day, and an
//!   overnight shift belongs to the day it started.
//! - The popup opens at the start, never early; "Not now" and a
//!   mid-shift clock-out bring it back after [`SNOOZE`]; "Not working
//!   today" silences it until the next shift.

use std::time::{Duration, SystemTime};

use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::Value;

use crate::days::DayError;

/// "Not now", or a clock-out mid-shift: ask again after this.
pub const SNOOZE: Duration = Duration::from_secs(5 * 60);

/// `GET /v1/me/shift`'s `shift`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Shift {
    /// ISO weekdays, 1 = Monday … 7 = Sunday.
    pub days: Vec<u8>,
    /// `HH:MM`.
    pub start: String,
    pub end: String,
    pub tz_iana: String,
}

/// One shift's window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShiftWindow {
    /// The date it starts on, in the shift's zone.
    pub date: NaiveDate,
    pub start: SystemTime,
    pub end: SystemTime,
}

/// What the app knows about the shift: the pattern, the shift date
/// the person said "Not working today" for, if any, and the company
/// holidays coming up (ADR-0037 §2: no popups on them).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShiftInfo {
    pub shift: Option<Shift>,
    pub not_working_on: Option<NaiveDate>,
    pub holidays: Vec<NaiveDate>,
}

fn at(date: NaiveDate, hhmm: &str, tz: Tz) -> Option<SystemTime> {
    let t = NaiveTime::parse_from_str(hhmm, "%H:%M").ok()?;
    // A time skipped by daylight saving takes the later reading.
    let local = tz.from_local_datetime(&date.and_time(t));
    let dt = local.earliest().or_else(|| local.latest())?;
    Some(dt.with_timezone(&Utc).into())
}

/// The window of the shift that starts on `date`, if it is a shift day.
pub fn window_on(shift: &Shift, date: NaiveDate) -> Option<ShiftWindow> {
    let tz: Tz = shift.tz_iana.parse().ok()?;
    let weekday = date.weekday().number_from_monday() as u8;
    if !shift.days.contains(&weekday) {
        return None;
    }
    let end_date = if shift.end <= shift.start {
        date.succ_opt()?
    } else {
        date
    };
    Some(ShiftWindow {
        date,
        start: at(date, &shift.start, tz)?,
        end: at(end_date, &shift.end, tz)?,
    })
}

/// The window `now` is in (yesterday's overnight shift included), or None.
pub fn active_window(shift: &Shift, now: SystemTime) -> Option<ShiftWindow> {
    let tz: Tz = shift.tz_iana.parse().ok()?;
    let today = DateTime::<Utc>::from(now).with_timezone(&tz).date_naive();
    [today.pred_opt()?, today]
        .into_iter()
        .filter_map(|d| window_on(shift, d))
        .find(|w| w.start <= now && now < w.end)
}

/// `GET /v1/me/shift`.
pub fn fetch(http: &Client, base: &str, token: &str) -> Result<ShiftInfo, DayError> {
    let body = get(http, base, token)?;
    let shift = serde_json::from_value::<Option<Shift>>(body["shift"].clone())
        .ok()
        .flatten();
    let not_working_on = if body["not_working"].as_bool() == Some(true) {
        body["window"]["date"]
            .as_str()
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
    } else {
        None
    };
    // Older servers don't send it: no holidays.
    let holidays = body["holidays"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|h| h["date"].as_str())
                .filter_map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
                .collect()
        })
        .unwrap_or_default();
    Ok(ShiftInfo {
        shift,
        not_working_on,
        holidays,
    })
}

/// `POST /v1/me/not-working-today`: the shift date it was recorded for.
pub fn declare_not_working(http: &Client, base: &str, token: &str) -> Result<NaiveDate, DayError> {
    let resp = http
        .post(format!(
            "{}/v1/me/not-working-today",
            base.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({}))
        .send()
        .map_err(|e| DayError::Unavailable(format!("http error: {e}")))?;
    let body = answer(resp)?;
    body["date"]
        .as_str()
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .ok_or_else(|| DayError::Unavailable("malformed answer".into()))
}

fn get(http: &Client, base: &str, token: &str) -> Result<Value, DayError> {
    let resp = http
        .get(format!("{}/v1/me/shift", base.trim_end_matches('/')))
        .bearer_auth(token)
        .send()
        .map_err(|e| DayError::Unavailable(format!("http error: {e}")))?;
    answer(resp)
}

fn answer(resp: reqwest::blocking::Response) -> Result<Value, DayError> {
    let status = resp.status();
    let body: Value = resp.json().unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    match status.as_u16() {
        401 | 429 => Err(DayError::Unavailable(format!("HTTP {}", status.as_u16()))),
        400..=499 => Err(DayError::Refused(
            body["code"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("http_{}", status.as_u16())),
        )),
        s => Err(DayError::Unavailable(format!("HTTP {s}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> SystemTime {
        DateTime::parse_from_rfc3339(s)
            .unwrap()
            .with_timezone(&Utc)
            .into()
    }

    fn shift(start: &str, end: &str, tz: &str) -> Shift {
        Shift {
            days: vec![1, 2, 3, 4, 5],
            start: start.into(),
            end: end.into(),
            tz_iana: tz.into(),
        }
    }

    #[test]
    fn opens_at_the_start_in_the_shift_zone_on_shift_days() {
        let s = shift("08:00", "17:00", "America/New_York");
        assert_eq!(active_window(&s, utc("2026-10-05T11:59:00Z")), None);
        let w = active_window(&s, utc("2026-10-05T12:00:00Z")).unwrap();
        assert_eq!(w.date, NaiveDate::from_ymd_opt(2026, 10, 5).unwrap());
        assert_eq!(w.end, utc("2026-10-05T21:00:00Z"));
        // After US clocks go back, 08:00 Eastern is 13:00 UTC.
        assert_eq!(active_window(&s, utc("2026-12-07T12:30:00Z")), None);
        assert!(active_window(&s, utc("2026-12-07T13:00:00Z")).is_some());
        // Saturday.
        assert_eq!(active_window(&s, utc("2026-10-10T14:00:00Z")), None);
    }

    #[test]
    fn an_ist_shift_starts_at_its_own_noon() {
        let s = shift("12:00", "21:00", "Asia/Kolkata");
        assert_eq!(active_window(&s, utc("2026-10-05T06:29:00Z")), None);
        assert!(active_window(&s, utc("2026-10-05T06:30:00Z")).is_some());
    }

    #[test]
    fn an_overnight_shift_belongs_to_the_day_it_started() {
        let s = shift("17:30", "02:30", "Asia/Kolkata");
        // Sat 10 Oct, 01:00 IST: Friday's shift.
        let w = active_window(&s, utc("2026-10-09T19:30:00Z")).unwrap();
        assert_eq!(w.date, NaiveDate::from_ymd_opt(2026, 10, 9).unwrap());
        assert_eq!(w.end, utc("2026-10-09T21:00:00Z"));
    }

    #[test]
    fn a_bad_zone_or_time_means_no_window() {
        assert_eq!(
            active_window(
                &shift("08:00", "17:00", "Mars/Base"),
                utc("2026-10-05T14:00:00Z")
            ),
            None
        );
        assert_eq!(
            active_window(&shift("8am", "17:00", "UTC"), utc("2026-10-05T14:00:00Z")),
            None
        );
    }
}
