//! Microsoft Entra sign-in for the desktop agent (ADR-0002 §5, 2b.4 F2).
//!
//! Interactive: PKCE + loopback redirect + the **system browser** (MFA
//! and Conditional Access happen there). Silent: the stored refresh
//! token is redeemed at start-up and before the access token expires.
//!
//! Storage (ADR-0007 §5): the refresh token and the current user's
//! `oid` live in the OS secure store; the access token is memory-only.
//! Sign-out deletes the refresh token, the current-user pointer, and
//! the device and outbox keys (F1).

pub mod loopback;
pub mod pkce;
pub mod token;

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use thiserror::Error;

use crate::keystore::{KeystoreError, SecretStore, Secrets, Slot};

/// Non-secret app registration identifiers (ADR-0002 step F;
/// `docs/ops/env-vars.md`).
#[derive(Debug, Clone, Copy)]
pub struct EntraConfig {
    pub tenant_id: &'static str,
    /// `CloudPunch Desktop` (public client).
    pub client_id: &'static str,
    /// `CloudPunch API` delegated scope.
    pub api_scope: &'static str,
}

impl EntraConfig {
    /// apTask tenant, created 2026-09-24.
    pub const APTASK: EntraConfig = EntraConfig {
        tenant_id: "a6300e5c-dae4-413c-a6d2-646fbc2aa587",
        client_id: "13646e0e-abc6-4779-b8fb-fc10bdfdf4b9",
        api_scope: "api://63bca00e-a546-4f0c-a076-e2450e52406e/api.access",
    };

    pub fn scopes(&self) -> String {
        format!("openid profile email offline_access {}", self.api_scope)
    }

    pub fn token_url(&self) -> String {
        format!(
            "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
            self.tenant_id
        )
    }
}

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("sign-in timed out")]
    TimedOut,
    #[error("sign-in was denied: {0}")]
    Denied(String),
    #[error("bad sign-in redirect: {0}")]
    BadCallback(String),
    #[error("could not open the browser: {0}")]
    Browser(String),
    #[error("loopback listener: {0}")]
    Loopback(String),
    #[error("network: {0}")]
    Network(String),
    #[error("token endpoint rejected the request: {0}")]
    Rejected(String),
    #[error("{0}")]
    BadToken(&'static str),
    #[error("random number generator failed: {0}")]
    Rng(String),
    #[error("already signing in")]
    Busy,
    #[error("not signed in")]
    NotSignedIn,
    #[error(transparent)]
    Keystore(#[from] KeystoreError),
}

impl AuthError {
    /// Short code for the webview.
    pub fn code(&self) -> &'static str {
        match self {
            AuthError::TimedOut => "timed_out",
            AuthError::Denied(_) => "denied",
            AuthError::BadCallback(_) => "bad_callback",
            AuthError::Browser(_) => "browser",
            AuthError::Loopback(_) => "loopback",
            AuthError::Network(_) => "network",
            AuthError::Rejected(_) => "rejected",
            AuthError::BadToken(_) => "bad_token",
            AuthError::Rng(_) => "rng",
            AuthError::Busy => "busy",
            AuthError::NotSignedIn => "not_signed_in",
            AuthError::Keystore(_) => "keystore",
        }
    }
}

/// What the webview sees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    pub name: Option<String>,
    pub username: Option<String>,
}

impl AuthStatus {
    fn signed_out() -> Self {
        Self {
            signed_in: false,
            name: None,
            username: None,
        }
    }
}

struct Session {
    oid: String,
    name: Option<String>,
    username: Option<String>,
    access_token: String,
    expires_at: SystemTime,
}

/// Refresh the access token this long before it expires.
const REFRESH_MARGIN: Duration = Duration::from_secs(5 * 60);

pub struct AuthManager<S: SecretStore> {
    cfg: EntraConfig,
    token_url: String,
    store: Arc<S>,
    session: Mutex<Option<Session>>,
    signing_in: Mutex<bool>,
}

impl<S: SecretStore> AuthManager<S> {
    pub fn new(cfg: EntraConfig, store: S) -> Self {
        let token_url = cfg.token_url();
        Self::with_token_url(cfg, store, token_url)
    }

    /// For tests: point the token calls at a mock server.
    pub fn with_token_url(cfg: EntraConfig, store: S, token_url: String) -> Self {
        Self {
            cfg,
            token_url,
            store: Arc::new(store),
            session: Mutex::new(None),
            signing_in: Mutex::new(false),
        }
    }

    pub fn status(&self) -> AuthStatus {
        match &*self.lock() {
            Some(s) => AuthStatus {
                signed_in: true,
                name: s.name.clone(),
                username: s.username.clone(),
            },
            None => AuthStatus::signed_out(),
        }
    }

    /// Signed-in user's Entra `oid` (keys, enrollment, event attribution).
    pub fn oid(&self) -> Option<String> {
        self.lock().as_ref().map(|s| s.oid.clone())
    }

