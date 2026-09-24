//! "Is any process capturing from a microphone right now?" via the
//! Core Audio session API — the primary mic source in ADR-0003 §7.
//!
//! For every active capture endpoint, enumerate its audio sessions
//! (`IAudioSessionManager2`) and report true if any session other than
//! the system-sounds session is `AudioSessionStateActive`.
//!
//! Returns one boolean. We never read which process owns a session,
//! its display name, or any audio — invariant 1 (no content capture).
//!
//! Complements the consent-store registry check in `mic_cam.rs`, which
//! misses some apps: a live, unmuted Teams call left no in-use entry
//! there during the PR D smoke test (2026-09-24).

use windows::core::Interface;
use windows::Win32::Foundation::S_OK;
use windows::Win32::Media::Audio::{
    eCapture, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};

/// True iff any non-system session on any active capture endpoint is
/// active. Any COM failure reads as "not capturing" (fail safe per
/// ADR-0003 §7: the prompt still fires, and "On a phone call" remains
/// available).
pub fn capture_session_active() -> bool {
    // SAFETY: plain COM calls on interfaces we own for the duration
    // of the call. CoInitializeEx is idempotent per thread (S_FALSE
    // when already initialised); the watcher thread lives for the
    // process, so it never uninitialises.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(enumerator) =
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        else {
            return false;
        };
        let Ok(devices) = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) else {
            return false;
        };
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
                let is_system = session
                    .cast::<IAudioSessionControl2>()
                    .is_ok_and(|s2| s2.IsSystemSoundsSession() == S_OK);
                if !is_system {
                    return true;
                }
            }
        }
        false
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
