//! Policy on the desktop (ADR-0015 §5–§7).
//!
//! The backend serves the employee's effective policy at
//! `GET /v1/me/policy` as `{version, policy}`. This module parses the
//! settings the agent acts on, maps them onto [`CoreConfig`],
//! [`ReminderConfig`] and the call-app [`Rules`], and fetches with
//! `If-None-Match` so the 15-minute poll is usually a `304`.
//!
//! Anything missing or unreadable falls back to the schema default, and
//! the defaults here equal the compiled-in ones (a test pins that), so a
//! desktop with no policy behaves exactly as before.

use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::call_type::{CallType, Rules};
use crate::machine::{AwayReason, BreakKind, CoreConfig, PromptResponse};
use crate::reminders::ReminderConfig;

/// How often a signed-in agent re-fetches.
pub const REFRESH_EVERY: Duration = Duration::from_secs(15 * 60);

/// The part of the policy document the desktop uses. Unknown settings
/// are ignored; missing ones take the schema default.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(default)]
pub struct PolicyDoc {
    pub idle: Idle,
    #[serde(rename = "break")]
    pub breaks: Breaks,
    pub away: Away,
    pub notifications: Notifications,
    pub reminders: Reminders,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct Idle {
    pub threshold_seconds: u64,
    pub grace_seconds: u64,
    pub suppress_prompt_when_media_active: bool,
    pub media_state_debounce_seconds: u64,
    /// `null` disables the cap.
    pub max_silent_call_minutes: Option<u64>,
    /// ADR-0018: continuous idle closes the session; `null` disables.
    pub max_idle_minutes: Option<u64>,
    pub prompt_options: Vec<String>,
    pub call_type_apps: Vec<CallApp>,
    pub call_type_ignored: Vec<String>,
    /// ADR-0024: presence check for propped keys and jigglers.
    pub input_pattern_check: InputPatternCheck,
}

/// `idle.input_pattern_check` (ADR-0024 §4). Off until HR turns it on.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct InputPatternCheck {
    pub enabled: bool,
    pub continuous_minutes: u64,
    pub periodic_minutes: u64,
    pub min_gap_seconds: u64,
}

