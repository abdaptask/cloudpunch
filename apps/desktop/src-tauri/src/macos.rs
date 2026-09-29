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

// ── Mic, camera and the kind of call (ADR-0026 §2, ADR-0012) ─────────

type AudioObjectId = u32;

#[repr(C)]
struct PropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

const fn fourcc(b: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*b)
}

/// `kAudioObjectSystemObject` / `kCMIOObjectSystemObject`.
const SYSTEM_OBJECT: u32 = 1;
const SCOPE_GLOBAL: u32 = fourcc(b"glob");
const SCOPE_INPUT: u32 = fourcc(b"inpt");
const ELEMENT_MAIN: u32 = 0;
/// `kAudioHardwarePropertyDevices` / `kCMIOHardwarePropertyDevices`.
const DEVICES: u32 = fourcc(b"dev#");
/// `kAudioDevicePropertyStreams`.
const STREAMS: u32 = fourcc(b"stm#");
/// `kAudioDevicePropertyDeviceIsRunningSomewhere` (and CMIO's).
const RUNNING_SOMEWHERE: u32 = fourcc(b"gone");
/// `kAudioHardwarePropertyProcessObjectList` (macOS 14).
const PROCESS_LIST: u32 = fourcc(b"prs#");
/// `kAudioProcessPropertyIsRunningInput` (macOS 14).
const PROCESS_RUNNING_INPUT: u32 = fourcc(b"piri");
/// `kAudioProcessPropertyBundleID` (macOS 14): a CFString.
const PROCESS_BUNDLE_ID: u32 = fourcc(b"pbid");

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyDataSize(
        object: AudioObjectId,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        out_size: *mut u32,
    ) -> i32;
    fn AudioObjectGetPropertyData(
        object: AudioObjectId,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        io_size: *mut u32,
        out: *mut c_void,
    ) -> i32;
}

#[link(name = "CoreMediaIO", kind = "framework")]
extern "C" {
    fn CMIOObjectGetPropertyDataSize(
        object: u32,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        out_size: *mut u32,
    ) -> i32;
    fn CMIOObjectGetPropertyData(
        object: u32,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        data_size: u32,
        data_used: *mut u32,
        out: *mut c_void,
    ) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringGetCString(s: CFStringRef, buf: *mut c_char, size: isize, encoding: u32) -> u8;
}

fn address(selector: u32, scope: u32) -> PropertyAddress {
    PropertyAddress {
        selector,
        scope,
        element: ELEMENT_MAIN,
    }
}

/// A Core Audio list of object ids (devices, processes).
fn audio_ids(object: AudioObjectId, selector: u32) -> Vec<AudioObjectId> {
    let addr = address(selector, SCOPE_GLOBAL);
    let mut size = 0u32;
    // SAFETY: size query, then a buffer of exactly that many bytes.
    unsafe {
        if AudioObjectGetPropertyDataSize(object, &addr, 0, std::ptr::null(), &mut size) != 0 {
            return Vec::new();
        }
        let mut ids = vec![0u32; size as usize / std::mem::size_of::<u32>()];
        if AudioObjectGetPropertyData(
            object,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            ids.as_mut_ptr().cast(),
        ) != 0
        {
            return Vec::new();
        }
        ids.truncate(size as usize / std::mem::size_of::<u32>());
        ids
    }
}

fn audio_u32(object: AudioObjectId, selector: u32, scope: u32) -> Option<u32> {
    let addr = address(selector, scope);
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: a u32 property read into a u32.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            (&mut value as *mut u32).cast(),
        )
    };
    (status == 0).then_some(value)
}

/// A device with input streams (a microphone, not only speakers).
fn has_input(device: AudioObjectId) -> bool {
    let addr = address(STREAMS, SCOPE_INPUT);
    let mut size = 0u32;
    // SAFETY: a size query.
    unsafe {
        AudioObjectGetPropertyDataSize(device, &addr, 0, std::ptr::null(), &mut size) == 0
            && size > 0
    }
}

