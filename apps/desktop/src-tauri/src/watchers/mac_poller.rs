//! macOS watcher (ADR-0026 §2): samples screen lock, network
//! reachability, mic/camera in use and the wall clock once a second,
//! and reports what changed through [`super::poll::PollState`]. Idle needs no watcher:
//! the core's tick reads the last-input time directly.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};

use super::poll::{PollState, Sample};
use super::{OsSignal, Watcher, WatcherHandle};

/// Network reachability is sampled this often (it is cheap, but not
/// needed every second).
const NETWORK_EVERY: u32 = 5;

pub struct MacPoller {
    /// Host whose reachability means "online" (the API's host).
    pub host: String,
}

pub struct MacPollerHandle {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl WatcherHandle for MacPollerHandle {
    fn shutdown(mut self: Box<Self>) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Watcher for MacPoller {
    fn start(self, tx: Sender<OsSignal>) -> Box<dyn WatcherHandle> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_t = stop.clone();
        let thread = thread::Builder::new()
            .name("cp-mac-poller".into())
            .spawn(move || {
                let mut state = PollState::default();
                let mut n = 0u32;
                while !stop_t.load(Ordering::Acquire) {
                    let reachable = (n % NETWORK_EVERY == 0)
                        .then(|| crate::macos::reachable(&self.host))
                        .flatten();
                    let sample = Sample {
                        at: SystemTime::now(),
                        locked: crate::macos::screen_locked(),
                        reachable,
                        media: Some(crate::macos::media()),
                    };
                    for signal in state.step(sample) {
                        let _ = tx.send(signal);
                    }
                    n = n.wrapping_add(1);
                    thread::sleep(Duration::from_secs(1));
                }
            })
            .expect("failed to spawn cp-mac-poller thread");
        Box::new(MacPollerHandle {
            stop,
            thread: Some(thread),
        })
    }
}
