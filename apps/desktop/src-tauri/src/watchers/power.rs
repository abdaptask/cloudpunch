//! Sleep / wake watcher (Windows).
//!
//! Uses `RegisterSuspendResumeNotification` with
//! `DEVICE_NOTIFY_WINDOW_HANDLE`. The registered window receives
//! `WM_POWERBROADCAST` with these `wParam` codes we care about:
//!   - `PBT_APMSUSPEND` (4)          → `Suspending`
//!   - `PBT_APMRESUMEAUTOMATIC` (18) → `Resumed`
//!   - `PBT_APMRESUMESUSPEND` (7)    → `Resumed` (user-triggered
//!     wake; ADR-0003 doesn't distinguish resume flavours)
//!
//! Structure mirrors [`super::session`]: dedicated thread with a
//! message-only window, `thread_local!` `Sender`, `OnceLock`-guarded
//! class registration, ready-signal handshake, `catch_unwind` around
//! `WndProc`. When we've seen 3–4 watchers with this shape a shared
//! helper may earn its keep — evaluating that after 2b.5.5 lands.

use std::cell::{Cell, RefCell};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::thread;
use std::time::SystemTime;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::{
    RegisterSuspendResumeNotification, UnregisterSuspendResumeNotification, HPOWERNOTIFY,
};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    PostThreadMessageW, RegisterClassExW, TranslateMessage, DEVICE_NOTIFY_WINDOW_HANDLE,
    HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WM_POWERBROADCAST, WM_QUIT, WNDCLASSEXW, WNDCLASS_STYLES,
    WS_OVERLAPPED,
};

use super::{OsSignal, Watcher, WatcherHandle};

thread_local! {
    static SENDER: RefCell<Option<Sender<OsSignal>>> = const { RefCell::new(None) };
    /// Registration handle stored per-thread so the pump can
    /// unregister before destroying the window.
    static HPOWER: Cell<isize> = const { Cell::new(0) };
}

static CLASS_REGISTERED: OnceLock<()> = OnceLock::new();

const CLASS_NAME: PCWSTR = w!("cloudpunch_power_watcher");

// From WinUser.h — keep local for readability.
const PBT_APMSUSPEND: u32 = 0x4;
const PBT_APMRESUMESUSPEND: u32 = 0x7;
const PBT_APMRESUMEAUTOMATIC: u32 = 0x12;

/// Decode a `WM_POWERBROADCAST` wparam into an [`OsSignal`], or
/// `None` if the event is one we don't track (power-setting change,
/// battery status, oem event, etc.).
fn decode_wparam(wparam: usize, at: SystemTime) -> Option<OsSignal> {
    match wparam as u32 {
        PBT_APMSUSPEND => Some(OsSignal::Suspending { at }),
        PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => Some(OsSignal::Resumed { at }),
        _ => None,
    }
}

pub struct PowerWatcher;

