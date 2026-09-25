//! Microphone / camera in-use boolean watcher (Windows 10+).
//!
//! Production source is [`WindowsMediaState`]: the mic is in use if
//! any process has an active capture session
//! (`audio_session::capture_session_active`, ADR-0003 §7 primary) **or**
//! the consent store below says so (cross-check). The camera uses the
//! consent store only — there is no session API for video. The
//! consent store alone missed a live Teams call in the PR D smoke test.
//!
//! Consent-store source: the Windows Capability Access Manager Consent Store.
//! Under
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{microphone,webcam}\`
//! (and mirrored in `HKLM` for packaged/system apps), each app has a
//! subkey containing `LastUsedTimeStop` (`REG_QWORD`). A value of `0`
//! means "still in use." Any non-zero value is a stopped-using
//! timestamp.
//!
//! We walk both roots for both devices and reduce to two booleans
//! (`mic`, `cam`). **We never record which app** — invariant 1 (no
//! content capture, no per-app usage). The output of this module is
//! two bits per poll.
//!
//! Some devices have a nested `NonPackaged\<exe>\` layer for Win32
//! apps; we recurse one level for that specific key name only.
//!
//! Notification vs polling: `RegNotifyChangeKeyValue` is one-shot,
//! doesn't reliably cover nested subkey value changes, and needs
//! re-arming. Polling every 2 s is trivial CPU and simpler; the
//! state machine only reacts on the order of seconds anyway.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};

use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
use winreg::{RegKey, HKEY};

use super::{OsSignal, Watcher, WatcherHandle};
use crate::call_type::CallType;

const CONSENT_STORE_ROOT: &str =
    r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";

/// Names of the two consent-store device categories we care about.
const MIC_KEY: &str = "microphone";
const CAM_KEY: &str = "webcam";

#[derive(Debug, Clone, Copy)]
pub struct MicCamConfig {
    pub poll_interval: Duration,
}

impl Default for MicCamConfig {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(2),
        }
    }
}

/// Abstract "am I in use?" per device so the watcher loop can be
/// unit-tested without the real registry.
pub trait ConsentSource: Send {
    fn mic_in_use(&self) -> bool;
    fn cam_in_use(&self) -> bool;
    /// `(mic, cam, call_type)` in one read. Sources that can't tell
    /// the kind of call report `None`; the watcher maps an in-use
    /// device with no type to [`CallType::Other`].
    fn snapshot(&self) -> (bool, bool, Option<CallType>) {
        (self.mic_in_use(), self.cam_in_use(), None)
    }
}

#[cfg(target_os = "windows")]
pub struct WindowsConsentStore;

#[cfg(target_os = "windows")]
impl ConsentSource for WindowsConsentStore {
    fn mic_in_use(&self) -> bool {
        device_in_use(MIC_KEY)
    }
    fn cam_in_use(&self) -> bool {
        device_in_use(CAM_KEY)
    }
}

/// Mic from Core Audio capture sessions OR the consent store; camera
/// from the consent store. Still two booleans, never which app.
#[cfg(target_os = "windows")]
pub struct WindowsMediaState;

#[cfg(target_os = "windows")]
impl ConsentSource for WindowsMediaState {
    fn mic_in_use(&self) -> bool {
        super::audio_session::capture_session_active() || device_in_use(MIC_KEY)
    }
    fn cam_in_use(&self) -> bool {
        device_in_use(CAM_KEY)
    }
    /// One capture-session enumeration per poll: it yields both "in
    /// use" and the call type (ADR-0012).
    fn snapshot(&self) -> (bool, bool, Option<CallType>) {
        let session = super::audio_session::active_call_type();
        let mic = session.is_some() || device_in_use(MIC_KEY);
        (mic, device_in_use(CAM_KEY), session)
    }
}

/// True iff any app subkey under either HKCU or HKLM consent-store
/// path for `device` has `LastUsedTimeStop == 0`.
#[cfg(target_os = "windows")]
fn device_in_use(device: &str) -> bool {
    check_root(HKEY_CURRENT_USER, device) || check_root(HKEY_LOCAL_MACHINE, device)
}

/// Walk the consent-store subtree at `<root>\<CONSENT_STORE_ROOT>\<device>`
/// and return true on the first `LastUsedTimeStop == 0`. Missing keys
/// are treated as "not in use" (fresh installs have no ConsentStore).
#[cfg(target_os = "windows")]
fn check_root(root: HKEY, device: &str) -> bool {
    let full_path = format!("{CONSENT_STORE_ROOT}\\{device}");
    let key = match RegKey::predef(root).open_subkey_with_flags(&full_path, KEY_READ) {
        Ok(k) => k,
        Err(_) => return false,
    };
    for name in key.enum_keys().flatten() {
        // "NonPackaged" is a container for classic Win32 exes with
        // their own per-exe subkeys underneath. Recurse one level.
        if name == "NonPackaged" {
            if let Ok(np) = key.open_subkey(&name) {
                for exe in np.enum_keys().flatten() {
                    // Apps that hold the mic open while idle never
                    // count (ADR-0012 §1a).
                    if crate::call_type::is_ignored(&exe) {
                        continue;
                    }
                    if let Ok(sub) = np.open_subkey(&exe) {
                        if let Ok(stop) = sub.get_value::<u64, _>("LastUsedTimeStop") {
                            if stop == 0 {
                                return true;
                            }
                        }
                    }
                }
            }
            continue;
        }
        if let Ok(sub) = key.open_subkey(&name) {
            if let Ok(stop) = sub.get_value::<u64, _>("LastUsedTimeStop") {
                if stop == 0 {
                    return true;
                }
            }
        }
    }
    false
}

/// Pure reducer: given an iterable of `LastUsedTimeStop` values,
/// return true iff any is present and equals zero. The registry walk
/// above applies the same rule inline (with early exit); this keeps the
/// rule itself under test.
#[cfg(test)]
fn reduce_in_use<I: IntoIterator<Item = u64>>(stops: I) -> bool {
    stops.into_iter().any(|s| s == 0)
}

pub struct MicCamWatcher<S: ConsentSource + 'static> {
    pub config: MicCamConfig,
    pub source: S,
}

impl<S: ConsentSource + 'static> MicCamWatcher<S> {
    pub fn new(config: MicCamConfig, source: S) -> Self {
        Self { config, source }
    }
}

pub struct MicCamHandle {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl WatcherHandle for MicCamHandle {
    fn shutdown(mut self: Box<Self>) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl<S: ConsentSource + 'static> Watcher for MicCamWatcher<S> {
    fn start(self, tx: Sender<OsSignal>) -> Box<dyn WatcherHandle> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let config = self.config;
        let source = self.source;

        let thread = thread::Builder::new()
            .name("cp-miccam-watcher".into())
            .spawn(move || {
                let mut last: Option<(bool, bool, Option<CallType>)> = None;
                while !stop_clone.load(Ordering::Acquire) {
                    let (mic, cam, kind) = source.snapshot();
                    let call_type = (mic || cam).then(|| kind.unwrap_or(CallType::Other));
                    let current = (mic, cam, call_type);
                    if last != Some(current) {
                        let _ = tx.send(OsSignal::MediaInUseChanged {
                            mic,
                            cam,
                            call_type,
                            at: SystemTime::now(),
                        });
                        last = Some(current);
                    }
                    thread::sleep(config.poll_interval);
                }
            })
            .expect("failed to spawn cp-miccam-watcher thread");

        Box::new(MicCamHandle {
            stop,
            thread: Some(thread),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    // ---- pure reducer ----

    #[test]
    fn reduce_true_if_any_stop_is_zero() {
        assert!(reduce_in_use([100, 200, 0, 300]));
        assert!(reduce_in_use([0]));
    }

    #[test]
    fn reduce_false_if_none_are_zero() {
        assert!(!reduce_in_use([100, 200, 300]));
    }

    #[test]
    fn reduce_false_on_empty() {
        assert!(!reduce_in_use(std::iter::empty()));
    }

    // ---- watcher integration with a mock source ----

    struct MockSource {
        mic: Arc<AtomicBool>,
        cam: Arc<AtomicBool>,
    }

    impl ConsentSource for MockSource {
        fn mic_in_use(&self) -> bool {
            self.mic.load(Ordering::Acquire)
        }
        fn cam_in_use(&self) -> bool {
            self.cam.load(Ordering::Acquire)
        }
    }

    #[test]
    fn watcher_emits_only_on_change() {
        let mic = Arc::new(AtomicBool::new(false));
        let cam = Arc::new(AtomicBool::new(false));
        let watcher = MicCamWatcher::new(
            MicCamConfig {
                poll_interval: Duration::from_millis(5),
            },
            MockSource {
                mic: mic.clone(),
                cam: cam.clone(),
            },
        );

        let (tx, rx) = channel();
        let handle = watcher.start(tx);

        // First poll from initial (false, false) is a change (from
        // None), so it emits once.
        let first = rx
            .recv_timeout(Duration::from_millis(200))
            .expect("initial state emit");
        assert!(matches!(
            first,
            OsSignal::MediaInUseChanged {
                mic: false,
                cam: false,
                ..
            }
        ));

        // Flip mic on -> change -> emit.
        mic.store(true, Ordering::Release);
        let sig = rx
            .recv_timeout(Duration::from_millis(200))
            .expect("mic-on emit");
        assert!(matches!(
            sig,
            OsSignal::MediaInUseChanged {
                mic: true,
                cam: false,
                ..
            }
        ));

        // Cam on -> emit.
        cam.store(true, Ordering::Release);
        let sig = rx
            .recv_timeout(Duration::from_millis(200))
            .expect("cam-on emit");
        assert!(matches!(
            sig,
            OsSignal::MediaInUseChanged {
                mic: true,
                cam: true,
                ..
            }
        ));

        // No change for a while -> no emit.
        thread::sleep(Duration::from_millis(50));
        assert!(matches!(
            rx.recv_timeout(Duration::from_millis(20)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));

        // Everything off -> single emit.
        mic.store(false, Ordering::Release);
        cam.store(false, Ordering::Release);
        let sig = rx
            .recv_timeout(Duration::from_millis(200))
            .expect("all-off emit");
        assert!(matches!(
            sig,
            OsSignal::MediaInUseChanged {
                mic: false,
                cam: false,
                ..
            }
        ));

        handle.shutdown();
    }
}