impl Default for InputPatternCheck {
    fn default() -> Self {
        Self {
            enabled: false,
            continuous_minutes: 20,
            periodic_minutes: 10,
            min_gap_seconds: 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CallApp {
    pub process: String,
    pub call_type: String,
}

/// The break catalogue (ADR-0023 §1): one entry per fixed type. Pay
/// rules are applied by the server; the app needs what to offer, what
/// to call it and when to remind.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(from = "RawBreaks")]
pub struct Breaks {
    pub bio: BreakType,
    pub meal: BreakType,
    pub rest: BreakType,
    pub personal: BreakType,
    pub other: BreakType,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BreakType {
    pub enabled: bool,
    pub label: String,
    /// Reminder limit; `None` = no reminder.
    pub max_minutes: Option<u64>,
}

/// As sent: any field may be missing (a partial document) and takes the
/// type's own default.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct RawBreaks {
    bio: RawBreak,
    meal: RawBreak,
    rest: RawBreak,
    personal: RawBreak,
    other: RawBreak,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct RawBreak {
    enabled: Option<bool>,
    label: Option<String>,
    max_minutes: Option<u64>,
}

impl RawBreak {
    fn or(self, enabled: bool, label: &str, max_minutes: Option<u64>) -> BreakType {
        BreakType {
            enabled: self.enabled.unwrap_or(enabled),
            label: self
                .label
                .map(|l| l.trim().chars().take(30).collect::<String>())
                .filter(|l| !l.is_empty())
                .unwrap_or_else(|| label.into()),
            max_minutes: self.max_minutes.or(max_minutes),
        }
    }
}

// Schema defaults (ADR-0023 §1).
impl From<RawBreaks> for Breaks {
    fn from(r: RawBreaks) -> Self {
        Self {
            bio: r.bio.or(true, "Bio break", Some(10)),
            meal: r.meal.or(true, "Meal break", Some(60)),
            rest: r.rest.or(true, "Tea break", Some(15)),
            personal: r.personal.or(true, "Personal", Some(30)),
            other: r.other.or(false, "Other break", None),
        }
    }
}

impl Default for Breaks {
    fn default() -> Self {
        RawBreaks::default().into()
    }
}

impl Breaks {
    pub fn get(&self, kind: BreakKind) -> &BreakType {
        match kind {
            BreakKind::Bio => &self.bio,
            BreakKind::Meal => &self.meal,
            BreakKind::Rest => &self.rest,
            BreakKind::Personal => &self.personal,
            BreakKind::Other => &self.other,
        }
    }

    /// The types the app offers, in menu order. Never empty: the server
    /// refuses a policy with none, and a broken one falls back to Bio
    /// and Meal.
    pub fn offered(&self) -> Vec<BreakOption> {
        let on: Vec<BreakOption> = BreakKind::ALL
            .into_iter()
            .filter(|k| self.get(*k).enabled)
            .map(|k| BreakOption {
                id: k.as_str(),
                label: self.get(k).label.clone(),
                max_minutes: self.get(k).max_minutes,
            })
            .collect();
        if on.is_empty() {
            return Breaks::default().offered();
        }
        on
    }
}

/// One break type as the screens offer it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakOption {
    pub id: &'static str,
    pub label: String,
    pub max_minutes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct Away {
    pub require_note: RequireNote,
    /// Offer Training as an Away reason (ADR-0023 §1).
    pub offer_training: bool,
    /// "Still away?" after this long (ADR-0027 §3).
    pub check_after_minutes: u64,
}

impl Default for Away {
    fn default() -> Self {
        Self {
            require_note: RequireNote::default(),
            offer_training: true,
            check_after_minutes: 60,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct RequireNote {
    pub working_away: bool,
    pub phone_call: bool,
    pub meeting: bool,
    pub training: bool,
    pub other: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct Notifications {
    pub quiet_hours_start: String,
    pub quiet_hours_end: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct Reminders {
    pub on_clock_minutes: u64,
    pub long_shift_hours: u64,
    pub long_shift_repeat_hours: u64,
    /// `null` disables the nudge.
    pub clock_in_nudge_minutes: Option<u64>,
    /// End-of-day summary threshold (ADR-0013 §8).
    pub long_day_hours: u64,
    /// Daily clock-in popup, `HH:MM` in `clock_in_prompt_tz`; `null`
    /// turns it off (ADR-0018 §4).
    pub clock_in_prompt_at: Option<String>,
    pub clock_in_prompt_tz: String,
}

// Schema defaults (packages/policy-schema/idle-policy.schema.json).

impl Default for Idle {
    fn default() -> Self {
        Self {
            threshold_seconds: 120,
            grace_seconds: 30,
            suppress_prompt_when_media_active: true,
            media_state_debounce_seconds: 5,
            max_silent_call_minutes: Some(30),
            max_idle_minutes: Some(120),
            prompt_options: PromptResponse::ALL
                .iter()
                .map(|r| r.as_str().to_string())
                .collect(),
            call_type_apps: Rules::builtin()
                .apps
                .into_iter()
                .map(|(process, t)| CallApp {
                    process,
                    call_type: t.as_str().to_string(),
                })
                .collect(),
            call_type_ignored: Rules::builtin().ignored,
            input_pattern_check: InputPatternCheck::default(),
        }
    }
}

impl Default for RequireNote {
    fn default() -> Self {
        Self {
            working_away: true,
            phone_call: false,
            meeting: false,
            training: false,
            other: true,
        }
    }
}

impl Default for Notifications {
    fn default() -> Self {
        Self {
            quiet_hours_start: "22:00".into(),
            quiet_hours_end: "07:00".into(),
        }
    }
}

impl Default for Reminders {
    fn default() -> Self {
        Self {
            on_clock_minutes: 30,
            long_shift_hours: 9,
            long_shift_repeat_hours: 2,
            clock_in_nudge_minutes: Some(30),
            long_day_hours: 8,
            clock_in_prompt_at: Some("08:00".into()),
            clock_in_prompt_tz: "America/New_York".into(),
        }
    }
}

impl PolicyDoc {
    /// Parse a policy document; anything unreadable becomes the default.
    pub fn from_value(v: &Value) -> Self {
        serde_json::from_value(v.clone()).unwrap_or_default()
    }

    /// What the state machine uses (applied at the next clock-in).
    pub fn core_config(&self) -> CoreConfig {
        let d = CoreConfig::default();
        let options: Vec<PromptResponse> = self
            .idle
            .prompt_options
            .iter()
            .filter_map(|s| PromptResponse::from_wire(s))
            .collect();
        let note = &self.away.require_note;
        let mut note_required_for = Vec::new();
        if note.working_away {
            note_required_for.push(PromptResponse::WorkingAway);
        }
        if note.phone_call {
            note_required_for.push(PromptResponse::OnPhoneCall);
        }
        let mut away_note_required = Vec::new();
        if note.working_away {
            away_note_required.push(AwayReason::WorkingAway);
        }
        if note.phone_call {
            away_note_required.push(AwayReason::PhoneCall);
        }
        if note.meeting {
            away_note_required.push(AwayReason::Meeting);
        }
        if note.training {
            away_note_required.push(AwayReason::Training);
        }
        CoreConfig {
            idle_threshold: Duration::from_secs(self.idle.threshold_seconds),
            grace: Duration::from_secs(self.idle.grace_seconds),
            max_idle: self
                .idle
                .max_idle_minutes
                .map(|m| Duration::from_secs(m * 60)),
            media_off_debounce: Duration::from_secs(self.idle.media_state_debounce_seconds),
            suppress_prompt_when_media_active: self.idle.suppress_prompt_when_media_active,
            max_silent_call: self
                .idle
                .max_silent_call_minutes
                .map(|m| Duration::from_secs(m * 60)),
            // The schema requires at least two; never leave the prompt
            // with fewer because of an unknown option name.
            prompt_options: if options.len() >= 2 {
                options
            } else {
                d.prompt_options
            },
            note_required_for,
            away_note_required,
            input_pattern: {
                let c = &self.idle.input_pattern_check;
                c.enabled.then(|| crate::machine::pattern::PatternConfig {
                    continuous: Duration::from_secs(c.continuous_minutes.max(1) * 60),
                    periodic: Duration::from_secs(c.periodic_minutes.max(1) * 60),
                    min_gap: Duration::from_secs(c.min_gap_seconds.max(1)),
                })
            },
        }
    }

    /// The break types to offer, and whether Training is (ADR-0023).
    pub fn break_menu(&self) -> (Vec<BreakOption>, bool) {
        (self.breaks.offered(), self.away.offer_training)
    }

    /// Nudges and quiet hours (applied immediately).
    pub fn reminder_config(&self) -> ReminderConfig {
        let d = ReminderConfig::default();
        ReminderConfig {
            on_clock_every: Duration::from_secs(self.reminders.on_clock_minutes * 60),
            bio_cap: cap(&self.breaks.bio).unwrap_or(d.bio_cap),
            meal_cap: cap(&self.breaks.meal).unwrap_or(d.meal_cap),
            rest_cap: cap(&self.breaks.rest).unwrap_or(d.rest_cap),
            personal_cap: cap(&self.breaks.personal).unwrap_or(d.personal_cap),
            other_cap: cap(&self.breaks.other),
            away_check: Duration::from_secs(self.away.check_after_minutes.max(1) * 60),
            long_shift: Duration::from_secs(self.reminders.long_shift_hours * 3600),
            long_shift_repeat: Duration::from_secs(self.reminders.long_shift_repeat_hours * 3600),
            quiet_start: minutes_of_day(&self.notifications.quiet_hours_start)
                .unwrap_or(d.quiet_start),
            quiet_end: minutes_of_day(&self.notifications.quiet_hours_end).unwrap_or(d.quiet_end),
            clock_in_nudge: self
                .reminders
                .clock_in_nudge_minutes
                .map(|m| Duration::from_secs(m * 60)),
            long_day: Duration::from_secs(self.reminders.long_day_hours * 3600),
            clock_in_prompt: crate::clock_in_prompt::PromptConfig::from_policy(
                self.reminders.clock_in_prompt_at.as_deref(),
                &self.reminders.clock_in_prompt_tz,
            ),
        }
    }

    /// Which apps count as a call (applied with the core settings).
    pub fn call_rules(&self) -> Rules {
        let apps = self
            .idle
            .call_type_apps
            .iter()
            .filter_map(|a| {
                let t = match a.call_type.as_str() {
                    "teams" => CallType::Teams,
                    "zoom" => CallType::Zoom,
                    "other" => CallType::Other,
                    _ => return None,
                };
                Some((a.process.clone(), t))
            })
            .collect();
        Rules::new(apps, self.idle.call_type_ignored.clone())
    }
}

/// `"HH:MM"` → minutes after midnight.
/// A type's reminder limit.
fn cap(t: &BreakType) -> Option<Duration> {
    t.max_minutes.map(|m| Duration::from_secs(m * 60))
}

fn minutes_of_day(s: &str) -> Option<u16> {
    let (h, m) = s.split_once(':')?;
    let (h, m): (u16, u16) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// A fetched policy: its content version and the raw document (cached
/// as-is so a newer agent can read settings this one ignores).
#[derive(Debug, Clone, PartialEq)]
pub struct Fetched {
    pub version: String,
    pub document: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FetchOutcome {
    /// `304`: the version we sent is still current.
    NotModified,
    Updated(Fetched),
}

#[derive(Debug, Clone, PartialEq)]
pub enum FetchError {
    /// Network, 5xx, 401/429 or an unreadable body: try again later.
    Unavailable(String),
    /// A definite answer that retrying won't change (e.g. `no_employee`).
    Refused(String),
}

/// `GET {base}/v1/me/policy`, sending `If-None-Match` for `known`.
pub fn fetch(
    http: &Client,
    base_url: &str,
    token: &str,
    known: Option<&str>,
) -> Result<FetchOutcome, FetchError> {
    let mut req = http
        .get(format!("{}/v1/me/policy", base_url.trim_end_matches('/')))
        .bearer_auth(token);
    if let Some(v) = known {
        req = req.header("if-none-match", format!("\"{v}\""));
    }
    let resp = req
        .send()
        .map_err(|e| FetchError::Unavailable(format!("http error: {e}")))?;
    let status = resp.status();
    if status == StatusCode::NOT_MODIFIED {
        return Ok(FetchOutcome::NotModified);
    }
    let body: Value = resp.json().unwrap_or(Value::Null);
    if status.is_success() {
        let version = body["version"].as_str().map(str::to_string);
        let document = body.get("policy").cloned();
        return match (version, document) {
            (Some(version), Some(document)) if document.is_object() => {
                Ok(FetchOutcome::Updated(Fetched { version, document }))
            }
            _ => Err(FetchError::Unavailable("malformed policy response".into())),
        };
    }
    let code = body["code"].as_str().unwrap_or("").to_string();
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::TOO_MANY_REQUESTS => {
            Err(FetchError::Unavailable(format!("HTTP {}", status.as_u16())))
        }
        s if s.is_client_error() => Err(FetchError::Refused(format!("HTTP {} {code}", s.as_u16()))),
        s => Err(FetchError::Unavailable(format!("HTTP {}", s.as_u16()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use serde_json::json;

    #[test]
    fn the_default_policy_is_exactly_the_compiled_in_behaviour() {
        let d = PolicyDoc::default();
        assert_eq!(d.core_config(), CoreConfig::default());
        assert_eq!(d.reminder_config(), ReminderConfig::default());
        assert_eq!(d.call_rules(), Rules::builtin());
        // An empty or unreadable document is the default too.
        assert_eq!(PolicyDoc::from_value(&json!({})), d);
        assert_eq!(PolicyDoc::from_value(&json!("nonsense")), d);
    }

    #[test]
    fn the_server_defaults_document_parses_to_the_same() {
        // Shape of GET /v1/me/policy with no overrides (schema defaults).
        let doc = json!({
            "idle": {
                "threshold_seconds": 120, "grace_seconds": 30,
                "suppress_prompt_when_media_active": true,
                "media_state_debounce_seconds": 5, "max_silent_call_minutes": 30,
                "max_idle_minutes": 120,
                "count_as_payable_when_unresponsive": false,
                "prompt_options": ["still_working", "bio_break", "meal_break",
                                   "on_phone_call", "working_away", "end_shift"],
                "call_type_apps": [
                    { "process": "ms-teams.exe", "call_type": "teams" },
                    { "process": "teams.exe", "call_type": "teams" },
                    { "process": "zoom.exe", "call_type": "zoom" }
                ],
                "call_type_ignored": ["ace dialer.exe"]
            },
            "break": { "bio": { "max_minutes": 10, "payable_up_to_cap": true },
                       "meal": { "max_minutes": 60, "payable": false } },
            "away": { "require_note": { "working_away": true, "phone_call": false,
                                        "meeting": false, "other": true } },
            "notifications": { "quiet_hours_start": "22:00", "quiet_hours_end": "07:00",
                               "rate_limit_per_hour": 6 },
            "reminders": { "on_clock_minutes": 30, "long_shift_hours": 9,
                           "long_shift_repeat_hours": 2 },
            "system": { "max_lock_duration_minutes": 120 }
        });
        assert_eq!(PolicyDoc::from_value(&doc), PolicyDoc::default());
    }

    #[test]
    fn adr_0023_break_catalogue_and_training() {
        // Defaults: Bio, Meal, Tea break, Personal offered; Other off.
        let d = PolicyDoc::default();
        let ids: Vec<_> = d.breaks.offered().iter().map(|o| o.id).collect();
        assert_eq!(ids, ["bio", "meal", "rest", "personal"]);
        assert_eq!(d.breaks.rest.label, "Tea break");
        assert!(d.away.offer_training);
        let r = d.reminder_config();
        assert_eq!(r.rest_cap, Duration::from_secs(15 * 60));
        assert_eq!(r.personal_cap, Duration::from_secs(30 * 60));
        assert_eq!(r.other_cap, None);

        // The server's resolved document, renamed and switched.
        let doc = PolicyDoc::from_value(&json!({
            "break": {
                "bio": { "enabled": true, "label": "Bio break", "pay": "paid_up_to_limit", "max_minutes": 10 },
                "meal": { "enabled": false, "label": "Meal break", "pay": "unpaid", "max_minutes": 60 },
                "rest": { "enabled": true, "label": "  Chai break  ", "pay": "paid", "max_minutes": 20 },
                "personal": { "enabled": true, "label": "", "max_minutes": 45 },
                "other": { "enabled": true, "label": "Other break", "max_minutes": null }
            },
            "away": { "offer_training": false, "require_note": { "training": true } }
        }));
        let menu: Vec<_> = doc
            .breaks
            .offered()
            .into_iter()
            .map(|o| (o.id, o.label, o.max_minutes))
            .collect();
        assert_eq!(
            menu,
            [
                ("bio", "Bio break".to_string(), Some(10)),
                ("rest", "Chai break".to_string(), Some(20)),
                ("personal", "Personal".to_string(), Some(45)),
                ("other", "Other break".to_string(), None),
            ],
            "trimmed; a blank name keeps the default"
        );
        assert!(!doc.away.offer_training);
        assert_eq!(doc.reminder_config().rest_cap, Duration::from_secs(20 * 60));
        assert!(doc
            .core_config()
            .away_note_required
            .contains(&AwayReason::Training));

        // Everything off (the server refuses this): Bio and Meal stay.
        let off = json!({ "enabled": false });
        let none = PolicyDoc::from_value(&json!({ "break": {
            "bio": off, "meal": off, "rest": off, "personal": off, "other": off
        }}));
        let ids: Vec<_> = none.breaks.offered().iter().map(|o| o.id).collect();
        assert_eq!(ids, ["bio", "meal", "rest", "personal"]);
    }

    #[test]
    fn overrides_map_onto_the_agent() {
        let doc = PolicyDoc::from_value(&json!({
            "idle": {
                "threshold_seconds": 600, "grace_seconds": 60,
                "max_silent_call_minutes": null,
                "prompt_options": ["still_working", "end_shift", "not_a_thing"],
                "call_type_apps": [{ "process": "webex.exe", "call_type": "other" }],
                "call_type_ignored": []
            },
            "break": { "bio": { "max_minutes": 15 } },
            "away": { "require_note": { "working_away": true, "phone_call": true,
                                        "meeting": true } },
            "notifications": { "quiet_hours_start": "21:30", "quiet_hours_end": "bad" },
            "reminders": { "on_clock_minutes": 60, "long_day_hours": 10 }
        }));
        assert_eq!(
            doc.reminder_config().long_day,
            Duration::from_secs(10 * 3600)
        );
        assert_eq!(
            PolicyDoc::default().reminder_config().long_day,
            Duration::from_secs(8 * 3600),
            "schema default"
        );
        let core = doc.core_config();
        assert_eq!(core.idle_threshold, Duration::from_secs(600));
        assert_eq!(core.grace, Duration::from_secs(60));
        assert_eq!(core.max_silent_call, None, "null disables the cap");
        assert_eq!(
            core.prompt_options,
            [PromptResponse::StillWorking, PromptResponse::EndShift]
        );
        assert_eq!(
            core.note_required_for,
            [PromptResponse::WorkingAway, PromptResponse::OnPhoneCall]
        );
        assert_eq!(
            core.away_note_required,
            [
                AwayReason::WorkingAway,
                AwayReason::PhoneCall,
                AwayReason::Meeting
            ]
        );

        let r = doc.reminder_config();
        assert_eq!(r.bio_cap, Duration::from_secs(15 * 60));
        assert_eq!(r.meal_cap, Duration::from_secs(60 * 60), "default kept");
        assert_eq!(r.on_clock_every, Duration::from_secs(3600));
        assert_eq!(r.quiet_start, 21 * 60 + 30);
        assert_eq!(r.quiet_end, 7 * 60, "unreadable time falls back");

        let rules = doc.call_rules();
        assert_eq!(rules.classify("webex.exe"), CallType::Other);
        assert_eq!(rules.classify("ms-teams.exe"), CallType::Other);
        assert!(!rules.is_ignored("ace dialer.exe"));
    }

    #[test]
    fn too_few_known_prompt_options_keep_the_defaults() {
        let doc =
            PolicyDoc::from_value(&json!({ "idle": { "prompt_options": ["end_shift", "x"] } }));
        assert_eq!(
            doc.core_config().prompt_options,
            CoreConfig::default().prompt_options
        );
    }

    fn client() -> Client {
        Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
    }

    #[test]
    fn fetch_returns_the_policy_then_304_for_the_same_version() {
        let server = MockServer::start();
        let not_modified = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/me/policy")
                .header("if-none-match", "\"sha256-abc\"");
            then.status(304);
        });
        let fresh = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/me/policy")
                .header("authorization", "Bearer tok");
            then.status(200).json_body(json!({
                "version": "sha256-abc",
                "policy": { "idle": { "threshold_seconds": 600 } }
            }));
        });
        let http = client();
        let got = fetch(&http, &server.base_url(), "tok", Some("sha256-abc")).unwrap();
        assert_eq!(got, FetchOutcome::NotModified);
        not_modified.assert();

        let got = fetch(&http, &server.base_url(), "tok", None).unwrap();
        let FetchOutcome::Updated(f) = got else {
            panic!("expected a policy")
        };
        assert_eq!(f.version, "sha256-abc");
        assert_eq!(f.document["idle"]["threshold_seconds"], 600);
        fresh.assert_hits(1);
    }

    #[test]
    fn fetch_errors_are_split_into_retry_and_refused() {
        for (status, retry) in [
            (500, true),
            (503, true),
            (401, true),
            (404, false),
            (403, false),
        ] {
            let server = MockServer::start();
            server.mock(|when, then| {
                when.method(GET).path("/v1/me/policy");
                then.status(status)
                    .json_body(json!({ "code": "no_employee" }));
            });
            let err = fetch(&client(), &server.base_url(), "tok", None).unwrap_err();
            assert_eq!(
                matches!(err, FetchError::Unavailable(_)),
                retry,
                "HTTP {status}: {err:?}"
            );
        }
        assert!(matches!(
            fetch(&client(), "http://127.0.0.1:9", "tok", None),
            Err(FetchError::Unavailable(_))
        ));
    }
}
