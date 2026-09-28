//! Where the CloudPunch API is, and the HTTP client used to reach it
//! (ADR-0019).
//!
//! - The URL comes from `CLOUDPUNCH_BACKEND_URL` at run time (local
//!   development), else from the same variable at build time: a pilot
//!   build carries the pilot server's address.
//! - A pilot build may also carry the root certificate of the pilot
//!   server's private CA (`CLOUDPUNCH_BUILD_CA_PEM`, see `build.rs`).
//!   It is trusted **only** by the clients built here, which talk to
//!   our API, and never by the Microsoft sign-in client. The system's
//!   own roots stay trusted too.

use reqwest::blocking::{Client, ClientBuilder};

/// Run-time override of the API address (and the build-time variable).
pub const BACKEND_URL_ENV: &str = "CLOUDPUNCH_BACKEND_URL";

/// The pilot CA root, or empty when the build has none.
static PILOT_CA_PEM: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/pilot_ca.pem"));

/// The API base URL, or `None` when this build has no backend.
pub fn base_url() -> Option<String> {
    choose(
        std::env::var(BACKEND_URL_ENV).ok(),
        option_env!("CLOUDPUNCH_BACKEND_URL"),
    )
}

/// Pure: a non-blank run-time value wins over the built-in one.
fn choose(runtime: Option<String>, built_in: Option<&str>) -> Option<String> {
    runtime.filter(|u| !u.trim().is_empty()).or_else(|| {
        built_in
            .filter(|u| !u.trim().is_empty())
            .map(str::to_string)
    })
}

/// A client builder for our API: system roots plus the pilot CA, if any.
pub fn client_builder() -> ClientBuilder {
    let builder = Client::builder();
    if PILOT_CA_PEM.is_empty() {
        return builder;
    }
    match reqwest::Certificate::from_pem(PILOT_CA_PEM) {
        Ok(ca) => builder.add_root_certificate(ca),
        Err(e) => {
            eprintln!("[cloudpunch] built-in CA certificate unreadable: {e}");
            builder
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_time_url_wins_and_blanks_do_not_count() {
        let built = Some("https://172.16.46.54");
        assert_eq!(
            choose(Some("http://127.0.0.1:8080".into()), built).as_deref(),
            Some("http://127.0.0.1:8080")
        );
        assert_eq!(choose(None, built).as_deref(), Some("https://172.16.46.54"));
        assert_eq!(
            choose(Some("  ".into()), built).as_deref(),
            Some("https://172.16.46.54")
        );
        assert_eq!(choose(None, Some("")), None);
        assert_eq!(choose(None, None), None);
    }

    #[test]
    fn the_client_builds_with_or_without_a_pilot_ca() {
        assert!(client_builder().build().is_ok());
    }
}