/// Some microphone is being captured by some app.
pub fn mic_in_use() -> bool {
    audio_ids(SYSTEM_OBJECT, DEVICES)
        .into_iter()
        .filter(|d| has_input(*d))
        .any(|d| audio_u32(d, RUNNING_SOMEWHERE, SCOPE_GLOBAL).is_some_and(|v| v != 0))
}

/// Some camera is being used by some app.
pub fn cam_in_use() -> bool {
    let addr = address(DEVICES, SCOPE_GLOBAL);
    let mut size = 0u32;
    // SAFETY: size query, a buffer of that size, then u32 reads.
    unsafe {
        if CMIOObjectGetPropertyDataSize(SYSTEM_OBJECT, &addr, 0, std::ptr::null(), &mut size) != 0
        {
            return false;
        }
        let mut ids = vec![0u32; size as usize / std::mem::size_of::<u32>()];
        let mut used = 0u32;
        if CMIOObjectGetPropertyData(
            SYSTEM_OBJECT,
            &addr,
            0,
            std::ptr::null(),
            size,
            &mut used,
            ids.as_mut_ptr().cast(),
        ) != 0
        {
            return false;
        }
        ids.truncate(used as usize / std::mem::size_of::<u32>());
        ids.into_iter().any(|id| {
            let addr = address(RUNNING_SOMEWHERE, SCOPE_GLOBAL);
            let mut value = 0u32;
            let mut used = 0u32;
            CMIOObjectGetPropertyData(
                id,
                &addr,
                0,
                std::ptr::null(),
                std::mem::size_of::<u32>() as u32,
                &mut used,
                (&mut value as *mut u32).cast(),
            ) == 0
                && value != 0
        })
    }
}

/// Bundle ids of the processes capturing audio input (macOS 14+). Read
/// only to pick a category (ADR-0012); never recorded.
pub fn capturing_bundle_ids() -> Vec<String> {
    audio_ids(SYSTEM_OBJECT, PROCESS_LIST)
        .into_iter()
        .filter(|p| audio_u32(*p, PROCESS_RUNNING_INPUT, SCOPE_GLOBAL).is_some_and(|v| v != 0))
        .filter_map(bundle_id)
        .collect()
}

fn bundle_id(process: AudioObjectId) -> Option<String> {
    let addr = address(PROCESS_BUNDLE_ID, SCOPE_GLOBAL);
    let mut s: CFStringRef = std::ptr::null();
    let mut size = std::mem::size_of::<CFStringRef>() as u32;
    // SAFETY: the property is a retained CFString (the Get rule's
    // exception for Core Audio copies), copied out and released here.
    unsafe {
        if AudioObjectGetPropertyData(
            process,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            (&mut s as *mut CFStringRef).cast(),
        ) != 0
            || s.is_null()
        {
            return None;
        }
        let mut buf = [0 as c_char; 256];
        let ok = CFStringGetCString(
            s,
            buf.as_mut_ptr(),
            buf.len() as isize,
            K_CF_STRING_ENCODING_UTF8,
        ) != 0;
        CFRelease(s);
        if !ok {
            return None;
        }
        std::ffi::CStr::from_ptr(buf.as_ptr())
            .to_str()
            .ok()
            .map(str::to_string)
    }
}

/// Mic and camera in use now, with the kind of call (ADR-0012): apps on
/// the ignore list don't count; an unknown app is "other".
pub fn media() -> crate::watchers::poll::Media {
    use crate::call_type;
    let capturing = capturing_bundle_ids();
    let apps: Vec<&String> = capturing
        .iter()
        .filter(|b| !call_type::is_ignored(b))
        .collect();
    let every_capture_ignored = apps.is_empty() && !capturing.is_empty();
    let mic = mic_in_use() && !every_capture_ignored;
    let cam = cam_in_use();
    let call_type = (mic || cam).then(|| {
        call_type::pick(apps.iter().map(|b| call_type::classify(b)))
            .unwrap_or(call_type::CallType::Other)
    });
    crate::watchers::poll::Media {
        mic,
        cam,
        call_type,
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
        // Headless CI: usually nothing is capturing.
        let m = media();
        assert_eq!(m.call_type.is_some(), m.mic || m.cam);
        let _ = capturing_bundle_ids();
    }
}
