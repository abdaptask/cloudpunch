//! HR / Administrator settings (ADR-0018 §5): read and write policy
//! overrides through the existing admin API (ADR-0015 §4). The server
//! checks every call against the token's roles (invariant 6); the
//! screen is only shown to those roles as a convenience.

use reqwest::blocking::Client;
use serde_json::Value;

use crate::days::DayError;

/// Which override the settings screen edits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    /// Company-wide (Administrator).
    Global,
    /// One department (HR or Administrator).
    Department(String),
}

impl Scope {
    /// From the webview's `("global" | "department", id)`.
    pub fn parse(scope: &str, id: Option<&str>) -> Option<Self> {
        match (scope, id) {
            ("global", None) => Some(Scope::Global),
            ("department", Some(id)) if is_uuid(id) => Some(Scope::Department(id.to_string())),
            _ => None,
        }
    }

    fn path(&self) -> String {
        match self {
            Scope::Global => "/v1/admin/policy/global".to_string(),
            Scope::Department(id) => format!("/v1/admin/policy/departments/{id}"),
        }
    }
}

/// `8-4-4-4-12` hex: the id goes into the URL path.
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `GET /v1/me`'s `capabilities`, to decide whether to offer Settings.
pub fn capabilities(http: &Client, base: &str, token: &str) -> Result<Value, DayError> {
    let me = send(http, base, token, reqwest::Method::GET, "/v1/me", None)?;
    Ok(me
        .get("capabilities")
        .cloned()
        .unwrap_or(Value::Array(vec![])))
}

pub fn departments(http: &Client, base: &str, token: &str) -> Result<Value, DayError> {
    send(
        http,
        base,
        token,
        reqwest::Method::GET,
        "/v1/admin/departments",
        None,
    )
}

pub fn get_policy(
    http: &Client,
    base: &str,
    token: &str,
    scope: &Scope,
) -> Result<Value, DayError> {
    send(http, base, token, reqwest::Method::GET, &scope.path(), None)
}

pub fn put_policy(
    http: &Client,
    base: &str,
    token: &str,
    scope: &Scope,
    document: &Value,
    reason: Option<&str>,
) -> Result<Value, DayError> {
    let mut body = serde_json::json!({ "document": document });
    if let Some(r) = reason.map(str::trim).filter(|r| !r.is_empty()) {
        body["reason"] = Value::String(r.to_string());
    }
    send(
        http,
        base,
        token,
        reqwest::Method::PUT,
        &scope.path(),
        Some(&body),
    )
}

/// People (ADR-0020): everyone with a CloudPunch role.
pub fn people(http: &Client, base: &str, token: &str) -> Result<Value, DayError> {
    send(
        http,
        base,
        token,
        reqwest::Method::GET,
        "/v1/admin/people",
        None,
    )
}

/// People: search the company directory.
pub fn people_search(http: &Client, base: &str, token: &str, q: &str) -> Result<Value, DayError> {
    let q: String = url::form_urlencoded::byte_serialize(q.as_bytes()).collect();
    let path = format!("/v1/admin/people/search?q={q}");
    send(http, base, token, reqwest::Method::GET, &path, None)
}

/// People: set exactly these roles for `oid` (an Entra object id).
pub fn people_set_roles(
    http: &Client,
    base: &str,
    token: &str,
    oid: &str,
    roles: &[String],
    reason: Option<&str>,
) -> Result<Value, DayError> {
    if !is_uuid(oid) {
        return Err(DayError::Refused("invalid_argument".into()));
    }
    let mut body = serde_json::json!({ "roles": roles });
    if let Some(r) = reason.map(str::trim).filter(|r| !r.is_empty()) {
        body["reason"] = Value::String(r.to_string());
    }
    let path = format!("/v1/admin/people/{oid}/roles");
    send(http, base, token, reqwest::Method::PUT, &path, Some(&body))
}

/// Welcome email (ADR-0021): what would be sent to `oid`.
pub fn welcome_preview(
    http: &Client,
    base: &str,
    token: &str,
    oid: &str,
) -> Result<Value, DayError> {
    if !is_uuid(oid) {
        return Err(DayError::Refused("invalid_argument".into()));
    }
    let path = format!("/v1/admin/people/{oid}/welcome");
    send(http, base, token, reqwest::Method::GET, &path, None)
}

