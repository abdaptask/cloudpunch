//! Device enrollment (ADR-0004 §5, 2b.4 F3b).
//!
//! After sign-in (and after the silent start-up restore) the agent:
//!   1. asks `GET /v1/me` who the user is — the `employee.id` goes into
//!      every signed event, `clock_allowed` says whether they may work;
//!   2. loads or creates this user's device id (keystore);
//!   3. registers the device key's public half with
//!      `POST /v1/devices/enroll`.
//!
//! Enrolling on every launch is deliberate: the backend treats the same
//! device id + same user as a key refresh, so a key lost at sign-out or
//! a reinstall heals itself.
//!
//! Offline-first: only a definite answer from the server blocks
//! clock-in (no user, no employee, clocking not allowed, device
//! revoked, device owned by someone else). Network trouble, 5xx, or a
//! backend URL that isn't configured leave clock-in open; the loop in
//! `lib.rs` retries with backoff and events wait in the outbox.
//!
//! `hostname_hash` is `sha256-<hex>` of the lower-cased hostname,
//! unsalted — it lets the server spot the same machine across
//! enrollments, and is guessable for predictable hostnames (noted in
//! the threat model). The hostname itself never leaves the device.

use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::keystore::{KeystoreError, SecretStore, Secrets};

/// Backend base URL, e.g. `https://api.cloudpunch.local` (dev: the VM).
pub const BACKEND_URL_ENV: &str = "CLOUDPUNCH_BACKEND_URL";

#[derive(Debug, Error)]
pub enum EnrollError {
    /// Network error, 5xx, 401/429, or an unreadable response. Retry.
    #[error("backend unavailable: {0}")]
    Unavailable(String),
    /// The Entra user has no CloudPunch user record (403 no_user_for_oid).
    #[error("no CloudPunch user for this account")]
    NoUser,
    #[error("this account is not linked to an employee")]
    NoEmployee,
    #[error("clocking is not allowed for this employee")]
    ClockNotAllowed,
    #[error("this device has been revoked")]
    Revoked,
    /// 409 device_owner_conflict. Device ids are per user, so this
    /// should never happen; surfaced rather than worked around.
    #[error("this device is enrolled to another user")]
    DeviceConflict,
    /// Any other 4xx: the request itself is wrong. Retrying won't help.
    #[error("backend rejected the request: {0}")]
    Rejected(String),
    #[error("could not read the hostname")]
    Hostname,
    #[error(transparent)]
    Keystore(#[from] KeystoreError),
}

impl EnrollError {
    /// Short code for the webview.
    pub fn code(&self) -> &'static str {
        match self {
            EnrollError::Unavailable(_) => "unavailable",
            EnrollError::NoUser => "no_user",
            EnrollError::NoEmployee => "no_employee",
            EnrollError::ClockNotAllowed => "clock_not_allowed",
            EnrollError::Revoked => "device_revoked",
            EnrollError::DeviceConflict => "device_conflict",
            EnrollError::Rejected(_) => "rejected",
            EnrollError::Hostname => "hostname",
            EnrollError::Keystore(_) => "keystore",
        }
    }

    /// Worth trying again later without anyone changing anything.
    pub fn is_transient(&self) -> bool {
        matches!(self, EnrollError::Unavailable(_))
    }
}

/// What F3c's sync loop needs to attribute and send events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub oid: String,
    pub device_id: String,
    pub employee_id: String,
}

/// The request body for `POST /v1/devices/enroll`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EnrollBody {
    pub device_id: String,
    pub os: &'static str,
    pub hostname_hash: String,
    pub public_key_ed25519: String,
    pub app_version: &'static str,
}

/// This build's OS, as the backend names it.
pub const OS: &str = if cfg!(target_os = "macos") {
    "macos"
} else {
    "windows"
};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// `sha256-<64 hex>` of the trimmed, lower-cased hostname.
pub fn hostname_hash(hostname: &str) -> String {
    let digest = Sha256::digest(hostname.trim().to_lowercase().as_bytes());
    format!("sha256-{}", hex::encode(digest))
}

pub struct Enroller<S: SecretStore> {
    secrets: Secrets<S>,
    base_url: String,
    hostname: String,
    http: Client,
}