    /// Interactive sign-in. `open_browser` is called with the authorize
    /// URL (the real app passes [`open_system_browser`]). Blocks until
    /// the redirect arrives or `timeout` passes — call off the UI thread.
    pub fn sign_in(
        &self,
        open_browser: &dyn Fn(&str) -> Result<(), AuthError>,
        timeout: Duration,
    ) -> Result<AuthStatus, AuthError> {
        let _busy = self.begin()?;
        let pkce = pkce::Pkce::generate()?;
        let state = pkce::random_token()?;
        let listener = loopback::Loopback::bind()?;
        let redirect = listener.redirect_uri();
        open_browser(&pkce::authorize_url(&self.cfg, &redirect, &pkce, &state))?;
        let code = listener.wait_for_code(&state, timeout)?;
        let tokens =
            token::exchange_code(&self.cfg, &self.token_url, &code, &pkce.verifier, &redirect)?;
        let id_token = tokens
            .id_token
            .as_deref()
            .ok_or(AuthError::BadToken("no id token"))?;
        let claims = token::id_claims(&self.cfg, id_token)?;
        self.adopt(claims.oid, claims.name, claims.preferred_username, tokens)
    }

    /// Silent sign-in at start-up from the stored refresh token.
    /// `Ok(false)` if nobody was signed in; a rejected token (expired,
    /// revoked) clears the stored one and returns `Ok(false)`.
    pub fn restore(&self) -> Result<bool, AuthError> {
        let Some(oid) = self.store.get(&Slot::current_user())? else {
            return Ok(false);
        };
        let slot = Slot::refresh_token(self.cfg.tenant_id, self.cfg.client_id, &oid)?;
        let Some(refresh_token) = self.store.get(&slot)? else {
            return Ok(false);
        };
        match token::refresh(&self.cfg, &self.token_url, &refresh_token) {
            Ok(tokens) => {
                let claims = tokens
                    .id_token
                    .as_deref()
                    .and_then(|t| token::id_claims(&self.cfg, t).ok());
                if claims.as_ref().is_some_and(|c| c.oid != oid) {
                    return Err(AuthError::BadToken("refreshed token is for another user"));
                }
                let (name, username) = claims
                    .map(|c| (c.name, c.preferred_username))
                    .unwrap_or((None, None));
                self.adopt(oid, name, username, tokens)?;
                Ok(true)
            }
            Err(AuthError::Rejected(_)) => {
                self.store.delete(&slot)?;
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }

    /// A valid access token, refreshing it first if it expires within
    /// five minutes. For the sync loop (F3).
    pub fn access_token(&self, now: SystemTime) -> Result<String, AuthError> {
        let (oid, fresh) = {
            let guard = self.lock();
            let s = guard.as_ref().ok_or(AuthError::NotSignedIn)?;
            let fresh = s.expires_at > now + REFRESH_MARGIN;
            (s.oid.clone(), fresh.then(|| s.access_token.clone()))
        };
        if let Some(token) = fresh {
            return Ok(token);
        }
        let slot = Slot::refresh_token(self.cfg.tenant_id, self.cfg.client_id, &oid)?;
        let refresh_token = self.store.get(&slot)?.ok_or(AuthError::NotSignedIn)?;
        let tokens = token::refresh(&self.cfg, &self.token_url, &refresh_token)?;
        let access = tokens.access_token.clone();
        let (name, username) = self
            .lock()
            .as_ref()
            .map(|s| (s.name.clone(), s.username.clone()))
            .unwrap_or((None, None));
        self.adopt(oid, name, username, tokens)?;
        Ok(access)
    }

    /// Delete the refresh token, the current-user pointer, and the
    /// device and outbox keys (ADR-0007 §5 logout).
    pub fn sign_out(&self) -> Result<(), AuthError> {
        let oid = self.lock().take().map(|s| s.oid);
        let oid = match oid {
            Some(o) => Some(o),
            None => self.store.get(&Slot::current_user())?,
        };
        if let Some(oid) = oid {
            self.store.delete(&Slot::refresh_token(
                self.cfg.tenant_id,
                self.cfg.client_id,
                &oid,
            )?)?;
            Secrets::new(self.store.clone()).forget(&oid)?;
        }
        self.store.delete(&Slot::current_user())?;
        Ok(())
    }

    fn adopt(
        &self,
        oid: String,
        name: Option<String>,
        username: Option<String>,
        tokens: token::TokenResponse,
    ) -> Result<AuthStatus, AuthError> {
        if let Some(rt) = &tokens.refresh_token {
            let slot = Slot::refresh_token(self.cfg.tenant_id, self.cfg.client_id, &oid)?;
            self.store.set(&slot, rt)?;
        }
        self.store.set(&Slot::current_user(), &oid)?;
        *self.lock() = Some(Session {
            oid,
            name,
            username,
            expires_at: tokens.expires_at(SystemTime::now()),
            access_token: tokens.access_token,
        });
        Ok(self.status())
    }

    fn begin(&self) -> Result<BusyGuard<'_>, AuthError> {
        let mut busy = self.signing_in.lock().unwrap_or_else(|p| p.into_inner());
        if *busy {
            return Err(AuthError::Busy);
        }
        *busy = true;
        Ok(BusyGuard(&self.signing_in))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Session>> {
        self.session.lock().unwrap_or_else(|p| p.into_inner())
    }
}

struct BusyGuard<'a>(&'a Mutex<bool>);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = false;
    }
}

/// Open `url` in the user's default browser.
pub fn open_system_browser(url: &str) -> Result<(), AuthError> {
    open::that_detached(url).map_err(|e| AuthError::Browser(e.to_string()))
}

#[cfg(test)]
mod tests;