/// Welcome email: send it, with an optional personal note.
pub fn welcome_send(
    http: &Client,
    base: &str,
    token: &str,
    oid: &str,
    note: Option<&str>,
) -> Result<Value, DayError> {
    if !is_uuid(oid) {
        return Err(DayError::Refused("invalid_argument".into()));
    }
    let mut body = serde_json::json!({});
    if let Some(n) = note.map(str::trim).filter(|n| !n.is_empty()) {
        body["note"] = Value::String(n.to_string());
    }
    let path = format!("/v1/admin/people/{oid}/welcome");
    send(http, base, token, reqwest::Method::POST, &path, Some(&body))
}

/// `YYYY-MM-DD`: the date goes into the URL.
fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

// Team views (ADR-0025). The server checks the caller's scope on every
// call: a Manager sees direct reports, HR everyone.

/// Team today: each person's status now.
pub fn team_now(http: &Client, base: &str, token: &str) -> Result<Value, DayError> {
    send(http, base, token, reqwest::Method::GET, "/v1/team", None)
}

/// One person's working day. Audited server-side.
pub fn team_day(
    http: &Client,
    base: &str,
    token: &str,
    employee_id: &str,
    date: &str,
) -> Result<Value, DayError> {
    if !is_uuid(employee_id) || !is_date(date) {
        return Err(DayError::Refused("invalid_argument".into()));
    }
    let path = format!("/v1/team/{employee_id}/days/{date}");
    send(http, base, token, reqwest::Method::GET, &path, None)
}

/// Exceptions over `[from, to]`, for everyone in scope or one person.
pub fn team_exceptions(
    http: &Client,
    base: &str,
    token: &str,
    from: &str,
    to: &str,
    employee_id: Option<&str>,
) -> Result<Value, DayError> {
    if !is_date(from) || !is_date(to) || employee_id.is_some_and(|e| !is_uuid(e)) {
        return Err(DayError::Refused("invalid_argument".into()));
    }
    let mut path = format!("/v1/team/exceptions?from={from}&to={to}");
    if let Some(e) = employee_id {
        path.push_str(&format!("&employee_id={e}"));
    }
    send(http, base, token, reqwest::Method::GET, &path, None)
}

// Shifts (ADR-0031 §1): Administrators only; the server checks.

/// Everyone's current shift.
pub fn shifts(http: &Client, base: &str, token: &str) -> Result<Value, DayError> {
    send(
        http,
        base,
        token,
        reqwest::Method::GET,
        "/v1/admin/shifts",
        None,
    )
}

/// Set someone's shift (`days` empty clears it).
pub fn set_shift(
    http: &Client,
    base: &str,
    token: &str,
    employee_id: &str,
    shift: &Value,
) -> Result<Value, DayError> {
    if !is_uuid(employee_id) {
        return Err(DayError::Refused("invalid_argument".into()));
    }
    send(
        http,
        base,
        token,
        reqwest::Method::PUT,
        &format!("/v1/admin/employees/{employee_id}/shift"),
        Some(shift),
    )
}

// Time corrections (ADR-0030 §3). The server decides who may do what:
// anyone for their own time, a manager for a direct report (endorsed),
// an Administrator approves what others asked and endorsed.

/// What a correction asks for; times are ISO 8601 with an offset.
pub struct CorrectionRequest<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub tz_iana: &'a str,
    pub kind: &'a str,
    pub reason: &'a str,
}

/// Ask to correct your own time (`employee_id` None), or, as their
/// manager, correct a report's.
pub fn request_correction(
    http: &Client,
    base: &str,
    token: &str,
    employee_id: Option<&str>,
    c: &CorrectionRequest<'_>,
) -> Result<Value, DayError> {
    let path = match employee_id {
        None => "/v1/me/corrections".to_string(),
        Some(e) if is_uuid(e) => format!("/v1/team/{e}/corrections"),
        Some(_) => return Err(DayError::Refused("invalid_argument".into())),
    };
    let body = serde_json::json!({
        "from": c.from,
        "to": c.to,
        "tz_iana": c.tz_iana,
        "kind": c.kind,
        "reason": c.reason,
    });
    send(http, base, token, reqwest::Method::POST, &path, Some(&body))
}

