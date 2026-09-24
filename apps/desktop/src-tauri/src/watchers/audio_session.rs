//! "Is any process capturing from a microphone right now, and what
//! kind of call is it?" via the Core Audio session API — the primary
//! mic source in ADR-0003 §7.
//!
//! For every active capture endpoint, enumerate its audio sessions
//! (`IAudioSessionManager2`). Each active session other than the
//! system-sounds one counts as capturing; its owning process's
//! executable file name is classified into a [`CallType`] (ADR-0012).
//!
//! Only the category leaves this module. The executable name is read
//! into a local buffer, classified, and dropped — never stored,
//! logged, or sent. No audio is ever read (invariant 1).
//!
//! Complements the consent-store registry check in `mic_cam.rs`, which
//! misses some apps: a live, unmuted Teams call left no in-use entry
//! there during the PR D smoke test (2026-09-24).

use windows::core::{Interface, PWSTR};
use windows::Win32::Foundation::{CloseHandle, S_OK};
use windows::Win32::Media::Audio::{
    eCapture, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::call_type::{self, CallType};

/// True iff any non-system session on any active capture endpoint is
/// active.
pub fn capture_session_active() -> bool {
    active_call_type().is_some()
}

/// Kind of call for the active capture sessions, or `None` if nothing
/// is capturing. Any COM failure reads as "not capturing" (fail safe
/// per ADR-0003 §7: the prompt still fires, and "On a phone call"
/// remains available). A session whose process can't be resolved
/// counts as [`CallType::Other`].
pub fn active_call_type() -> Option<CallType> {
    // SAFETY: plain COM calls on interfaces we own for the duration
    // of the call. CoInitializeEx is idempotent per thread (S_FALSE
    // when already initialised); the watcher thread lives for the
    // process, so it never uninitialises.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let devices = enumerator
            .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
            .ok()?;
        let mut found = Vec::new();
        for i in 0..devices.GetCount().unwrap_or(0) {
            let Ok(device) = devices.Item(i) else {
                continue;
            };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                continue;
            };
            let Ok(sessions) = manager.GetSessionEnumerator() else {
                continue;
            };
            for j in 0..sessions.GetCount().unwrap_or(0) {
                let Ok(session) = sessions.GetSession(j) else {
                    continue;
                };
                if !matches!(session.GetState(), Ok(s) if s == AudioSessionStateActive) {
                    continue;
                }
                let Ok(s2) = session.cast::<IAudioSessionControl2>() else {
                    found.push(CallType::Other);
                    continue;
                };
                if s2.IsSystemSoundsSession() == S_OK {
                    continue;
                }
                let exe = s2.GetProcessId().ok().and_then(exe_of);
                // Apps that hold the mic open while idle never count
                // (ADR-0012 §1a).
                if exe.as_deref().is_some_and(call_type::is_ignored) {
                    continue;
                }
                found.push(exe.map_or(CallType::Other, |e| call_type::classify(&e)));
            }
        }
        call_type::pick(found)
    }
}

/// Full executable path of `pid`, or `None` if it can't be read
/// (process gone, protected, pid 0). The result is only classified,
/// never kept.
fn exe_of(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    // SAFETY: the handle is opened with the least access that allows
    // the query and closed before returning; the buffer outlives the
    // call and `len` is its capacity in UTF-16 units.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        ok.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Manual probe against the real machine:
    /// `cargo test -p cloudpunch-desktop --lib --offline live_capture_probe -- --ignored --nocapture`
    #[test]
    #[ignore = "reads live OS audio state"]
    fn live_capture_probe() {
        println!("capture_session_active = {}", capture_session_active());
        println!("active_call_type = {:?}", active_call_type());
        // Counts only: endpoints, sessions per endpoint, state codes
        // (0 inactive, 1 active, 2 expired), system-sounds flag.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let e: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap();
            let devices = e.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE).unwrap();
            let n = devices.GetCount().unwrap();
            println!("active capture endpoints = {n}");
            for i in 0..n {
                let d = devices.Item(i).unwrap();
                match d.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) {
                    Err(err) => println!("  endpoint {i}: activate failed {err}"),
                    Ok(m) => {
                        let ss = m.GetSessionEnumerator().unwrap();
                        let c = ss.GetCount().unwrap();
                        let states: Vec<String> = (0..c)
                            .map(|j| {
                                let s = ss.GetSession(j).unwrap();
                                let st = s.GetState().map(|x| x.0).unwrap_or(-1);
                                let sys = s
                                    .cast::<IAudioSessionControl2>()
                                    .is_ok_and(|s2| s2.IsSystemSoundsSession() == S_OK);
                                format!("{st}{}", if sys { "s" } else { "" })
                            })
                            .collect();
                        println!("  endpoint {i}: sessions={c} states={states:?}");
                    }
                }
            }
        }
    }
}
