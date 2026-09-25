//! Session lock / unlock watcher (Windows).
//!
//! `WTSRegisterSessionNotification` requires an HWND that receives
//! `WM_WTSSESSION_CHANGE` messages. We spin up a dedicated thread
//! that:
//!   1. Registers a private window class (once per process, guarded
//!      by [`CLASS_REGISTERED`]).
//!   2. Creates a message-only window (`HWND_MESSAGE` parent) — no
//!      visible surface, no taskbar entry.
//!   3. Registers for WTS session notifications.
//!   4. Runs the standard `GetMessage` / `TranslateMessage` /
//!      `DispatchMessage` pump.
//!
//! The WndProc dispatches into a thread-local [`SENDER`] to hand off
//! [`OsSignal`]s. Since the pump thread is the same one that stored
//! the sender, no synchronisation is needed.
//!
//! `WM_QUIT` is posted via `PostThreadMessageW` from
//! [`SessionHandle::shutdown`]. Before the pump exits, we
//! `WTSUnRegisterSessionNotification` and `DestroyWindow`.
//!
//! The WndProc body is wrapped in `catch_unwind` because panicking
//! across an FFI boundary is UB.

use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::thread;
use std::time::SystemTime;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    RegisterClassExW, TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WM_QUIT,
    WM_WTSSESSION_CHANGE, WNDCLASSEXW, WNDCLASS_STYLES, WS_OVERLAPPED,
};

use super::{OsSignal, Watcher, WatcherHandle};

thread_local! {
    /// The sender the pump thread uses to fan signals out to the
    /// [`super::supervisor::Supervisor`]. `None` outside a running
    /// watcher; guaranteed `Some` inside [`wnd_proc`].
    static SENDER: RefCell<Option<Sender<OsSignal>>> = const { RefCell::new(None) };
}

static CLASS_REGISTERED: OnceLock<()> = OnceLock::new();

const CLASS_NAME: PCWSTR = w!("cloudpunch_session_watcher");

// From wtsapi32.h — the windows crate re-exports these but keeping
// them local makes the wparam decode readable.
const WTS_SESSION_LOCK: u32 = 0x7;
const WTS_SESSION_UNLOCK: u32 = 0x8;

/// Pure decode of a `WM_WTSSESSION_CHANGE` wparam into an
/// [`OsSignal`]. Codes we don't care about (console connect/disconnect,
/// remote logon, session logoff, etc.) map to `None`.
fn decode_wparam(wparam: usize, at: SystemTime) -> Option<OsSignal> {
    match wparam as u32 {
        WTS_SESSION_LOCK => Some(OsSignal::SessionLocked { at }),
        WTS_SESSION_UNLOCK => Some(OsSignal::SessionUnlocked { at }),
        _ => None,
    }
}

pub struct SessionWatcher;

impl SessionWatcher {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SessionWatcher {
    fn default() -> Self {
        Self::new()
    }
}

pub struct SessionHandle {
    thread_id: u32,
    thread: Option<thread::JoinHandle<()>>,
}

impl WatcherHandle for SessionHandle {
    fn shutdown(mut self: Box<Self>) {
        // Post WM_QUIT to the pump thread. If the pump has already
        // exited (init failure, panic in wnd_proc), the post fails
        // silently and join still returns.
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW;
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Watcher for SessionWatcher {
    fn start(self, tx: Sender<OsSignal>) -> Box<dyn WatcherHandle> {
        // Two-way handshake: the pump thread reports back its
        // thread-id (needed for PostThreadMessage) once the pump is
        // live, or an error string if init failed. `expect`s here are
        // acceptable because init failure means Windows is in a state
        // we can't recover from at this layer (see follow-up note in
        // the CHANGELOG about lifting Watcher::start to Result).
        let (ready_tx, ready_rx) = channel::<Result<u32, String>>();

        let thread = thread::Builder::new()
            .name("cp-session-watcher".into())
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

                if let Err(e) =
                    unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) }
                {
                    unsafe {
                        let _ = DestroyWindow(hwnd);
                    }
                    let _ =
                        ready_tx.send(Err(format!("WTSRegisterSessionNotification failed: {e}")));
                    SENDER.with(|s| *s.borrow_mut() = None);
                    return;
                }

                let tid = unsafe { GetCurrentThreadId() };
                let _ = ready_tx.send(Ok(tid));

                unsafe { pump_messages() };

                unsafe {
                    let _ = WTSUnRegisterSessionNotification(hwnd);
                    let _ = DestroyWindow(hwnd);
                }

                SENDER.with(|s| *s.borrow_mut() = None);
            })
            .expect("failed to spawn cp-session-watcher thread");

        let thread_id = match ready_rx.recv() {
            Ok(Ok(tid)) => tid,
            Ok(Err(reason)) => panic!("session watcher init failed: {reason}"),
            Err(_) => panic!("session watcher thread died before signalling ready"),
        };

        Box::new(SessionHandle {
            thread_id,
            thread: Some(thread),
        })
    }
}

/// Register the window class (once per process) and create the
/// message-only window.
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
        // Zero return means failure — but we've called it exactly
        // once and the failure mode (duplicate class) can't happen
        // by construction. Ignore the return.
        let _atom = RegisterClassExW(&wc);
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
    // GetMessageW returns 0 on WM_QUIT, -1 on error, non-zero
    // otherwise. `.0 > 0` treats both quit and error as pump-exit.
    while GetMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0).0 > 0 {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // Panicking across an FFI boundary is UB. Wrap everything.
    let result = catch_unwind(AssertUnwindSafe(|| {
        if msg == WM_WTSSESSION_CHANGE {
            if let Some(signal) = decode_wparam(wparam.0, SystemTime::now()) {
                SENDER.with(|s| {
                    if let Some(tx) = s.borrow().as_ref() {
                        let _ = tx.send(signal);
                    }
                });
            }
            return LRESULT(0);
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
    fn decode_lock_and_unlock() {
        let at = SystemTime::UNIX_EPOCH;
        assert_eq!(
            decode_wparam(WTS_SESSION_LOCK as usize, at),
            Some(OsSignal::SessionLocked { at })
        );
        assert_eq!(
            decode_wparam(WTS_SESSION_UNLOCK as usize, at),
            Some(OsSignal::SessionUnlocked { at })
        );
    }

    #[test]
    fn decode_ignores_other_session_events() {
        let at = SystemTime::UNIX_EPOCH;
        // WTS_CONSOLE_CONNECT = 0x1, WTS_CONSOLE_DISCONNECT = 0x2,
        // WTS_REMOTE_CONNECT = 0x3, WTS_SESSION_LOGON = 0x5, etc.
        for code in [0x1u32, 0x2, 0x3, 0x4, 0x5, 0x6, 0x9, 0xA] {
            assert_eq!(decode_wparam(code as usize, at), None, "code {code:#x}");
        }
    }
}