/// What waits on the caller: `{ to_endorse, to_approve }`.
pub fn corrections_queue(http: &Client, base: &str, token: &str) -> Result<Value, DayError> {
    send(
        http,
        base,
        token,
        reqwest::Method::GET,
        "/v1/corrections/queue",
        None,
    )
}

/// Endorse, approve, reject or withdraw a correction.
pub fn decide_correction(
    http: &Client,
    base: &str,
    token: &str,
    id: &str,
    decision: &str,
    note: Option<&str>,
) -> Result<Value, DayError> {
    if !is_uuid(id) || !matches!(decision, "endorse" | "approve" | "reject" | "withdraw") {
        return Err(DayError::Refused("invalid_argument".into()));
    }
    let mut body = serde_json::json!({ "decision": decision });
    if let Some(n) = note.map(str::trim).filter(|n| !n.is_empty()) {
        body["note"] = Value::String(n.to_string());
    }
    send(
        http,
        base,
        token,
        reqwest::Method::POST,
        &format!("/v1/corrections/{id}/decision"),
        Some(&body),
    )
}

// Connection location (ADR-0029 §5). The server decides who sees whom:
// an Administrator everyone, a Manager direct reports, never HR.

/// Your own connection history, last 30 days.
pub fn my_connections(http: &Client, base: &str, token: &str) -> Result<Value, DayError> {
    send(
        http,
        base,
        token,
        reqwest::Method::GET,
        "/v1/me/connections",
        None,
    )
}

/// Each person's latest connection (the Team list). Audited server-side.
pub fn team_connections(http: &Client, base: &str, token: &str) -> Result<Value, DayError> {
    send(
        http,
        base,
        token,
        reqwest::Method::GET,
        "/v1/team/connections",
        None,
    )
}

/// One person's connection history. Audited server-side.
pub fn person_connections(
    http: &Client,
    base: &str,
    token: &str,
    employee_id: &str,
) -> Result<Value, DayError> {
    if !is_uuid(employee_id) {
        return Err(DayError::Refused("invalid_argument".into()));
    }
    let path = format!("/v1/team/{employee_id}/connections");
    send(http, base, token, reqwest::Method::GET, &path, None)
}

/// Everyone, with their reporting manager (People).
pub fn employees(http: &Client, base: &str, token: &str) -> Result<Value, DayError> {
    send(
        http,
        base,
        token,
        reqwest::Method::GET,
        "/v1/admin/employees",
        None,
    )
}

/// Set or clear someone's manager. Audited server-side.
pub fn set_manager(
    http: &Client,
    base: &str,
    token: &str,
    employee_id: &str,
    manager_id: Option<&str>,
    reason: Option<&str>,
) -> Result<Value, DayError> {
    if !is_uuid(employee_id) || manager_id.is_some_and(|m| !is_uuid(m)) {
        return Err(DayError::Refused("invalid_argument".into()));
    }
    let mut body = serde_json::json!({ "manager_employee_id": manager_id });
    if let Some(r) = reason.map(str::trim).filter(|r| !r.is_empty()) {
        body["reason"] = Value::String(r.to_string());
    }
    let path = format!("/v1/admin/employees/{employee_id}/manager");
    send(http, base, token, reqwest::Method::PUT, &path, Some(&body))
}

/// Every enrolled device, with its owner and the version it runs.
pub fn devices(http: &Client, base: &str, token: &str) -> Result<Value, DayError> {
    send(
        http,
        base,
        token,
        reqwest::Method::GET,
        "/v1/admin/devices",
        None,
    )
}

/// Administrators (ADR-0028 §4): the computer `employee_id` is clocked
/// in on, or `null` (204) when none.
pub fn active_device(
    http: &Client,
    base: &str,
    token: &str,
    employee_id: &str,
) -> Result<Value, DayError> {
    if !is_uuid(employee_id) {
        return Err(DayError::Refused("invalid_argument".into()));
    }
    let path = format!("/v1/people/{employee_id}/active-device");
    send(http, base, token, reqwest::Method::GET, &path, None)
}

