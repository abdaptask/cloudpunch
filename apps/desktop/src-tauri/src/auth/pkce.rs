//! PKCE (RFC 7636, S256) and the authorize URL (ADR-0002 §5 steps 1, 3).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use url::Url;

use super::{AuthError, EntraConfig};

/// A PKCE verifier and its S256 challenge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    /// 32 random bytes → 43-char base64url verifier (RFC 7636 §4.1).
    pub fn generate() -> Result<Self, AuthError> {
        Ok(Self::from_verifier(random_token()?))
    }

    pub fn from_verifier(verifier: String) -> Self {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self {
            verifier,
            challenge,
        }
    }
}

/// 32 random bytes, base64url: used for the verifier and `state`.
pub fn random_token() -> Result<String, AuthError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| AuthError::Rng(e.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// `…/oauth2/v2.0/authorize` for the loopback redirect.
pub fn authorize_url(cfg: &EntraConfig, redirect_uri: &str, pkce: &Pkce, state: &str) -> String {
    let mut url = Url::parse(&format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/authorize",
        cfg.tenant_id
    ))
    .expect("static authorize URL");
    url.query_pairs_mut()
        .append_pair("client_id", cfg.client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_mode", "query")
        .append_pair("scope", &cfg.scopes())
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "select_account")
        .append_pair("state", state);
    url.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc_7636_appendix_b_vector() {
        let p = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into());
        assert_eq!(p.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn generated_verifier_is_43_url_safe_chars_and_unique() {
        let a = Pkce::generate().unwrap();
        let b = Pkce::generate().unwrap();
        assert_eq!(a.verifier.len(), 43);
        assert!(a
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.challenge, a.verifier);
    }

    #[test]
    fn authorize_url_carries_adr_0002_parameters() {
        let cfg = EntraConfig::APTASK;
        let pkce = Pkce::from_verifier("v".repeat(43));
        let url = Url::parse(&authorize_url(&cfg, "http://localhost:51234", &pkce, "st8")).unwrap();
        assert_eq!(url.host_str(), Some("login.microsoftonline.com"));
        assert_eq!(
            url.path(),
            "/a6300e5c-dae4-413c-a6d2-646fbc2aa587/oauth2/v2.0/authorize"
        );
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "13646e0e-abc6-4779-b8fb-fc10bdfdf4b9");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["redirect_uri"], "http://localhost:51234");
        assert_eq!(q["code_challenge"], pkce.challenge);
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["prompt"], "select_account");
        assert_eq!(q["state"], "st8");
        assert_eq!(
            q["scope"],
            "openid profile email offline_access api://63bca00e-a546-4f0c-a076-e2450e52406e/api.access"
        );
    }
}
