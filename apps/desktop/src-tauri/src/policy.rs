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
use serde::Deserialize;
use serde_json::Value;

use crate::call_type::{CallType, Rules};
use crate::machine::{AwayReason, CoreConfig, PromptResponse};
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
    pub prompt_options: Vec<String>,
    pub call_type_apps: Vec<CallApp>,
    pub call_type_ignored: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CallApp {
    pub process: String,
    pub call_type: String,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(default)]
pub struct Breaks {
    pub bio: BreakCap,
    pub meal: MealCap,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct BreakCap {
    pub max_minutes: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct MealCap {
    pub max_minutes: u64,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(default)]
pub struct Away {
    pub require_note: RequireNote,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct RequireNote {
    pub working_away: bool,
    pub phone_call: bool,
    pub meeting: bool,
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
}

// Schema defaults (packages/policy-schema/idle-policy.schema.json).

impl Default for Idle {
    fn default() -> Self {
        Self {
            threshold_seconds: 300,
            grace_seconds: 30,
            suppress_prompt_when_media_active: true,
            media_state_debounce_seconds: 5,
            max_silent_call_minutes: Some(30),
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
        }
    }
}

impl Default for BreakCap {
    fn default() -> Self {
        Self { max_minutes: 10 }
    }
}

impl Default for MealCap {
    fn default() -> Self {
        Self { max_minutes: 60 }
    }
}

impl Default for RequireNote {
    fn default() -> Self {
        Self {
            working_away: true,
            phone_call: false,
            meeting: false,
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
        CoreConfig {
            idle_threshold: Duration::from_secs(self.idle.threshold_seconds),
            grace: Duration::from_secs(self.idle.grace_seconds),
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
        }
    }

    /// Nudges and quiet hours (applied immediately).
    pub fn reminder_config(&self) -> ReminderConfig {
        let d = ReminderConfig::default();
        ReminderConfig {
            on_clock_every: Duration::from_secs(self.reminders.on_clock_minutes * 60),
            bio_cap: Duration::from_secs(self.breaks.bio.max_minutes * 60),
            meal_cap: Duration::from_secs(self.breaks.meal.max_minutes * 60),
            long_shift: Duration::from_secs(self.reminders.long_shift_hours * 3600),
            long_shift_repeat: Duration::from_secs(self.reminders.long_shift_repeat_hours * 3600),
            quiet_start: minutes_of_day(&self.notifications.quiet_hours_start)
                .unwrap_or(d.quiet_start),
            quiet_end: minutes_of_day(&self.notifications.quiet_hours_end).unwrap_or(d.quiet_end),
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
                "threshold_seconds": 300, "grace_seconds": 30,
                "suppress_prompt_when_media_active": true,
                "media_state_debounce_seconds": 5, "max_silent_call_minutes": 30,
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
            "reminders": { "on_clock_minutes": 60 }
        }));
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
