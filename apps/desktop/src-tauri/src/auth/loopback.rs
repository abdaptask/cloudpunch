//! Loopback redirect listener (ADR-0002 §5 steps 2, 5, 6).
//!
//! Binds an ephemeral port on 127.0.0.1 (and the same port on ::1 when
//! available, since browsers may resolve `localhost` to either), waits
//! for the browser's `GET /?code=…&state=…`, answers with a short
//! "you can close this window" page, and returns the code once `state`
//! matches. Other requests (e.g. `/favicon.ico`) get a 404 and are
//! ignored.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, Ipv6Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use url::Url;

use super::AuthError;

pub struct Loopback {
    v4: TcpListener,
    v6: Option<TcpListener>,
    port: u16,
}

impl Loopback {
    pub fn bind() -> Result<Self, AuthError> {
        let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|e| AuthError::Loopback(e.to_string()))?;
        let port = v4
            .local_addr()
            .map_err(|e| AuthError::Loopback(e.to_string()))?
            .port();
        let v6 = TcpListener::bind((Ipv6Addr::LOCALHOST, port)).ok();
        v4.set_nonblocking(true)
            .map_err(|e| AuthError::Loopback(e.to_string()))?;
        if let Some(l) = &v6 {
            let _ = l.set_nonblocking(true);
        }
        Ok(Self { v4, v6, port })
    }

    /// `http://localhost:<port>` — Entra accepts any port for the
    /// registered `http://localhost` public-client redirect.
    pub fn redirect_uri(&self) -> String {
        format!("http://localhost:{}", self.port)
    }

    /// Wait up to `timeout` for the redirect carrying `expected_state`,
    /// or until `cancel` is set (a newer sign-in, or the user pressed
    /// Cancel — e.g. after closing the browser tab).
    pub fn wait_for_code(
        &self,
        expected_state: &str,
        timeout: Duration,
        cancel: &AtomicBool,
    ) -> Result<String, AuthError> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if cancel.load(Ordering::Acquire) {
                return Err(AuthError::Cancelled);
            }
            let stream = self
                .v4
                .accept()
                .ok()
                .or_else(|| self.v6.as_ref().and_then(|l| l.accept().ok()));
            let Some((stream, _)) = stream else {
                thread::sleep(Duration::from_millis(50));
                continue;
            };
            if let Some(result) = handle(stream, expected_state) {
                return result;
            }
        }
        Err(AuthError::TimedOut)
    }
}

/// `None` for requests that aren't the redirect (keep waiting).
fn handle(mut stream: TcpStream, expected_state: &str) -> Option<Result<String, AuthError>> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).ok()?;
    let target = line.split_whitespace().nth(1)?;
    if !target.starts_with("/?") && target != "/" {
        let _ = respond(&mut stream, "404 Not Found", "");
        return None;
    }
    let result = parse_callback(target, expected_state);
    let body = match &result {
        Ok(_) => result_page(
            true,
            "You're signed in",
            "Return to CloudPunch. You can close this tab.",
        ),
        Err(AuthError::Denied(_)) => result_page(
            false,
            "Sign-in was cancelled",
            "Return to CloudPunch to try again. You can close this tab.",
        ),
        Err(_) => result_page(
            false,
            "Sign-in failed",
            "Return to CloudPunch and try again. You can close this tab.",
        ),
    };
    let _ = respond(&mut stream, "200 OK", &body);
    Some(result)
}

/// The page the browser shows after the redirect. On success it also
/// tries `window.close()`: browsers ignore that for a tab the OS
/// opened (the usual case), so the text always says it can be closed.
fn result_page(ok: bool, heading: &str, text: &str) -> String {
    let (mark, colour) = if ok {
        ("&#10003;", "#1a7f37")
    } else {
        ("!", "#b35900")
    };
    let close = if ok {
        "<script>setTimeout(function(){window.close()},1500)</script>"
    } else {
        ""
    };
    format!(
        "<!doctype html><meta charset=utf-8><title>CloudPunch</title>\
         <meta name=viewport content=\"width=device-width,initial-scale=1\">\
         <body style=\"margin:0;min-height:100vh;display:flex;align-items:center;\
         justify-content:center;background:#f6f7f9;color:#1f2328;\
         font-family:'Segoe UI',system-ui,-apple-system,sans-serif\">\
         <main style=\"text-align:center;padding:40px 48px;background:#fff;\
         border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.12)\">\
         <img src=\"{logo}\" alt=\"CloudPunch\" width=\"140\" \
         style=\"display:block;margin:0 auto 24px\">\
         <div aria-hidden=true style=\"width:40px;height:40px;margin:0 auto 14px;\
         border-radius:50%;background:{colour};color:#fff;font-size:22px;\
         line-height:40px;font-weight:700\">{mark}</div>\
         <h1 style=\"margin:0 0 8px;font-size:20px;font-weight:600\">{heading}</h1>\
         <p style=\"margin:0;color:#57606a;font-size:14px\">{text}</p>\
         </main>{close}",
        logo = logo_data_uri(),
    )
}

