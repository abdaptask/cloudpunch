//! Network reachability watcher (Windows).
//!
//! Polls `INetworkListManager.GetConnectivity()` every 5 s and emits
//! `NetworkReachabilityChanged` only when the boolean flips. "Reachable"
//! means the bitmask has either `NLM_CONNECTIVITY_IPV4_INTERNET` or
//! `NLM_CONNECTIVITY_IPV6_INTERNET` set — anything more granular (LAN
//! only, no traffic, subnet) is not internet-reachable for our purposes.
//!
//! Poll rather than event-sink because:
//!   - `INetworkEvents` requires a hand-rolled COM sink + STA message
//!     pump + connection-point advise/unadvise + reference-cycle care.
//!   - The state machine tolerates seconds of latency; the outbox
//!     absorbs any brief drop.
//!
//! Apartment: `CoInitializeEx(COINIT_APARTMENTTHREADED)` on the watcher
//! thread at start, `CoUninitialize` at exit. All COM objects go out of
//! scope inside the poll fn before uninit runs, so ordering is correct
//! by construction.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};

use windows::Win32::Networking::NetworkListManager::{
    INetworkListManager, NetworkListManager, NLM_CONNECTIVITY_IPV4_INTERNET,
    NLM_CONNECTIVITY_IPV6_INTERNET,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
};

use super::{OsSignal, Watcher, WatcherHandle};

#[derive(Debug, Clone, Copy)]
pub struct NetworkConfig {
    pub poll_interval: Duration,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(5),
        }
    }
}

/// Abstract "is the internet reachable?" so the poll loop can be
/// unit-tested against a mock without touching COM.
pub trait ConnectivityProbe: Send {
    fn is_reachable(&self) -> bool;
}

pub struct WindowsConnectivityProbe;

impl ConnectivityProbe for WindowsConnectivityProbe {
    fn is_reachable(&self) -> bool {
        // Safety: single COM call, no references retained after
        // return. Fail-closed on any error (treat as unreachable).
        unsafe {
            let nlm: INetworkListManager =
                match CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL) {
                    Ok(o) => o,
                    Err(_) => return false,
                };
            match nlm.GetConnectivity() {
                Ok(c) => reduce_reachable(c.0 as u32),
                Err(_) => false,
            }
        }
    }
}

/// Reduce an `NLM_CONNECTIVITY` bitmask to a single reachable
/// boolean. Only the two internet-reachability bits count.
fn reduce_reachable(mask: u32) -> bool {
    let internet_bits =
        (NLM_CONNECTIVITY_IPV4_INTERNET.0 as u32) | (NLM_CONNECTIVITY_IPV6_INTERNET.0 as u32);
    (mask & internet_bits) != 0
}

pub struct NetworkWatcher<P: ConnectivityProbe + 'static> {
    pub config: NetworkConfig,
    pub probe: P,
}

impl<P: ConnectivityProbe + 'static> NetworkWatcher<P> {
    pub fn new(config: NetworkConfig, probe: P) -> Self {
        Self { config, probe }
    }
}

pub struct NetworkHandle {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl WatcherHandle for NetworkHandle {
    fn shutdown(mut self: Box<Self>) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl<P: ConnectivityProbe + 'static> Watcher for NetworkWatcher<P> {
    fn start(self, tx: Sender<OsSignal>) -> Box<dyn WatcherHandle> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let config = self.config;
        let probe = self.probe;

        let thread = thread::Builder::new()
            .name("cp-network-watcher".into())
            .spawn(move || {
                // CoInitialize on a fresh thread returns S_OK (or
                // RPC_E_CHANGED_MODE if this thread was somehow
                // already initialised in a different apartment — we
                // don't spawn twice, so unreachable in practice).
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                }

                let mut last: Option<bool> = None;
                while !stop_clone.load(Ordering::Acquire) {
                    let reachable = probe.is_reachable();
                    if last != Some(reachable) {
                        let _ = tx.send(OsSignal::NetworkReachabilityChanged {
                            reachable,
                            at: SystemTime::now(),
                        });
                        last = Some(reachable);
                    }
                    thread::sleep(config.poll_interval);
                }

                unsafe {
                    CoUninitialize();
                }
            })
            .expect("failed to spawn cp-network-watcher thread");

        Box::new(NetworkHandle {
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
    fn reduce_true_when_ipv4_internet_bit_set() {
        let mask = NLM_CONNECTIVITY_IPV4_INTERNET.0 as u32;
        assert!(reduce_reachable(mask));
    }

    #[test]
    fn reduce_true_when_ipv6_internet_bit_set() {
        let mask = NLM_CONNECTIVITY_IPV6_INTERNET.0 as u32;
        assert!(reduce_reachable(mask));
    }

    #[test]
    fn reduce_true_when_both_bits_set() {
        let mask =
            (NLM_CONNECTIVITY_IPV4_INTERNET.0 as u32) | (NLM_CONNECTIVITY_IPV6_INTERNET.0 as u32);
        assert!(reduce_reachable(mask));
    }

    #[test]
    fn reduce_false_when_no_internet_bits_set() {
        // NLM_CONNECTIVITY_IPV4_SUBNET = 16, NLM_CONNECTIVITY_IPV6_SUBNET = 256,
        // NLM_CONNECTIVITY_IPV4_LOCALNETWORK = 32,
        // NLM_CONNECTIVITY_IPV6_LOCALNETWORK = 512 — LAN only is
        // NOT internet-reachable.
        for mask in [0u32, 16, 32, 256, 512, 16 | 32 | 256 | 512] {
            assert!(!reduce_reachable(mask), "mask {mask:#x}");
        }
    }

    // ---- watcher integration with a mock probe ----

    struct MockProbe {
        reachable: Arc<AtomicBool>,
    }

    impl ConnectivityProbe for MockProbe {
        fn is_reachable(&self) -> bool {
            self.reachable.load(Ordering::Acquire)
        }
    }

    #[test]
    fn watcher_emits_only_on_reachability_flips() {
        let reachable = Arc::new(AtomicBool::new(true));
        let watcher = NetworkWatcher::new(
            NetworkConfig {
                poll_interval: Duration::from_millis(5),
            },
            MockProbe {
                reachable: reachable.clone(),
            },
        );

        let (tx, rx) = channel();
        let handle = watcher.start(tx);

        // First poll emits (initial state is a change from None).
        let sig = rx
            .recv_timeout(Duration::from_millis(200))
            .expect("initial emit");
        assert!(matches!(
            sig,
            OsSignal::NetworkReachabilityChanged {
                reachable: true,
                ..
            }
        ));

        // Flip to offline.
        reachable.store(false, Ordering::Release);
        let sig = rx
            .recv_timeout(Duration::from_millis(200))
            .expect("offline emit");
        assert!(matches!(
            sig,
            OsSignal::NetworkReachabilityChanged {
                reachable: false,
                ..
            }
        ));

        // Stay offline — no additional emits.
        thread::sleep(Duration::from_millis(40));
        assert!(matches!(
            rx.recv_timeout(Duration::from_millis(20)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));

        // Flip back online.
        reachable.store(true, Ordering::Release);
        let sig = rx
            .recv_timeout(Duration::from_millis(200))
            .expect("online emit");
        assert!(matches!(
            sig,
            OsSignal::NetworkReachabilityChanged {
                reachable: true,
                ..
            }
        ));

        handle.shutdown();
    }
}