/// Administrators: close that session at its last activity and sign
/// the computer out. Audited server-side.
pub fn sign_out_device(
    http: &Client,
    base: &str,
    token: &str,
    employee_id: &str,
    device_id: &str,
) -> Result<Value, DayError> {
    if !is_uuid(employee_id) || !is_uuid(device_id) {
        return Err(DayError::Refused("invalid_argument".into()));
    }
    let body = serde_json::json!({ "device_id": device_id });
    let path = format!("/v1/people/{employee_id}/active-device/sign-out");
    send(http, base, token, reqwest::Method::POST, &path, Some(&body))
}

/// One signed-in call. 401/429/5xx and network trouble are
/// `Unavailable`; other 4xx carry the server's `code`.
fn send(
    http: &Client,
    base: &str,
    token: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, DayError> {
    let mut req = http
        .request(method, format!("{}{path}", base.trim_end_matches('/')))
        .bearer_auth(token);
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req
        .send()
        .map_err(|e| DayError::Unavailable(format!("http error: {e}")))?;
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
    use httpmock::prelude::*;
    use serde_json::json;
    use std::time::Duration;

    fn client() -> Client {
        Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
    }

    #[test]
    fn correction_calls_refuse_bad_ids_and_decisions_before_sending() {
        let http = client();
        let bad = |r: Result<Value, DayError>| matches!(r, Err(DayError::Refused(c)) if c == "invalid_argument");
        let id = "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
        let c = CorrectionRequest {
            from: "2026-10-05T17:30:00+05:30",
            to: "2026-10-06T01:30:00+05:30",
            tz_iana: "Asia/Kolkata",
            kind: "working",
            reason: "not recorded",
        };
        let base = "http://127.0.0.1:9";
        assert!(bad(request_correction(
            &http,
            base,
            "t",
            Some("x/../y"),
            &c
        )));
        assert!(bad(decide_correction(
            &http, base, "t", "x/../y", "approve", None
        )));
        assert!(bad(decide_correction(&http, base, "t", id, "delete", None)));
    }

    #[test]
    fn person_connections_refuses_a_bad_id_before_sending() {
        let http = client();
        let r = person_connections(&http, "http://127.0.0.1:9", "t", "x/../y");
        assert!(matches!(r, Err(DayError::Refused(c)) if c == "invalid_argument"));
    }

    #[test]
    fn team_calls_refuse_bad_ids_and_dates_before_sending() {
        let http = client();
        let bad = |r: Result<Value, DayError>| matches!(r, Err(DayError::Refused(c)) if c == "invalid_argument");
        let id = "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
        assert!(bad(team_day(
            &http,
            "http://127.0.0.1:9",
            "t",
            "x/../y",
            "2026-09-29"
        )));
        assert!(bad(team_day(
            &http,
            "http://127.0.0.1:9",
            "t",
            id,
            "2026-9-29"
        )));
        assert!(bad(team_exceptions(
            &http,
            "http://127.0.0.1:9",
            "t",
            "2026-09-01",
            "today",
            None
        )));
        assert!(bad(set_manager(
            &http,
            "http://127.0.0.1:9",
            "t",
            id,
            Some("nope"),
            None
        )));
    }

    #[test]
    fn set_manager_sends_the_id_or_null_and_a_trimmed_reason() {
        let server = MockServer::start();
        let id = "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
        let m = "11111111-1111-4111-8111-111111111111";
        let set = server.mock(|when, then| {
            when.method(PUT)
                .path(format!("/v1/admin/employees/{id}/manager"))
                .json_body(json!({ "manager_employee_id": m, "reason": "new team" }));
            then.status(200)
                .json_body(json!({ "id": id, "reporting_manager_id": m }));
        });
        set_manager(
            &client(),
            &server.base_url(),
            "t",
            id,
            Some(m),
            Some("  new team "),
        )
        .unwrap();
        set.assert();
        let clear = server.mock(|when, then| {
            when.method(PUT)
                .path(format!("/v1/admin/employees/{id}/manager"))
                .json_body(json!({ "manager_employee_id": null }));
            then.status(200)
                .json_body(json!({ "id": id, "reporting_manager_id": null }));
        });
        set_manager(&client(), &server.base_url(), "t", id, None, None).unwrap();
        clear.assert();
    }

    #[test]
    fn scopes_accept_only_global_or_a_department_uuid() {
        assert_eq!(Scope::parse("global", None), Some(Scope::Global));
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert_eq!(
            Scope::parse("department", Some(id)),
            Some(Scope::Department(id.into()))
        );
        for (s, i) in [
            ("department", Some("../global")),
            ("department", None),
            ("global", Some(id)),
            ("employee", Some(id)),
        ] {
            assert_eq!(Scope::parse(s, i), None, "{s} {i:?}");
        }
    }

    #[test]
    fn put_sends_the_document_and_reason_with_the_token() {
        let server = MockServer::start();
        let m = server.mock(|when, then| {
            when.method(PUT)
                .path("/v1/admin/policy/global")
                .header("authorization", "Bearer tok")
                .json_body(json!({
                    "document": { "idle": { "threshold_seconds": 180 } },
                    "reason": "pilot"
                }));
            then.status(200).json_body(json!({ "scope": "global" }));
        });
        let doc = json!({ "idle": { "threshold_seconds": 180 } });
        let got = put_policy(
            &client(),
            &server.base_url(),
            "tok",
            &Scope::Global,
            &doc,
            Some(" pilot "),
        );
        assert_eq!(got.unwrap()["scope"], "global");
        m.assert();
    }

    #[test]
    fn people_search_encodes_the_query_and_set_roles_checks_the_id() {
        let server = MockServer::start();
        let m = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/admin/people/search")
                .query_param("q", "far heen&x=1");
            then.status(200).json_body(json!({ "users": [] }));
        });
        people_search(&client(), &server.base_url(), "tok", "far heen&x=1").unwrap();
        m.assert();
        assert_eq!(
            people_set_roles(&client(), &server.base_url(), "tok", "../x", &[], None),
            Err(DayError::Refused("invalid_argument".into()))
        );
    }

    #[test]
    fn active_device_reads_the_machine_or_none_and_sign_out_names_it() {
        let emp = "0f8fad5b-d9cb-469f-a165-70867728950e";
        let dev = "33333333-3333-4333-8333-333333333333";
        let server = MockServer::start();
        let get = server.mock(|when, then| {
            when.method(GET)
                .path(format!("/v1/people/{emp}/active-device"))
                .header("authorization", "Bearer tok");
            then.status(200).json_body(json!({
                "device_id": dev, "os": "windows",
                "enrolled_at": "2026-09-01T04:00:00Z",
                "opened_at": "2026-09-30T03:32:00Z",
                "last_event_at": "2026-09-30T08:10:00Z"
            }));
        });
        let got = active_device(&client(), &server.base_url(), "tok", emp).unwrap();
        assert_eq!(got["os"], "windows");
        get.assert();

        let post = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/v1/people/{emp}/active-device/sign-out"))
                .json_body(json!({ "device_id": dev }));
            then.status(200)
                .json_body(json!({ "closed_at": "2026-09-30T08:10:00Z" }));
        });
        let done = sign_out_device(&client(), &server.base_url(), "tok", emp, dev).unwrap();
        assert_eq!(done["closed_at"], "2026-09-30T08:10:00Z");
        post.assert();

        let none = MockServer::start();
        none.mock(|when, then| {
            when.method(GET);
            then.status(204);
        });
        assert_eq!(
            active_device(&client(), &none.base_url(), "tok", emp),
            Ok(Value::Null)
        );

        let refused = MockServer::start();
        refused.mock(|when, then| {
            when.method(POST);
            then.status(403).json_body(json!({ "code": "forbidden" }));
        });
        assert_eq!(
            sign_out_device(&client(), &refused.base_url(), "tok", emp, dev),
            Err(DayError::Refused("forbidden".into()))
        );
        assert_eq!(
            sign_out_device(&client(), &refused.base_url(), "tok", emp, "../x"),
            Err(DayError::Refused("invalid_argument".into()))
        );
        assert_eq!(
            active_device(&client(), &refused.base_url(), "tok", "x"),
            Err(DayError::Refused("invalid_argument".into()))
        );
    }

    #[test]
    fn a_refusal_carries_the_server_code() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(PUT);
            then.status(403).json_body(json!({ "code": "forbidden" }));
        });
        let err = put_policy(
            &client(),
            &server.base_url(),
            "tok",
            &Scope::Global,
            &json!({}),
            None,
        )
        .unwrap_err();
        assert_eq!(err, DayError::Refused("forbidden".into()));
    }
}
