# Changelog

All notable changes to CloudPunch are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Phase 2b.5.6 — supervisor wired into run(); smoke-test tracing (2026-09-23)

- `apps/desktop/src-tauri/src/lib.rs::run()` now starts all five
  Windows watchers on Tauri boot via a new `start_watchers()` fn
  that returns a `WatchersGuard`. Guard's `Drop` calls
  `Supervisor::shutdown()` (joining every watcher thread) then joins
  the drain thread — correct-by-construction shutdown ordering.
- Drain thread `eprintln!`s every `OsSignal`, gated behind
  `#[cfg(debug_assertions)]` so release builds are silent. Replace
  with `tracing` when the state machine actually needs structured
  logs.
- Non-Windows `start_watchers()` returns an inert guard so callers
  don't need conditional bindings. macOS impl lands in 2b.8.
- `Supervisor::take_receiver(&mut self) -> Option<Receiver<OsSignal>>`
  added so the drain thread can own the receiver end without the
  Supervisor keeping a `Sync`-hostile alias. Non-breaking; existing
  `recv` / `recv_timeout` still work until the receiver is taken (and
  panic clearly afterwards).
- 45 tests pass (2 new: `take_receiver_hands_out_the_channel_once`,
  `taken_receiver_still_gets_signals_after_shutdown_closes_channel`).

Smoke-test recipe documented in the commit message.

Refs: ADR-0003 §OS signals, CLAUDE.md invariant 1.

### Phase 2b.5.5 — Windows network reachability watcher (2026-09-23)

Final watcher in the 2b.5 sub-series. All five OS signals from
ADR-0003 now have Windows implementations.

- `apps/desktop/src-tauri/src/watchers/network.rs` (Windows-only):
  polls `INetworkListManager.GetConnectivity()` every 5 s. Reduces
  the returned bitmask to a single boolean:
  `(mask & (NLM_CONNECTIVITY_IPV4_INTERNET
          | NLM_CONNECTIVITY_IPV6_INTERNET)) != 0`. LAN-only, subnet,
  and traffic-only bits do NOT count as reachable.
- Emits `NetworkReachabilityChanged { reachable, at }` only when the
  boolean flips (or on first poll). No SSID, no adapter, no address
  — just up/down.
- COM lifecycle handled on the watcher thread:
  `CoInitializeEx(COINIT_APARTMENTTHREADED)` at start,
  `CoUninitialize` at exit. `INetworkListManager` objects are created
  per-poll and dropped before uninit — no lifetime hazard, no
  reference cycles, no message pump.
- Poll-vs-event-sink decision: `INetworkEvents` sink would be
  event-driven but requires ~4× the code (hand-rolled COM sink with
  `#[implement]`, connection-point advise/unadvise, STA message
  pump, reference-cycle care). The state machine tolerates
  seconds-level latency; the outbox absorbs the gap.
- `ConnectivityProbe` trait behind the COM call lets the poll loop
  be integration-tested against a mock.
- Cargo features added: `Win32_System_Com`,
  `Win32_Networking_NetworkListManager`.
- 43 tests pass (5 new: 4 pure reducer + 1 mocked watcher
  integration).

Follow-ups tracked separately:
  - Wire the supervisor into `lib.rs::run()` so watchers actually
    start when the Tauri app launches (small integration slice).
  - Evaluate a `MessagePumpWatcher` helper to deduplicate
    `session.rs` + `power.rs` (does not apply to idle/mic_cam/network,
    which are simple threads).

Refs: ADR-0003 §OS signals, CLAUDE.md invariant 1.

### Phase 2b.5.4 — Windows mic/cam in-use boolean watcher (2026-09-23)

- `apps/desktop/src-tauri/src/watchers/mic_cam.rs` (Windows-only):
  polls the Capability Access Manager Consent Store every 2 s and
  emits `OsSignal::MediaInUseChanged { mic, cam, at }` only when
  either boolean flips (or on first poll).
