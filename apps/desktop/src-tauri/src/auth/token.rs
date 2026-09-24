//! Token endpoint calls and ID-token claims (ADR-0002 §5 steps 6–9).
//!
//! Tokens are never logged. The ID token is decoded only as a sanity
//! check (right tenant, right client) and to read `oid` and the display
//! name; its signature is not verified here. The backend validates
//! every *access* token fully, and authorization never rests on the ID
//! token (ADR-0002 §5 step 7).

use std::time::{Duration, SystemTime};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;

use super::{AuthError, EntraConfig};

/// Parsed `/token` response. `Debug` redacts the tokens.
#[derive(Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    /// Absent on some refreshes; keep the previous one then.
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub expires_in: u64,
}

impl std::fmt::Debug for TokenResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenResponse")
            .field("access_token", &"<redacted>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("id_token", &self.id_token.as_ref().map(|_| "<redacted>"))
            .field("expires_in", &self.expires_in)
            .finish()
    }
}

impl TokenResponse {
    pub fn expires_at(&self, now: SystemTime) -> SystemTime {
        now + Duration::from_secs(self.expires_in)
    }
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
}

/// Authorization-code grant with the PKCE verifier (step 6).
pub fn exchange_code(
    cfg: &EntraConfig,
    token_url: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, AuthError> {
    let scopes = cfg.scopes();
    post(
        token_url,
        &[
            ("client_id", cfg.client_id),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
            ("scope", &scopes),
        ],
    )
}

/// Refresh-token grant (step 9: silent refresh).
pub fn refresh(
    cfg: &EntraConfig,
    token_url: &str,
    refresh_token: &str,
) -> Result<TokenResponse, AuthError> {
    let scopes = cfg.scopes();
    post(
        token_url,
        &[
            ("client_id", cfg.client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("scope", &scopes),
        ],
    )
}

fn post(url: &str, form: &[(&str, &str)]) -> Result<TokenResponse, AuthError> {
    let resp = reqwest::blocking::Client::new()
        .post(url)
        .form(form)
        .timeout(Duration::from_secs(30))
        .send()
        .map_err(|e| AuthError::Network(e.without_url().to_string()))?;
    let status = resp.status();
    let text = resp
        .text()
        .map_err(|e| AuthError::Network(e.without_url().to_string()))?;
    if status.is_success() {
        serde_json::from_str(&text).map_err(|_| AuthError::BadToken("unreadable token response"))
    } else {
        // Only the error code (e.g. invalid_grant) — never the body,
        // which can echo request details.
        let code = serde_json::from_str::<ErrorBody>(&text)
            .map(|b| b.error)
            .unwrap_or_else(|_| format!("http_{}", status.as_u16()));
        Err(AuthError::Rejected(code))
    }
}

/// The ID-token claims CloudPunch uses.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct IdClaims {
    pub oid: String,
    pub tid: String,
    pub aud: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub preferred_username: Option<String>,
}

/// Decode (without verifying) and sanity-check the ID token.
pub fn id_claims(cfg: &EntraConfig, id_token: &str) -> Result<IdClaims, AuthError> {
    let payload = id_token
        .split('.')
        .nth(1)
        .ok_or(AuthError::BadToken("id token is not a JWT"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|_| AuthError::BadToken("id token payload is not base64url"))?;
    let claims: IdClaims = serde_json::from_slice(&bytes)
        .map_err(|_| AuthError::BadToken("id token claims missing"))?;
    if !claims.tid.eq_ignore_ascii_case(cfg.tenant_id) {
        return Err(AuthError::BadToken("id token is for another tenant"));
    }
    if !claims.aud.eq_ignore_ascii_case(cfg.client_id) {
        return Err(AuthError::BadToken("id token is for another app"));
    }
    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    const OID: &str = "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

    fn jwt(claims: serde_json::Value) -> String {
        let enc = |v: &serde_json::Value| URL_SAFE_NO_PAD.encode(v.to_string());
        format!(
            "{}.{}.sig",
            enc(&serde_json::json!({"alg":"none"})),
            enc(&claims)
        )
    }

    fn good_claims() -> serde_json::Value {
        serde_json::json!({
            "oid": OID,
            "tid": EntraConfig::APTASK.tenant_id,
            "aud": EntraConfig::APTASK.client_id,
            "name": "Test User",
            "preferred_username": "test@aptask.com",
        })
    }

    #[test]
    fn id_claims_read_oid_and_name() {
        let c = id_claims(&EntraConfig::APTASK, &jwt(good_claims())).unwrap();
        assert_eq!(c.oid, OID);
        assert_eq!(c.name.as_deref(), Some("Test User"));
    }

    #[test]
    fn id_claims_reject_wrong_tenant_or_app() {
        let mut other_tenant = good_claims();
        other_tenant["tid"] = "11111111-1111-1111-1111-111111111111".into();
        assert!(matches!(
            id_claims(&EntraConfig::APTASK, &jwt(other_tenant)),
            Err(AuthError::BadToken(_))
        ));
        let mut other_app = good_claims();
        other_app["aud"] = "22222222-2222-2222-2222-222222222222".into();
        assert!(id_claims(&EntraConfig::APTASK, &jwt(other_app)).is_err());
        assert!(id_claims(&EntraConfig::APTASK, "garbage").is_err());
    }

    #[test]
    fn exchange_posts_pkce_form_and_parses_tokens() {
        let server = MockServer::start();
        let m = server.mock(|when, then| {
            when.method(POST)
                .path("/token")
                .body_contains("grant_type=authorization_code")
                .body_contains("code=the-code")
                .body_contains("code_verifier=the-verifier")
                .body_contains("redirect_uri=http%3A%2F%2Flocalhost%3A5000");
            then.status(200).json_body(serde_json::json!({
                "access_token": "at", "refresh_token": "rt",
                "id_token": "it", "expires_in": 3600, "token_type": "Bearer"
            }));
        });
        let t = exchange_code(
            &EntraConfig::APTASK,
            &server.url("/token"),
            "the-code",
            "the-verifier",
            "http://localhost:5000",
        )
        .unwrap();
        m.assert();
        assert_eq!(t.access_token, "at");
        assert_eq!(t.refresh_token.as_deref(), Some("rt"));
        assert!(!format!("{t:?}").contains("at\""), "Debug must redact");
    }

    #[test]
    fn refresh_error_surfaces_only_the_error_code() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST)
                .path("/token")
                .body_contains("grant_type=refresh_token");
            then.status(400).json_body(serde_json::json!({
                "error": "invalid_grant",
                "error_description": "AADSTS70008: token expired; secret detail"
            }));
        });
        let err = refresh(&EntraConfig::APTASK, &server.url("/token"), "old").unwrap_err();
        assert!(matches!(&err, AuthError::Rejected(c) if c == "invalid_grant"));
        assert!(!err.to_string().contains("secret detail"));
    }
}
