//! macOS system state for the watchers (ADR-0026 §2): plain C
//! interfaces from CoreGraphics, CoreFoundation, SystemConfiguration
//! and libc. Metadata only (invariant 1): how long since the last
//! input, whether the screen is locked, whether the network is up, the
//! local time and when the console user logged in. No permission
//! prompts; nothing about keys, windows or apps.

#![cfg(target_os = "macos")]

use std::ffi::{c_char, c_void, CString};
use std::time::{Duration, SystemTime};

type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFAllocatorRef = *const c_void;
type SCNetworkReachabilityRef = *const c_void;

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
/// `kCGEventSourceStateCombinedSessionState`.
const COMBINED_SESSION_STATE: i32 = 0;
/// `kCGAnyInputEventType`.
const ANY_INPUT_EVENT: u32 = !0;
/// `kSCNetworkReachabilityFlagsReachable` and `…ConnectionRequired`.
const REACHABLE: u32 = 1 << 1;
const CONNECTION_REQUIRED: u32 = 1 << 2;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(
        alloc: CFAllocatorRef,
        cstr: *const c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFDictionaryGetValue(dict: CFDictionaryRef, key: *const c_void) -> *const c_void;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(boolean: CFTypeRef) -> u8;
    fn CFRelease(cf: CFTypeRef);
}

#[link(name = "SystemConfiguration", kind = "framework")]
extern "C" {
    fn SCNetworkReachabilityCreateWithName(
        alloc: CFAllocatorRef,
        nodename: *const c_char,
    ) -> SCNetworkReachabilityRef;
    fn SCNetworkReachabilityGetFlags(target: SCNetworkReachabilityRef, flags: *mut u32) -> u8;
}

/// Seconds since the last keyboard, mouse or trackpad input.
pub fn seconds_since_last_input() -> f64 {
    // SAFETY: a pure query with constant arguments.
    let s =
        unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) };
    if s.is_finite() && s >= 0.0 {
        s
    } else {
        0.0
    }
}

/// When the last input happened.
pub fn last_input_at() -> SystemTime {
    let now = SystemTime::now();
    now.checked_sub(Duration::from_secs_f64(seconds_since_last_input()))
        .unwrap_or(now)
}

/// Whether the screen is locked; `None` if the session can't say.
pub fn screen_locked() -> Option<bool> {
    // SAFETY: the dictionary and key follow CF's create/copy rule and
    // are released here; values read from it are not retained.
    unsafe {
        let dict = CGSessionCopyCurrentDictionary();
        if dict.is_null() {
            return None;
        }
        let key_name = CString::new("CGSSessionScreenIsLocked").ok()?;
        let key = CFStringCreateWithCString(
            std::ptr::null(),
            key_name.as_ptr(),
            K_CF_STRING_ENCODING_UTF8,
        );
        let value = if key.is_null() {
            std::ptr::null()
        } else {
            CFDictionaryGetValue(dict, key)
        };
        // The key is present (true) only while locked.
        let locked = !value.is_null()
            && CFGetTypeID(value) == CFBooleanGetTypeID()
            && CFBooleanGetValue(value) != 0;
        if !key.is_null() {
            CFRelease(key);
        }
        CFRelease(dict);
        Some(locked)
    }
}

/// Whether `host` is reachable without dialling a connection.
pub fn reachable(host: &str) -> Option<bool> {
    let name = CString::new(host).ok()?;
    // SAFETY: the reachability ref is created here and released here.
    unsafe {
        let r = SCNetworkReachabilityCreateWithName(std::ptr::null(), name.as_ptr());
        if r.is_null() {
            return None;
        }
        let mut flags = 0u32;
        let ok = SCNetworkReachabilityGetFlags(r, &mut flags) != 0;
        CFRelease(r);
        ok.then_some(flags & REACHABLE != 0 && flags & CONNECTION_REQUIRED == 0)
    }
}

/// Local minutes after midnight, from the OS time zone.
pub fn local_minute_of_day() -> u16 {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as libc::time_t)
        .unwrap_or(0);
    // SAFETY: localtime_r fills the caller's `tm`.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let filled = unsafe { !libc::localtime_r(&now, &mut tm).is_null() };
    if !filled {
        return 0;
    }
    (tm.tm_hour * 60 + tm.tm_min).clamp(0, 24 * 60 - 1) as u16
}

/// When the console user logged in (utmpx `console` entry).
pub fn console_login_time() -> Option<SystemTime> {
    // SAFETY: the utmpx database is read with the documented
    // set/get/end sequence on this thread.
    unsafe {
        libc::setutxent();
        let mut latest: Option<SystemTime> = None;
        loop {
            let entry = libc::getutxent();
            if entry.is_null() {
                break;
            }
            let e = &*entry;
            if e.ut_type != libc::USER_PROCESS {
                continue;
            }
            let line: Vec<u8> = e
                .ut_line
                .iter()
                .take_while(|c| **c != 0)
                .map(|c| *c as u8)
                .collect();
            if line != b"console" {
                continue;
            }
            let secs = u64::try_from(e.ut_tv.tv_sec).ok();
            if let Some(at) = secs.map(|s| SystemTime::UNIX_EPOCH + Duration::from_secs(s)) {
                latest = Some(latest.map_or(at, |l| l.max(at)));
            }
        }
        libc::endutxent();
        latest
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_calls_answer_without_crashing() {
        // CI Macs are headless: only sanity, not specific values.
        let idle = seconds_since_last_input();
        assert!(idle >= 0.0);
        assert!(last_input_at() <= SystemTime::now());
        let _ = screen_locked();
        let _ = reachable("localhost");
        assert!(local_minute_of_day() < 24 * 60);
        if let Some(at) = console_login_time() {
            assert!(at <= SystemTime::now());
        }
    }
}
