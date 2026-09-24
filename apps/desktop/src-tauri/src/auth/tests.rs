use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use httpmock::prelude::*;
use url::Url;

use super::*;
use crate::keystore::MemoryStore;

const OID: &str = "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

fn id_token(oid: &str) -> String {
    let claims = serde_json::json!({
        "oid": oid,
        "tid": EntraConfig::APTASK.tenant_id,
        "aud": EntraConfig::APTASK.client_id,
        "name": "Test User",
        "preferred_username": "test@aptask.com",
    });
    format!("e30.{}.sig", URL_SAFE_NO_PAD.encode(claims.to_string()))
}

fn token_json(
    access: &str,
    refresh: Option<&str>,
    oid: &str,
    expires_in: u64,
) -> serde_json::Value {
    serde_json::json!({
        "access_token": access,
        "refresh_token": refresh,
        "id_token": id_token(oid),
        "expires_in": expires_in,
    })
}

/// Pretend to be the browser: follow the authorize URL's redirect with
/// a code and the same state.
fn fake_browser(url: &str) -> Result<(), AuthError> {
    let url = Url::parse(url).unwrap();
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    let redirect = Url::parse(&q["redirect_uri"]).unwrap();
    let port = redirect.port().unwrap();
    let state = q["state"].clone();
    thread::spawn(move || {
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(c, "GET /?code=auth-code&state={state} HTTP/1.1\r\n\r\n").unwrap();
        let mut page = String::new();
        let _ = c.read_to_string(&mut page);
    });
    Ok(())
}

fn manager(server: &MockServer) -> AuthManager<MemoryStore> {
    AuthManager::with_token_url(
        EntraConfig::APTASK,
        MemoryStore::default(),
        server.url("/token"),
    )
}

#[test]
fn interactive_sign_in_stores_refresh_token_and_user() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(POST)
            .path("/token")
            .body_contains("grant_type=authorization_code")
            .body_contains("code=auth-code");
        then.status(200)
            .json_body(token_json("at-1", Some("rt-1"), OID, 3600));
    });
    let auth = manager(&server);
    let status = auth.sign_in(&fake_browser, Duration::from_secs(5)).unwrap();
    assert!(status.signed_in);
    assert_eq!(status.name.as_deref(), Some("Test User"));
    assert_eq!(auth.oid().as_deref(), Some(OID));

    let rt_slot = Slot::refresh_token(
        EntraConfig::APTASK.tenant_id,
        EntraConfig::APTASK.client_id,
        OID,
    )
    .unwrap();
    assert_eq!(auth.store.get(&rt_slot).unwrap().as_deref(), Some("rt-1"));
    assert_eq!(
        auth.store.get(&Slot::current_user()).unwrap().as_deref(),
        Some(OID)
    );
    assert_eq!(auth.access_token(SystemTime::now()).unwrap(), "at-1");
}

#[test]
fn restore_signs_in_silently_and_rotates_the_refresh_token() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(POST)
            .path("/token")
            .body_contains("grant_type=refresh_token")
            .body_contains("refresh_token=rt-old");
        then.status(200)
            .json_body(token_json("at-2", Some("rt-new"), OID, 3600));
    });
    let auth = manager(&server);
    let rt_slot = Slot::refresh_token(
        EntraConfig::APTASK.tenant_id,
        EntraConfig::APTASK.client_id,
        OID,
    )
    .unwrap();
    auth.store.set(&Slot::current_user(), OID).unwrap();
    auth.store.set(&rt_slot, "rt-old").unwrap();

    assert!(auth.restore().unwrap());
    assert!(auth.status().signed_in);
    assert_eq!(auth.store.get(&rt_slot).unwrap().as_deref(), Some("rt-new"));
}

#[test]
fn restore_with_nobody_stored_is_signed_out() {
    let server = MockServer::start();
    let auth = manager(&server);
    assert!(!auth.restore().unwrap());
    assert!(!auth.status().signed_in);
}

#[test]
fn restore_with_revoked_token_clears_it() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(POST).path("/token");
        then.status(400)
            .json_body(serde_json::json!({ "error": "invalid_grant" }));
    });
    let auth = manager(&server);
    let rt_slot = Slot::refresh_token(
        EntraConfig::APTASK.tenant_id,
        EntraConfig::APTASK.client_id,
        OID,
    )
    .unwrap();
    auth.store.set(&Slot::current_user(), OID).unwrap();
    auth.store.set(&rt_slot, "rt-revoked").unwrap();
    assert!(!auth.restore().unwrap());
    assert!(auth.store.get(&rt_slot).unwrap().is_none());
}

#[test]
fn access_token_refreshes_near_expiry() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(POST)
            .path("/token")
            .body_contains("grant_type=authorization_code");
        // Expires in 60 s: inside the 5-minute margin.
        then.status(200)
            .json_body(token_json("at-short", Some("rt-1"), OID, 60));
    });
    let refresh = server.mock(|when, then| {
        when.method(POST)
            .path("/token")
            .body_contains("grant_type=refresh_token");
        then.status(200)
            .json_body(token_json("at-fresh", None, OID, 3600));
    });
    let auth = manager(&server);
    auth.sign_in(&fake_browser, Duration::from_secs(5)).unwrap();
    assert_eq!(auth.access_token(SystemTime::now()).unwrap(), "at-fresh");
    refresh.assert();
    // Refresh response had no new refresh token: the old one is kept.
    let rt_slot = Slot::refresh_token(
        EntraConfig::APTASK.tenant_id,
        EntraConfig::APTASK.client_id,
        OID,
    )
    .unwrap();
    assert_eq!(auth.store.get(&rt_slot).unwrap().as_deref(), Some("rt-1"));
}

#[test]
fn sign_out_deletes_tokens_pointer_and_device_keys() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(POST).path("/token");
        then.status(200)
            .json_body(token_json("at", Some("rt"), OID, 3600));
    });
    let auth = manager(&server);
    auth.sign_in(&fake_browser, Duration::from_secs(5)).unwrap();
    // F1 keys exist for this user.
    let secrets = Secrets::new(auth.store.clone());
    secrets.device_key(OID).unwrap();
    secrets.outbox_key(OID).unwrap();

    auth.sign_out().unwrap();
    assert!(!auth.status().signed_in);
    assert!(auth.store.get(&Slot::current_user()).unwrap().is_none());
    assert!(auth
        .store
        .get(&Slot::device_key(OID).unwrap())
        .unwrap()
        .is_none());
    assert!(auth
        .store
        .get(&Slot::outbox_key(OID).unwrap())
        .unwrap()
        .is_none());
    assert!(matches!(
        auth.access_token(SystemTime::now()),
        Err(AuthError::NotSignedIn)
    ));
}

#[test]
fn denied_in_browser_reports_denied() {
    let server = MockServer::start();
    let auth = manager(&server);
    let deny = |url: &str| -> Result<(), AuthError> {
        let url = Url::parse(url).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        let port = Url::parse(&q["redirect_uri"]).unwrap().port().unwrap();
        let state = q["state"].clone();
        thread::spawn(move || {
            let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(
                c,
                "GET /?error=access_denied&state={state} HTTP/1.1\r\n\r\n"
            )
            .unwrap();
            let mut page = String::new();
            let _ = c.read_to_string(&mut page);
        });
        Ok(())
    };
    assert!(matches!(
        auth.sign_in(&deny, Duration::from_secs(5)),
        Err(AuthError::Denied(_))
    ));
    assert!(!auth.status().signed_in);
}