impl<S: SecretStore> Enroller<S> {
    pub fn new(store: S, base_url: &str, hostname: String) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest Client::builder is infallible for this config");
        Self {
            secrets: Secrets::new(store),
            base_url: base_url.trim_end_matches('/').to_string(),
            hostname,
            http,
        }
    }

    /// Who am I, then enrol this device. Blocking; call off the UI
    /// thread.
    pub fn enroll(&self, oid: &str, access_token: &str) -> Result<Identity, EnrollError> {
        let me = self.me(access_token)?;
        let body = self.body(oid)?;
        let enrolled = self.post_enroll(access_token, &body)?;
        if enrolled.revoked {
            return Err(EnrollError::Revoked);
        }
        let employee = me.employee.ok_or(EnrollError::NoEmployee)?;
        if !me.clock_allowed {
            return Err(EnrollError::ClockNotAllowed);
        }
        Ok(Identity {
            oid: oid.to_string(),
            device_id: body.device_id,
            employee_id: employee.id,
        })
    }

    fn body(&self, oid: &str) -> Result<EnrollBody, EnrollError> {
        let device_id = self.secrets.device_id(oid)?;
        let public = self.secrets.device_key(oid)?.verifying_key();
        Ok(EnrollBody {
            device_id,
            os: OS,
            hostname_hash: hostname_hash(&self.hostname),
            public_key_ed25519: URL_SAFE_NO_PAD.encode(public.as_bytes()),
            app_version: APP_VERSION,
        })
    }

    fn me(&self, token: &str) -> Result<MeResponse, EnrollError> {
        let resp = self
            .http
            .get(format!("{}/v1/me", self.base_url))
            .bearer_auth(token)
            .send();
        let (status, body) = read(resp)?;
        if status.is_success() {
            return serde_json::from_slice(&body)
                .map_err(|e| EnrollError::Unavailable(format!("/v1/me body: {e}")));
        }
        Err(map_error(status, &body))
    }

    fn post_enroll(&self, token: &str, body: &EnrollBody) -> Result<EnrollResponse, EnrollError> {
        let resp = self
            .http
            .post(format!("{}/v1/devices/enroll", self.base_url))
            .bearer_auth(token)
            .json(body)
            .send();
        let (status, bytes) = read(resp)?;
        if status.is_success() {
            let parsed: EnrollResponse = serde_json::from_slice(&bytes)
                .map_err(|e| EnrollError::Unavailable(format!("enroll body: {e}")))?;
            if parsed.device_id != body.device_id {
                return Err(EnrollError::Rejected(
                    "enroll returned another device id".into(),
                ));
            }
            return Ok(parsed);
        }
        Err(map_error(status, &bytes))
    }
}

#[derive(Debug, Deserialize)]
struct MeResponse {
    employee: Option<MeEmployee>,
    clock_allowed: bool,
}

#[derive(Debug, Deserialize)]
struct MeEmployee {
    id: String,
}

#[derive(Debug, Deserialize)]
struct EnrollResponse {
    device_id: String,
    revoked: bool,
}

fn read(
    resp: reqwest::Result<reqwest::blocking::Response>,
) -> Result<(StatusCode, Vec<u8>), EnrollError> {
    let resp = resp.map_err(|e| EnrollError::Unavailable(format!("http error: {e}")))?;
    let status = resp.status();
    let body = resp
        .bytes()
        .map_err(|e| EnrollError::Unavailable(format!("body read error: {e}")))?;
    Ok((status, body.to_vec()))
}

fn map_error(status: StatusCode, body: &[u8]) -> EnrollError {
    let code = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    match (status, code.as_str()) {
        (StatusCode::FORBIDDEN, "no_user_for_oid") => EnrollError::NoUser,
        (StatusCode::CONFLICT, "device_owner_conflict") => EnrollError::DeviceConflict,
        // An expired/refused token or rate limiting: the next attempt
        // gets a fresh token and may well succeed.
        (StatusCode::UNAUTHORIZED | StatusCode::TOO_MANY_REQUESTS, _) => {
            EnrollError::Unavailable(format!("HTTP {}", status.as_u16()))
        }
        (s, _) if s.is_client_error() => EnrollError::Rejected(format!(
            "HTTP {}{}",
            s.as_u16(),
            if code.is_empty() {
                String::new()
            } else {
                format!(" {code}")
            }
        )),
        (s, _) => EnrollError::Unavailable(format!("HTTP {}", s.as_u16())),
    }
}

/// What the webview sees (`cp://enrollment`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentStatus {
    /// `pending` | `enrolled` | `retrying` | `not_configured` | `blocked`
    pub state: &'static str,
    /// Why, for `retrying` and `blocked` (an [`EnrollError::code`]).
    pub code: Option<&'static str>,
}