- Walks both `HKCU` and `HKLM` under
  `Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{microphone,webcam}\`.
  Recurses one level into the `NonPackaged` subkey (classic Win32
  exes). `LastUsedTimeStop == 0` on any app = device in use.
- **Never records app identity.** The full output of this module per
  poll is two bits. Invariant 1 (no content capture, no per-app
  usage) is shielded at the boundary — the walk sees app subkeys but
  only reads one `REG_QWORD` field and reduces to a boolean.
- Missing consent-store keys (fresh installs) are treated as
  "not in use" — no error.
- `ConsentSource` trait behind the registry walk lets the poll loop
  be integration-tested against a mock without touching the real
  registry.
- New dep: `winreg = "0.52"` (Windows-only; safe wrappers around
  `Reg*W` FFI). Rationale for choosing a small dep over ~150 lines
  of `unsafe` FFI is captured inline in `Cargo.toml`.
- 38 tests pass (4 new: 3 pure reducer + 1 mocked watcher
  integration that verifies emit-only-on-change).

Refs: ADR-0003 §OS signals, CLAUDE.md invariant 1.

### Phase 2b.5.3 — Windows sleep/wake watcher (2026-09-23)

- `apps/desktop/src-tauri/src/watchers/power.rs` (Windows-only):
  `PowerWatcher` runs the same message-only-window pattern used by
  `session.rs`. Subscribes via
  `RegisterSuspendResumeNotification(hwnd, DEVICE_NOTIFY_WINDOW_HANDLE)`
  and dispatches `WM_POWERBROADCAST` codes:
  - `PBT_APMSUSPEND` → `OsSignal::Suspending`
  - `PBT_APMRESUMEAUTOMATIC` and `PBT_APMRESUMESUSPEND` →
    `OsSignal::Resumed` (ADR-0003 doesn't distinguish resume
    flavours, so we don't either).
- `HPOWERNOTIFY` handle stored in a per-thread `Cell<isize>` so the
  pump can `UnregisterSuspendResumeNotification` before destroying
  the window on shutdown.
- `WndProc` returns `TRUE` for handled power messages per the Win32
  contract (so we don't accidentally veto a suspend request).
- Feature flag added: `Win32_System_Power`.
- 34 tests pass (2 new: pure `decode_wparam` for both directions +
  ignored codes).

Deferred: the message-pump structure now duplicates ~70% between
`session.rs` and `power.rs`. A shared helper is on hold until 2b.5.4
(mic/cam poll) and 2b.5.5 (COM network sink) land — the network
watcher won't fit a message-pump helper, so any abstraction may only
cover 2 of 5 watchers.

Refs: ADR-0003 §OS signals, CLAUDE.md invariant 1.

### Phase 2b.5.2 — Windows session lock/unlock watcher (2026-09-23)

- `apps/desktop/src-tauri/src/watchers/session.rs` (Windows-only):
  `SessionWatcher` runs a dedicated thread with a message-only window
  (`HWND_MESSAGE` parent). Subscribes via
  `WTSRegisterSessionNotification(NOTIFY_FOR_THIS_SESSION)` and emits
  `SessionLocked` / `SessionUnlocked` on `WM_WTSSESSION_CHANGE`.
  Other WTS codes (console connect/disconnect, remote logon, session
  logoff, etc.) decode to `None`.
- Class registration guarded by `OnceLock` so multiple watchers in
  the same process can't collide on the window class name.
- `WndProc` looks up the `mpsc::Sender` via a `thread_local!` — the
  pump thread is the same thread that stored the sender, so no
  synchronisation is needed. `WndProc` body is wrapped in
  `catch_unwind` because unwinding across an FFI boundary is UB.
- Startup uses a ready-signal channel so `start()` blocks until the
  pump is live (thread-id captured), preventing a lost-message race
  with an immediate `shutdown()`. Shutdown posts `WM_QUIT` via
  `PostThreadMessageW` and joins.
- Feature flags added: `Win32_Graphics_Gdi` (transitively required by
  `WNDCLASSEXW`), `Win32_System_LibraryLoader`,
  `Win32_System_RemoteDesktop`, `Win32_System_Threading`,
  `Win32_UI_WindowsAndMessaging`.
- 32 tests pass (2 new: pure `decode_wparam` covering both directions
  + a batch that confirms unrelated WTS codes are ignored).

Follow-up (not this slice): `Watcher::start` will likely become
fallible (`Result<Box<dyn WatcherHandle>, WatcherError>`) once
mic/cam + network watchers reveal whether panic-on-init is tolerable
across all watchers. Currently `SessionWatcher` panics with a
descriptive message if window creation or WTS registration fails.

Refs: ADR-0003 §OS signals, CLAUDE.md invariant 1.

### Phase 2b.5.1 — OS watcher plumbing + Windows idle detection (2026-09-23)

First watcher slice per ADR-0003. Cross-platform seam + Windows idle
detection via `GetLastInputInfo`. Session, power, mic/cam, and network
watchers land in 2b.5.2 – 2b.5.5.

- `apps/desktop/src-tauri/src/watchers/mod.rs`: cross-platform `OsSignal`
  enum (idle, session lock/unlock, sleep/wake, mic/cam boolean, network
  reachability) and `Watcher` / `WatcherHandle` traits. Deliberately
  narrow — no app names, window titles, or device identifiers, per
  invariant 1 (no content capture).
- `apps/desktop/src-tauri/src/watchers/supervisor.rs`: mpsc fan-in that
  owns all watcher handles and blocks on shutdown so no signal is lost
  in flight.
- `apps/desktop/src-tauri/src/watchers/idle.rs`
  (`#[cfg(target_os = "windows")]`): `IdleWatcher` polls
  `GetLastInputInfo` / `GetTickCount` and emits `IdleSince` /
  `IdleEnded` on threshold crossing. Threshold-transition logic is a
  pure function tested against synthetic inputs; a `LastInputSource`
  trait lets the poll loop be integration-tested with a mock.
