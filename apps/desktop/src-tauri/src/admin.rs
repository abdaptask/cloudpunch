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