impl PowerWatcher {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PowerWatcher {
    fn default() -> Self {
        Self::new()
    }
}

pub struct PowerHandle {
    thread_id: u32,
    thread: Option<thread::JoinHandle<()>>,
}

impl WatcherHandle for PowerHandle {
    fn shutdown(mut self: Box<Self>) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Watcher for PowerWatcher {
    fn start(self, tx: Sender<OsSignal>) -> Box<dyn WatcherHandle> {
        let (ready_tx, ready_rx) = channel::<Result<u32, String>>();

        let thread = thread::Builder::new()
            .name("cp-power-watcher".into())
            .spawn(move || {
                SENDER.with(|s| *s.borrow_mut() = Some(tx));

                let hwnd = match unsafe { create_message_window() } {
                    Ok(h) => h,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        SENDER.with(|s| *s.borrow_mut() = None);
                        return;
                    }
                };

                // hwnd is a *mut c_void in windows 0.58; HANDLE
                // wraps *mut c_void too, so this cast is a matter
                // of nominal type only.
                let recipient = HANDLE(hwnd.0);
                let hpower = match unsafe {
                    RegisterSuspendResumeNotification(recipient, DEVICE_NOTIFY_WINDOW_HANDLE)
                } {
                    Ok(h) => h,
                    Err(e) => {
                        unsafe {
                            let _ = DestroyWindow(hwnd);
                        }
                        let _ =
                            ready_tx.send(Err(format!("RegisterSuspendResumeNotification: {e}")));
                        SENDER.with(|s| *s.borrow_mut() = None);
                        return;
                    }
                };
                HPOWER.with(|c| c.set(hpower.0));

                let tid = unsafe { GetCurrentThreadId() };
                let _ = ready_tx.send(Ok(tid));

                unsafe { pump_messages() };

                unsafe {
                    let _ =
                        UnregisterSuspendResumeNotification(HPOWERNOTIFY(HPOWER.with(|c| c.get())));
                    let _ = DestroyWindow(hwnd);
                }
                HPOWER.with(|c| c.set(0));
                SENDER.with(|s| *s.borrow_mut() = None);
            })
            .expect("failed to spawn cp-power-watcher thread");

        let thread_id = match ready_rx.recv() {
            Ok(Ok(tid)) => tid,
            Ok(Err(reason)) => panic!("power watcher init failed: {reason}"),
            Err(_) => panic!("power watcher thread died before signalling ready"),
        };

        Box::new(PowerHandle {
            thread_id,
            thread: Some(thread),
        })
    }
}

unsafe fn create_message_window() -> Result<HWND, String> {
    let hinstance: HINSTANCE = GetModuleHandleW(None)
        .map_err(|e| format!("GetModuleHandleW: {e}"))?
        .into();

    CLASS_REGISTERED.get_or_init(|| {
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: WNDCLASS_STYLES(0),
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: Default::default(),
            hCursor: Default::default(),
            hbrBackground: Default::default(),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: CLASS_NAME,
            hIconSm: Default::default(),
        };
        let _ = RegisterClassExW(&wc);
    });

    let hwnd = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        CLASS_NAME,
        PCWSTR::null(),
        WS_OVERLAPPED,
        0,
        0,
        0,
        0,
        HWND_MESSAGE,
        None,
        hinstance,
        None,
    )
    .map_err(|e| format!("CreateWindowExW: {e}"))?;

    Ok(hwnd)
}

unsafe fn pump_messages() {
    let mut msg = MSG::default();
    while GetMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0).0 > 0 {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if msg == WM_POWERBROADCAST {
            if let Some(signal) = decode_wparam(wparam.0, SystemTime::now()) {
                SENDER.with(|s| {
                    if let Some(tx) = s.borrow().as_ref() {
                        let _ = tx.send(signal);
                    }
                });
            }
            // Return TRUE for suspend requests so we don't block
            // suspension; documented Win32 contract.
            return LRESULT(1);
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }));
    match result {
        Ok(lr) => lr,
        Err(_) => LRESULT(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_suspend_and_resume() {
        let at = SystemTime::UNIX_EPOCH;
        assert_eq!(
            decode_wparam(PBT_APMSUSPEND as usize, at),
            Some(OsSignal::Suspending { at })
        );
        assert_eq!(
            decode_wparam(PBT_APMRESUMEAUTOMATIC as usize, at),
            Some(OsSignal::Resumed { at })
        );
        assert_eq!(
            decode_wparam(PBT_APMRESUMESUSPEND as usize, at),
            Some(OsSignal::Resumed { at })
        );
    }

    #[test]
    fn decode_ignores_unrelated_power_events() {
        let at = SystemTime::UNIX_EPOCH;
        // PBT_APMBATTERYLOW=9, PBT_APMPOWERSTATUSCHANGE=10,
        // PBT_APMOEMEVENT=11, PBT_APMQUERYSUSPEND=0,
        // PBT_APMQUERYSUSPENDFAILED=2, PBT_POWERSETTINGCHANGE=32787
        for code in [0x0u32, 0x2, 0x9, 0xA, 0xB, 32787] {
            assert_eq!(decode_wparam(code as usize, at), None, "code {code:#x}");
        }
    }
}