/// The app's enrollment state, shared by the enrollment thread, the
/// commands, and (F3c) the sync loop.
#[derive(Default)]
pub struct Enrollment {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Bumped on every sign-in/out so a stale enrollment thread stops.
    generation: u64,
    status: Status,
    identity: Option<Identity>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Status {
    #[default]
    Pending,
    Enrolled,
    Retrying(&'static str),
    NotConfigured,
    Blocked(&'static str),
}

impl Enrollment {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> EnrollmentStatus {
        let (state, code) = match self.lock().status {
            Status::Pending => ("pending", None),
            Status::Enrolled => ("enrolled", None),
            Status::Retrying(c) => ("retrying", Some(c)),
            Status::NotConfigured => ("not_configured", None),
            Status::Blocked(c) => ("blocked", Some(c)),
        };
        EnrollmentStatus { state, code }
    }

    /// The enrolled identity, once the server has confirmed it.
    pub fn identity(&self) -> Option<Identity> {
        self.lock().identity.clone()
    }

    /// If the server has said this user may not clock in, why.
    pub fn blocked(&self) -> Option<&'static str> {
        match self.lock().status {
            Status::Blocked(code) => Some(code),
            _ => None,
        }
    }

    /// Forget everything and start a new generation (sign-in, sign-out).
    /// Returns the generation an enrollment attempt should report under.
    pub fn reset(&self) -> u64 {
        let mut g = self.lock();
        g.generation += 1;
        g.status = Status::Pending;
        g.identity = None;
        g.generation
    }

    /// Whether `generation` is still the current one.
    pub fn is_current(&self, generation: u64) -> bool {
        self.lock().generation == generation
    }

    pub fn set_not_configured(&self, generation: u64) {
        self.update(generation, Status::NotConfigured, None);
    }

    /// Record an attempt's outcome. Returns false if the generation is
    /// stale (the user signed out or in again meanwhile) — nothing is
    /// recorded then.
    pub fn record(&self, generation: u64, outcome: &Result<Identity, EnrollError>) -> bool {
        match outcome {
            Ok(id) => self.update(generation, Status::Enrolled, Some(id.clone())),
            Err(e) if e.is_transient() => self.update(generation, Status::Retrying(e.code()), None),
            Err(e) => self.update(generation, Status::Blocked(e.code()), None),
        }
    }

    fn update(&self, generation: u64, status: Status, identity: Option<Identity>) -> bool {
        let mut g = self.lock();
        if g.generation != generation {
            return false;
        }
        g.status = status;
        g.identity = identity;
        true
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Delay before retry `attempt` (0-based): 30 s doubling, capped at
/// 15 minutes.
pub fn retry_delay(attempt: u32) -> Duration {
    let secs = 30u64.saturating_mul(1u64 << attempt.min(5));
    Duration::from_secs(secs.min(15 * 60))
}

/// This machine's hostname, if the OS will say.
#[cfg(target_os = "windows")]
pub fn hostname() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::System::SystemInformation::{
        ComputerNamePhysicalDnsHostname, GetComputerNameExW,
    };
    let mut len: u32 = 0;
    // First call reports the needed length (including the NUL).
    // SAFETY: a null buffer with size 0 is the documented size query.
    let _ = unsafe { GetComputerNameExW(ComputerNamePhysicalDnsHostname, PWSTR::null(), &mut len) };
    if len == 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize];
    // SAFETY: `buf` holds `len` u16s and `len` says so.
    unsafe {
        GetComputerNameExW(
            ComputerNamePhysicalDnsHostname,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    }
    .ok()?;
    let name = String::from_utf16(&buf[..len as usize]).ok()?;
    (!name.trim().is_empty()).then_some(name)
}

/// This machine's hostname, if the OS will say.
#[cfg(target_os = "macos")]
pub fn hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: `buf` is writable for its full length, which we pass.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    let name = std::str::from_utf8(&buf[..end]).ok()?.to_string();
    (!name.trim().is_empty()).then_some(name)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn hostname() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::MemoryStore;
    use httpmock::prelude::*;
    use serde_json::json;
    use std::sync::Arc;

    const OID: &str = "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
    const EMPLOYEE: &str = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

    fn enroller(server: &MockServer) -> Enroller<Arc<MemoryStore>> {
        Enroller::new(
            Arc::new(MemoryStore::default()),
            &server.base_url(),
            "APT-LT-0123".into(),
        )
    }

    fn me_ok(server: &MockServer, clock_allowed: bool, employee: bool) {
        let employee = if employee {
            json!({ "id": EMPLOYEE, "status": "active" })
        } else {
            Value::Null
        };
        server.mock(|when, then| {
            when.method(GET)
                .path("/v1/me")
                .header("authorization", "Bearer tok");
            then.status(200)
                .json_body(json!({ "employee": employee, "clock_allowed": clock_allowed }));
        });
    }

    /// Echo the posted device id back, as the backend does.
    fn enroll_ok(server: &MockServer, revoked: bool) -> httpmock::Mock<'_> {
        server.mock(|when, then| {
            when.method(POST)
                .path("/v1/devices/enroll")
                .header("authorization", "Bearer tok");
            then.status(200).json_body(json!({
                "device_id": "__ECHO__",
                "enrolled_at": "2026-09-25T09:00:00.000Z",
                "revoked": revoked,
            }));
        })
    }

    /// The mock can't echo, so tests pin the device id first.
    fn pin_device_id(e: &Enroller<Arc<MemoryStore>>) {
        e.secrets
            .device_id(OID)
            .map(|_| ())
            .expect("device id created");
    }

    fn enroll_echo(server: &MockServer, e: &Enroller<Arc<MemoryStore>>, revoked: bool) {
        let id = e.secrets.device_id(OID).unwrap();
        server.mock(|when, then| {
            when.method(POST)
                .path("/v1/devices/enroll")
                .header("authorization", "Bearer tok");
            then.status(200).json_body(json!({
                "device_id": id,
                "enrolled_at": "2026-09-25T09:00:00.000Z",
                "revoked": revoked,
            }));
        });
    }

    #[test]
    fn hostname_hash_is_sha256_of_lowercased_name() {
        let h = hostname_hash("  APT-LT-0123 ");
        assert_eq!(h, hostname_hash("apt-lt-0123"));
        assert!(h.starts_with("sha256-"));
        let hex = &h["sha256-".len()..];
        assert_eq!(hex.len(), 64);
        assert!(hex
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        // Known vector: sha256("abc").
        assert_eq!(
            hostname_hash("ABC"),
            "sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn body_matches_the_backend_schema() {
        let server = MockServer::start();
        let e = enroller(&server);
        let body = e.body(OID).unwrap();
        assert!(uuid::Uuid::parse_str(&body.device_id).is_ok());
        assert_eq!(body.os, OS);
        assert_eq!(body.hostname_hash, hostname_hash("APT-LT-0123"));
        // Unpadded base64url of 32 bytes, and it is the device key's.
        assert_eq!(body.public_key_ed25519.len(), 43);
        let key = e.secrets.device_key(OID).unwrap().verifying_key();
        assert_eq!(
            URL_SAFE_NO_PAD.decode(&body.public_key_ed25519).unwrap(),
            key.as_bytes()
        );
        assert_eq!(body.app_version, APP_VERSION);
        // Same device id every time (it's what makes re-enroll a refresh).
        assert_eq!(e.body(OID).unwrap().device_id, body.device_id);
    }

    #[test]
    fn enroll_success_returns_identity() {
        let server = MockServer::start();
        let e = enroller(&server);
        me_ok(&server, true, true);
        enroll_echo(&server, &e, false);
        let id = e.enroll(OID, "tok").unwrap();
        assert_eq!(id.oid, OID);
        assert_eq!(id.employee_id, EMPLOYEE);
        assert_eq!(id.device_id, e.secrets.device_id(OID).unwrap());
    }

    #[test]
    fn enroll_posts_the_body() {
        let server = MockServer::start();
        let e = enroller(&server);
        me_ok(&server, true, true);
        let expected = e.body(OID).unwrap();
        let id = expected.device_id.clone();
        let m = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/devices/enroll")
                .json_body(json!(expected));
            then.status(200).json_body(json!({
                "device_id": id,
                "enrolled_at": "2026-09-25T09:00:00.000Z",
                "revoked": false,
            }));
        });
        e.enroll(OID, "tok").unwrap();
        m.assert();
    }

    #[test]
    fn revoked_device_is_blocked() {
        let server = MockServer::start();
        let e = enroller(&server);
        me_ok(&server, true, true);
        enroll_echo(&server, &e, true);
        assert!(matches!(e.enroll(OID, "tok"), Err(EnrollError::Revoked)));
    }

    #[test]
    fn no_employee_or_clock_not_allowed_is_blocked() {
        let server = MockServer::start();
        let e = enroller(&server);
        me_ok(&server, false, false);
        enroll_echo(&server, &e, false);
        assert!(matches!(e.enroll(OID, "tok"), Err(EnrollError::NoEmployee)));

        let server = MockServer::start();
        let e = enroller(&server);
        me_ok(&server, false, true);
        enroll_echo(&server, &e, false);
        assert!(matches!(
            e.enroll(OID, "tok"),
            Err(EnrollError::ClockNotAllowed)
        ));
    }

    #[test]
    fn unknown_user_is_blocked_before_enrolling() {
        let server = MockServer::start();
        let e = enroller(&server);
        server.mock(|when, then| {
            when.method(GET).path("/v1/me");
            then.status(403)
                .json_body(json!({ "code": "no_user_for_oid", "message": "x" }));
        });
        let enroll = enroll_ok(&server, false);
        assert!(matches!(e.enroll(OID, "tok"), Err(EnrollError::NoUser)));
        enroll.assert_hits(0);
    }

    #[test]
    fn owner_conflict_and_validation_are_permanent() {
        let server = MockServer::start();
        let e = enroller(&server);
        me_ok(&server, true, true);
        server.mock(|when, then| {
            when.method(POST).path("/v1/devices/enroll");
            then.status(409)
                .json_body(json!({ "code": "device_owner_conflict", "message": "x" }));
        });
        let err = e.enroll(OID, "tok").unwrap_err();
        assert!(matches!(err, EnrollError::DeviceConflict));
        assert!(!err.is_transient());

        let server = MockServer::start();
        let e = enroller(&server);
        me_ok(&server, true, true);
        server.mock(|when, then| {
            when.method(POST).path("/v1/devices/enroll");
            then.status(400)
                .json_body(json!({ "code": "validation", "message": "x" }));
        });
        let err = e.enroll(OID, "tok").unwrap_err();
        assert!(matches!(&err, EnrollError::Rejected(m) if m == "HTTP 400 validation"));
        assert!(!err.is_transient());
    }

    #[test]
    fn server_errors_unauthorized_and_network_are_transient() {
        for status in [500, 503, 401, 429] {
            let server = MockServer::start();
            let e = enroller(&server);
            server.mock(|when, then| {
                when.method(GET).path("/v1/me");
                then.status(status);
            });
            let err = e.enroll(OID, "tok").unwrap_err();
            assert!(err.is_transient(), "HTTP {status} -> {err:?}");
        }
        // Nothing listening.
        let e = Enroller::new(
            Arc::new(MemoryStore::default()),
            "http://127.0.0.1:9",
            "h".into(),
        );
        assert!(e.enroll(OID, "tok").unwrap_err().is_transient());
    }

    #[test]
    fn mismatched_device_id_in_response_is_rejected() {
        let server = MockServer::start();
        let e = enroller(&server);
        pin_device_id(&e);
        me_ok(&server, true, true);
        enroll_ok(&server, false);
        assert!(matches!(
            e.enroll(OID, "tok"),
            Err(EnrollError::Rejected(_))
        ));
    }

    fn identity() -> Identity {
        Identity {
            oid: OID.into(),
            device_id: "d".into(),
            employee_id: EMPLOYEE.into(),
        }
    }

    #[test]
    fn enrollment_state_follows_outcomes() {
        let en = Enrollment::new();
        let g = en.reset();
        assert_eq!(en.status().state, "pending");
        assert!(en.record(g, &Err(EnrollError::Unavailable("x".into()))));
        assert_eq!(
            en.status(),
            EnrollmentStatus {
                state: "retrying",
                code: Some("unavailable")
            }
        );
        assert_eq!(en.blocked(), None, "offline never blocks clock-in");
        assert!(en.record(g, &Ok(identity())));
        assert_eq!(en.status().state, "enrolled");
        assert_eq!(en.identity(), Some(identity()));
        assert!(en.record(g, &Err(EnrollError::Revoked)));
        assert_eq!(en.blocked(), Some("device_revoked"));
        assert_eq!(en.identity(), None);
        en.set_not_configured(g);
        assert_eq!(en.status().state, "not_configured");
    }

    #[test]
    fn stale_generation_is_ignored() {
        let en = Enrollment::new();
        let old = en.reset();
        let new = en.reset();
        assert!(!en.is_current(old));
        assert!(!en.record(old, &Ok(identity())));
        assert_eq!(en.status().state, "pending");
        assert!(en.is_current(new));
    }

    #[test]
    fn retry_delay_doubles_and_caps() {
        assert_eq!(retry_delay(0), Duration::from_secs(30));
        assert_eq!(retry_delay(1), Duration::from_secs(60));
        assert_eq!(retry_delay(4), Duration::from_secs(480));
        assert_eq!(retry_delay(5), Duration::from_secs(900));
        assert_eq!(retry_delay(40), Duration::from_secs(900));
    }

    #[test]
    fn this_machine_has_a_hostname() {
        if cfg!(any(target_os = "windows", target_os = "macos")) {
            assert!(hostname().is_some_and(|h| !h.is_empty()));
        }
    }
}