/// The CloudPunch logo as a data URI: the loopback server serves only
/// this one page, so the image travels inside it.
fn logo_data_uri() -> &'static str {
    static URI: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    URI.get_or_init(|| {
        use base64::Engine;
        let png = include_bytes!("../../icons/signed-in-logo.png");
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        )
    })
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    )
}

/// Pure: extract the code from the redirect target (`/?code=…&state=…`).
pub fn parse_callback(target: &str, expected_state: &str) -> Result<String, AuthError> {
    let url = Url::parse(&format!("http://localhost{target}"))
        .map_err(|_| AuthError::BadCallback("unparseable redirect".into()))?;
    let get = |k: &str| {
        url.query_pairs()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.into_owned())
    };
    if let Some(error) = get("error") {
        return Err(AuthError::Denied(error));
    }
    if get("state").as_deref() != Some(expected_state) {
        return Err(AuthError::BadCallback("state mismatch".into()));
    }
    get("code")
        .filter(|c| !c.is_empty())
        .ok_or_else(|| AuthError::BadCallback("no code".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn parses_code_when_state_matches() {
        assert_eq!(parse_callback("/?code=abc&state=s1", "s1").unwrap(), "abc");
    }

    #[test]
    fn rejects_state_mismatch_missing_code_and_errors() {
        assert!(matches!(
            parse_callback("/?code=abc&state=other", "s1"),
            Err(AuthError::BadCallback(_))
        ));
        assert!(matches!(
            parse_callback("/?state=s1", "s1"),
            Err(AuthError::BadCallback(_))
        ));
        assert!(matches!(
            parse_callback("/?error=access_denied&state=s1", "s1"),
            Err(AuthError::Denied(e)) if e == "access_denied"
        ));
    }

    #[test]
    fn loopback_returns_code_and_answers_the_browser() {
        let lb = Loopback::bind().unwrap();
        assert!(lb.redirect_uri().starts_with("http://localhost:"));
        let port = lb.port;
        let browser = thread::spawn(move || {
            // A stray favicon request first, then the real redirect.
            let mut fav = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            fav.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n").unwrap();
            let mut s = String::new();
            let _ = fav.read_to_string(&mut s);
            assert!(s.starts_with("HTTP/1.1 404"));

            let mut c = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            c.write_all(b"GET /?code=the-code&state=st HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .unwrap();
            let mut page = String::new();
            c.read_to_string(&mut page).unwrap();
            page
        });
        let code = lb
            .wait_for_code("st", Duration::from_secs(5), &AtomicBool::new(false))
            .unwrap();
        assert_eq!(code, "the-code");
        let page = browser.join().unwrap();
        assert!(page.starts_with("HTTP/1.1 200 OK"));
        assert!(page.contains("You're signed in"));
        assert!(page.contains("window.close()"));
    }

    #[test]
    fn only_the_success_page_tries_to_close_itself() {
        let failed = result_page(false, "Sign-in failed", "Try again.");
        assert!(failed.contains("Sign-in failed"));
        assert!(!failed.contains("<script"));
        assert!(result_page(true, "h", "t").contains("window.close()"));
        assert!(
            failed.contains("data:image/png;base64,iVBOR"),
            "logo is embedded"
        );
    }

    #[test]
    fn loopback_times_out() {
        let lb = Loopback::bind().unwrap();
        assert!(matches!(
            lb.wait_for_code("st", Duration::from_millis(150), &AtomicBool::new(false)),
            Err(AuthError::TimedOut)
        ));
    }

    #[test]
    fn loopback_stops_promptly_when_cancelled() {
        let lb = Loopback::bind().unwrap();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            flag.store(true, Ordering::Release);
        });
        let started = Instant::now();
        assert!(matches!(
            lb.wait_for_code("st", Duration::from_secs(30), &cancel),
            Err(AuthError::Cancelled)
        ));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