- `Cargo.toml`: added `windows = "0.58"` (target-gated to Windows) with
  features `Win32_Foundation`, `Win32_System_SystemInformation`,
  `Win32_UI_Input_KeyboardAndMouse`.
- 30 tests pass (7 new: 5 pure idle-transition + 2 mocked watcher
  integration + 2 supervisor fan-in and shutdown).
- Known cosmetic: MSVC linker emits `LNK4099` warnings for vendored
  OpenSSL object files (no PDB shipped upstream). Functional impact
  zero.

Refs: ADR-0003 §OS signals, invariant 1 (no content capture).

### Phase 2b.3 — SQLCipher local outbox (2026-09-23)

Encrypted append/drain queue for offline events. On-disk state is
inert without the OS-keystore key (verified by test).

- `apps/desktop/src-tauri/src/outbox.rs`: `Outbox` with
  `open` / `open_in_memory` / `enqueue` / `drain` / `mark_sent` /
  `mark_failed` / `get` / `pending_count`. Idempotent enqueue via
  `INSERT OR IGNORE` on the ULID primary key; drain ordered by
  `(next_retry_at, sequence_number)` so retry-scheduled rows fall to
  the back naturally.
- Single `outbox` table with retry accounting (`retry_count`,
  `next_retry_at`, `last_error`) and index
  `outbox_ready_idx (next_retry_at, sequence_number)`. `event_body`
  and `integrity_signature` stored as opaque BLOBs — no field-level
  introspection on the client.
- SQLCipher key applied via `PRAGMA key = "x'<hex>'"` with a raw
  32-byte key (`CIPHER_KEY_LEN = 32`) — not a passphrase. Matches the
  KDF'd key the OS keystore will supply in 2b.4.
- `rusqlite = { features = ["bundled-sqlcipher-vendored-openssl"] }`
  bundles both SQLCipher and OpenSSL from source, so no system OpenSSL
  install is required on any dev machine. Cold builds compile OpenSSL
  (~5 minutes on Windows; needs Strawberry Perl); incremental builds
  unaffected.
- 21 tests pass — including `on_disk_persists_across_reopens_with_the_
  same_key` and `wrong_key_cannot_open_existing_db` which specifically
  prove encryption at rest.

Deferred to later slices: OS-keystore key fetch (2b.4), retry backoff
policy (2b.6), and `PRAGMA rekey` rotation path (follow-up ADR before
GA).

Refs: ADR-0004 §7, ADR-0007 §5.

### Phase 2b.2 — Rust canonicalize + Ed25519 signing (2026-09-23)

Desktop core produces canonical event bytes byte-for-byte identical to
the backend TS implementation and can sign/verify them with Ed25519.
Cross-language conformance is pinned by a golden vector on both sides —
drift on either side fails both suites.

