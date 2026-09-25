//! Multi-watcher fan-in with orderly shutdown.
//!
//! Owns the receiving end of the [`OsSignal`] channel and a vector
//! of [`WatcherHandle`]s. Callers can either read signals inline via
//! [`Supervisor::recv`]/`recv_timeout`, or [`take_receiver`] the
//! `Receiver` out and drive it on a separate thread (used by the
//! app entry point to `eprintln!` signals for smoke tests).

use std::sync::mpsc::{channel, Receiver, RecvError, RecvTimeoutError, Sender};
use std::time::Duration;

use super::{OsSignal, WatcherHandle};

/// Coordinates one or more watchers behind a single signal channel.
pub struct Supervisor {
    rx: Option<Receiver<OsSignal>>,
    tx: Sender<OsSignal>,
    handles: Vec<Box<dyn WatcherHandle>>,
}

impl Supervisor {
    pub fn new() -> Self {
        let (tx, rx) = channel();
        Self {
            rx: Some(rx),
            tx,
            handles: Vec::new(),
        }
    }

    /// Clone the sender end so a watcher can be started against this
    /// supervisor. Attach the returned handle with
    /// [`Supervisor::attach`].
    pub fn sender(&self) -> Sender<OsSignal> {
        self.tx.clone()
    }

    pub fn attach(&mut self, handle: Box<dyn WatcherHandle>) {
        self.handles.push(handle);
    }

    /// Hand the `Receiver` off to a consumer that will drive it on
    /// its own thread. Returns `None` if the receiver has already
    /// been taken.
    ///
    /// After the receiver is taken, [`Supervisor::recv`] and
    /// [`Supervisor::recv_timeout`] panic on use.
    pub fn take_receiver(&mut self) -> Option<Receiver<OsSignal>> {
        self.rx.take()
    }

    /// Block until the next signal. Panics if the receiver has been
    /// taken via [`Supervisor::take_receiver`].
    pub fn recv(&self) -> Result<OsSignal, RecvError> {
        self.rx
            .as_ref()
            .expect("Supervisor::recv called after take_receiver")
            .recv()
    }

    /// Block for at most `timeout`. Panics if the receiver has been
    /// taken via [`Supervisor::take_receiver`].
    pub fn recv_timeout(&self, timeout: Duration) -> Result<OsSignal, RecvTimeoutError> {
        self.rx
            .as_ref()
            .expect("Supervisor::recv_timeout called after take_receiver")
            .recv_timeout(timeout)
    }

    /// Stop every watcher (blocking on each in registration order),
    /// then drop the receiver.
    pub fn shutdown(self) {
        for handle in self.handles {
            handle.shutdown();
        }
        // rx and tx drop here; any straggler send from a watcher that
        // ignored shutdown will fail cleanly on a closed channel.
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, SystemTime};

    struct DummyHandle {
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl WatcherHandle for DummyHandle {
        fn shutdown(mut self: Box<Self>) {
            self.stop.store(true, Ordering::Release);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    fn spawn_dummy(tx: Sender<OsSignal>) -> Box<dyn WatcherHandle> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let thread = thread::spawn(move || {
            while !stop_clone.load(Ordering::Acquire) {
                let _ = tx.send(OsSignal::Resumed {
                    at: SystemTime::now(),
                });
                thread::sleep(Duration::from_millis(5));
            }
        });
        Box::new(DummyHandle {
            stop,
            thread: Some(thread),
        })
    }

    #[test]
    fn supervisor_receives_signals_from_attached_watcher() {
        let mut sup = Supervisor::new();
        let handle = spawn_dummy(sup.sender());
        sup.attach(handle);

        let sig = sup
            .recv_timeout(Duration::from_millis(200))
            .expect("should receive at least one signal within 200ms");
        assert!(matches!(sig, OsSignal::Resumed { .. }));

        sup.shutdown();
    }

    #[test]
    fn shutdown_stops_watcher_threads() {
        let mut sup = Supervisor::new();
        let handle = spawn_dummy(sup.sender());
        sup.attach(handle);

        // Drain a couple to confirm the thread is live.
        let _ = sup.recv_timeout(Duration::from_millis(200));
        sup.shutdown();
        // If shutdown didn't join the thread we'd risk leaking it;
        // the test itself asserts return-from-shutdown.
    }

    #[test]
    fn take_receiver_hands_out_the_channel_once() {
        let mut sup = Supervisor::new();
        assert!(sup.take_receiver().is_some());
        assert!(
            sup.take_receiver().is_none(),
            "second take should return None"
        );
    }

    #[test]
    fn taken_receiver_still_gets_signals_after_shutdown_closes_channel() {
        let mut sup = Supervisor::new();
        let handle = spawn_dummy(sup.sender());
        sup.attach(handle);
        let rx = sup
            .take_receiver()
            .expect("fresh supervisor has a receiver");

        // At least one signal should be observable before shutdown.
        assert!(matches!(
            rx.recv_timeout(Duration::from_millis(200)),
            Ok(OsSignal::Resumed { .. })
        ));

        // Shutdown stops the watcher thread; its Sender clone drops.
        // The Supervisor's own Sender drops with `self`. After that,
        // the receiver eventually reports RecvError::Disconnected.
        sup.shutdown();

        // Drain anything already queued, then confirm disconnect.
        while rx.recv_timeout(Duration::from_millis(50)).is_ok() {}
        assert!(rx.recv().is_err(), "channel should be closed");
    }
}