- `apps/desktop/src-tauri/src/event/canonicalize.rs`: `canonicalize(&Value)`
  and `canonicalize_signed_fields(&SignedEventFields)` (16-field signed
  subset). Object keys sorted lexicographically; integers only with the
  JS safe-int range check (±(2^53−1)); minimal C0 escapes; non-ASCII
  preserved as raw UTF-8.
- `apps/desktop/src-tauri/src/event/signature.rs`: `sign_bytes` /
  `verify_bytes` on `ed25519-dalek` 2.x with `default-features = false` +
  `std`/`fast`/`zeroize`/`rand_core`.
- 11 unit + conformance tests pass, including
  `cross_language_golden_vector_matches_ts`.

Refs: ADR-0004 §5, `packages/event-schema/canonicalization.md`.

### Phase 2b.1 — desktop scaffold: Tauri 2 + React (2026-09-23)

Empty window opens on Windows; the frontend proves the Rust ↔ JS bridge
via `@tauri-apps/api getVersion`. No OS integrations yet.

- Cargo workspace at repo root (`resolver = "2"`, release profile tuned
  for small binaries: `opt-level = "s"`, `lto = true`, `panic = "abort"`,
  `strip = true`).
- `apps/desktop/`: Vite + React 18 UI on port 1420, CSP restricted to
  `'self' ipc: http://ipc.localhost`, `chrome108` build target.
- `apps/desktop/src-tauri/`: Rust crate `cloudpunch-desktop` (lib crate
  types `staticlib`/`cdylib`/`rlib` to reserve future mobile targets),
  420×640 fixed window, identifier `com.aptask.cloudpunch`,
  `bundle.active = false` (installers land in 2b.9).
- Placeholder icon set generated via `tauri icon` (dark-blue "C") for
  all Windows/macOS/iOS/Android sizes so `tauri-build` compiles
  regardless of target.
- Windows dev toolchain confirmed: `cargo check` clean after installing
  VS 2022 Build Tools with the C++ workload; `pnpm typecheck` clean;
  existing `pnpm test` suite (258 tests) still green.

Refs: ADR-0001 §Desktop stack.

### Phase 0 — planning and design (2026-09-23)

No code, dependencies, or cloud resources yet. Documentation-only baseline.

**Repository scaffolding**
- Monorepo layout under `apps/{backend,web,desktop}`, `packages/{shared,event-schema,policy-schema}`, `infra/{terraform,signing}`, `tests/{e2e-web,e2e-desktop,contract-greythr}`.
- Top-level: `.gitignore`, `.editorconfig`, `.nvmrc`, `LICENSE` (proprietary), `README.md`, `CLAUDE.md`, `CHANGELOG.md`.
- Git remote `origin` pointing at `https://github.com/abdaptask/cloudpunch.git`.

**Architecture Decision Records**
- ADR-0001 Tech stack (Node.js + Fastify + Tauri 2 + Aurora Postgres, AWS `ap-south-1`).
- ADR-0002 Microsoft Entra app registrations, App Roles, and SSO flows.
- ADR-0003 Time-tracking state machine (12 states, intelligent-idle, mic/cam detection, auto-clock-out).
- ADR-0004 Event model, idempotent ingest, and integrity metadata (append-only, ULID, Ed25519 device signing).
- ADR-0005 Source-of-truth matrix (`employee.source = local_admin | greythr`) and promotion rules.
- ADR-0006 greytHR integration strategy (adapter interface, API-first with CSV fallback).
- ADR-0007 Secrets, keys, and cryptographic material management.

**Design references**
- `docs/architecture/state-machine.md` — practitioner-facing state diagram + "Alice's Wednesday" worked example.
- `docs/architecture/threat-model.md` — STRIDE-lite, ranked threats, review cadence.

**Integration and policy drafts**
- `docs/integrations/greythr-mapping-rfc.md` — inbound/outbound field tables, pending greytHR API entitlement confirmation.
- `docs/policy/employee-privacy-notice.md` — DPDPA-aware, plain-language, explicit on mic/cam state check.
- `docs/policy/idle-policy-defaults.md` — every configurable idle/break/system knob with defaults and ranges.

**Ops**
- `docs/ops/env-vars.md` — full mapping across env vars, Parameter Store, and Secrets Manager.
- `docs/ops/runbook-outline.md` — 40+ runbook stubs prioritised by phase gate.
