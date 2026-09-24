# Changelog

All notable changes to CloudPunch are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Phase 2b.7.2b PR D — state machine wired into the app (2026-09-24)

The desktop agent now runs the time-state machine for real. Events
still go to the debug log sink; the signed outbox sink lands with
2b.4. No new dependencies.

- `src-tauri/src/agent.rs` (new): `Agent` holds the `Driver` behind
  one lock, shared by commands, tray, watcher drain, and a 1 Hz tick
  thread (last input from `GetLastInputInfo`; off Windows the tick
  reports "input now" so the prompt never fires until 2b.8). UI work
  happens after the lock is released, through a `Ui` trait
  (`TauriUi` in production, a fake in tests):
  - every state change emits `cp://state` and rebuilds the tray menu;
  - `ShowPrompt` opens the `idle-prompt` window (always on top,
    focused, not closable, not minimisable), created only from the
    tick thread because building a window in a sync command
    deadlocks on Windows; `HidePrompt` destroys it;
  - a grace-timeout clock-out brings the main window forward and sets
    `autoClockedOutAt` until the next clock-in.
- `src-tauri/src/commands.rs` (new): `get_state`, `clock_in`,
  `clock_out`, `start_break`, `end_break`, `mark_back`,
  `respond_to_prompt`. Return the new `StateView` or a rejection code;
  all validation is in the core.
- `src-tauri/src/lib.rs`: watcher drain forwards
  `MediaInUseChanged` as `mic || cam` (ADR-0009); prompt window close
  requests are refused (ADR-0008).
- `src-tauri/src/tray.rs`: menu rebuilt per state (clock in; clock
  out / bio break / meal break; end break; I'm back) and routed to the
  agent. New `Away` status. `Take a break` is replaced by bio and
  meal: `other` breaks need attestation (ADR-0003 §6) and aren't
  offered yet.
- `src-tauri/capabilities/default.json` (new): `main` and
  `idle-prompt` get `core:event:allow-listen` / `allow-unlisten`
  only.
- Frontend: `api.ts` + `useAgentState` (new); `App.tsx` renders the
  agent's state (calls show as "Clocked in", ADR-0003 §1) and explains
  an auto clock-out; `PromptWindow.tsx` (new) hosts `IdlePrompt`;
  `main.tsx` routes on window label.
- Tests: Rust 143 (16 new: view mapping, tray items, agent UI calls
  incl. prompt → timeout → main window), frontend 27 (14 new).

**Not verified automatically:** window behaviour (always-on-top,
focus, close blocked, tray menu refresh) needs a manual smoke test on
Windows.

Refs: ADR-0003, ADR-0008, ADR-0009.

### Phase 2b.7.2b PR C — event sink + driver (2026-09-24)

Connects the desktop state machine to a pluggable event destination.
Still not wired into the app (PR D). No new dependencies.

- `apps/desktop/src-tauri/src/machine/sink.rs` (new): `EventSink`
  trait (`record(event, at) -> Result<(), SinkError>`), plus
  `LogSink` (debug-build stderr; logs event type, time and
  state-driving payload only, never the prompt note) and
  `RecordingSink` (in-memory, shared buffer, optional always-fail
  mode for tests).
- `apps/desktop/src-tauri/src/machine/driver.rs` (new): `Driver`
  wraps `Core` + sink. `handle` records each emitted event in order
  and returns only UI effects, plus any sink error and the backlog
  size. A refused event and everything after it stay in an ordered
  backlog, retried before new events on the next `handle` or
  `flush` — events are never dropped or reordered.
- 10 new unit tests (sink ordering, note never logged, backlog replay
  with original timestamps, rejected input records nothing).

**Open for 2b.4:** the backlog is unbounded and in-memory. The real
outbox sink should make `record` durable enough that failures are
rare; what the user sees on a persistent failure is undecided.

Refs: ADR-0003, ADR-0004 §7.

### Phase 2b.7.2b PR B — desktop state machine core (2026-09-24)

Pure Rust state machine for the desktop agent. Not wired to the
watchers, tray, or webview yet (PR D); emits typed events, not signed
wire events (PR C / 2b.4). No new dependencies.

- `apps/desktop/src-tauri/src/machine/` (new):
  - `transitions.rs` — `next_payroll_state`, a Rust mirror of the
    backend `nextState`. The core checks every event against it
    before emitting, so the client never records a transition the
    server would reject.
  - `mod.rs` — `Core::handle(input, now) -> effects`. States:
    clocked out, active, on call, idle pending, on break, away.
    The core owns the idle threshold and the grace countdown, driven
    by a ~1 Hz tick carrying the last-input time: `IdleWatcher` only
    reports the first input after an idle period and can't re-arm
    when a call ends. Input during the prompt pushes the deadline to
    `last_input + grace` (ADR-0008 §2). Mic/cam off is debounced
    5 s; media edges are recorded only when they change state
    (ADR-0009). Prompt notes are trimmed, required for
    `working_away`, capped at 500 chars. Policy values are the
    defaults from `idle-policy-defaults.md` until policy fetch exists.
  - `tests.rs` — 37 unit tests, including a scripted day replaying
    every emitted event through the server mirror.
- `packages/event-schema/fixtures/state-transitions.json` (new): 144
  from-state × event cases, generated from the backend `nextState`
  and checked against ADR-0003/0008/0009. Run by both
  `apps/backend/src/events/state-machine.fixture.test.ts` (new) and
  the Rust `transitions` tests.
- Deferred: CLOCKING_IN/OUT, LOCKED, SLEEPING, OFFLINE_PENDING_SYNC,
  ERROR states; break-cap nudges; manual `USER_MARK_AWAY` (no payload
  schema yet).

**Known gaps (pre-existing, not addressed here):** CI runs no Rust
(`cargo test` / Clippy only run locally), and `cargo clippy -D
warnings` fails on six lints in `sync/mod.rs`, `mic_cam.rs`,
`canonicalize.rs`, and `supervisor.rs`. `cargo fmt` would also
reformat 12 existing files. None of these are touched by this PR.

Refs: ADR-0003, ADR-0008, ADR-0009.

### Phase 2b.7.2b PR A — backend `ON_CALL` state + ADR-0009 (2026-09-24)

Closes the known gap from the ADR-0008 backend follow-up: a call
starting during the idle prompt now leaves `IDLE_PENDING`
server-side.

- **ADR-0009 (new, Accepted)** — `ON_CALL` state and media events.
  `MEDIA_DEVICE_STATE` payload is exactly `{ in_use: boolean }`
  (mic OR camera); a call dismissing the prompt makes the
  prompt-pending interval payable as `ON_CALL`; `USER_MARK_AWAY` is
  rejected from `ON_CALL`; grace-countdown resets emit no event.
- `apps/backend/src/events/state-machine.ts`: `ON_CALL` added to
  `PayrollState`. `MEDIA_DEVICE_STATE` is no longer ambient:
  `in_use=true` moves `ACTIVE` / `IDLE_PENDING` → `ON_CALL`,
  `in_use=false` moves `ON_CALL` → `ACTIVE`, other combinations
  keep state. A missing or non-boolean `in_use` is rejected.
  `USER_START_BREAK` is now also valid from `ON_CALL`.
- `apps/backend/src/events/derive.ts`: `MEDIA_DEVICE_STATE
  {in_use:true}` closes an open idle period with new resolution
  `media_dismiss`. Not persisted anywhere yet; no schema change.
- `packages/event-schema/schemas/media-device-state.schema.json`
  (new).
- ADR-0008 status header notes §3 extended by ADR-0009 (content
  unchanged). `docs/architecture/state-machine.md` updated.
- Tests: `ON_CALL` transitions (positive + negative), malformed
  payloads, call-during-prompt fold, `media_dismiss` derivation.

Refs: ADR-0003, ADR-0008, ADR-0009.

### ADR-0008 backend follow-up + LF line endings (2026-09-24)

- **Backend now implements ADR-0008.**
  - `apps/backend/src/events/state-machine.ts`: `INPUT_ACTIVITY`
    never changes state; from `IDLE_PENDING` it stays
    `IDLE_PENDING` (was `ACTIVE`). The prompt must be answered or
    time out.
  - `apps/backend/src/events/derive.ts`: `INPUT_ACTIVITY` no longer
    closes an open idle period. `IdleResolution` loses
    `input_dismiss` (never persisted; no DB or schema references).
  - Tests updated: flipped state-machine assertion, new
    "answerable after input" test, derive tests + Alice worked
    example now close the idle with a `still_working` response.
- **`.gitattributes` (new):** `* text=auto eol=lf` plus binary
  markers for images/fonts/PDF. Stops Windows clones with
  `core.autocrlf=true` from checking files out as CRLF, which made
  local `pnpm format:check` fail while CI passed. Index was already
  all-LF, so no files are renormalised.

**Known gap (pre-existing, not addressed here):** the backend treats
`MEDIA_DEVICE_STATE` as ambient and has no `ON_CALL` state, so a call
starting during `IDLE_PENDING` doesn't leave `IDLE_PENDING`
server-side as ADR-0003/0008 require. To be picked up with the
desktop state-machine slice.

Refs: ADR-0003, ADR-0008.

### Phase 2b.7.2a — idle prompt component + ADR-0008 (2026-09-24)

First half of 2b.7.2. Fixes a gap in ADR-0003 and adds the idle
prompt as a presentation-only React component. No window, no Rust,
no Tauri commands yet — 2b.7.2b wires it once the desktop state
machine exists.

- **ADR-0008 (new, Accepted)** — input while the idle prompt is
  visible. ADR-0003 had `INPUT_ACTIVITY` in `IDLE_PENDING` dismiss the
  prompt as `ACTIVE`, which made every non-"still working" option
  unreachable (moving the mouse to click one dismissed it first).
  Now: input keeps the prompt up and resets the grace countdown;
  only an explicit response, a call starting, or the timeout leaves
  `IDLE_PENDING`. The prompt-pending interval is classified by the
  response. The Rust core owns the grace timer.
- `docs/architecture/adr/ADR-0003-time-state-machine.md`: status
  header notes §3 amended by ADR-0008. Content unchanged.
- `docs/architecture/state-machine.md`: `IDLE_PENDING` row and
  worked-example row 8 / payable table updated for ADR-0008.
- `apps/desktop/src/IdlePrompt.tsx` (new): `alertdialog` with the six
  `idle.prompt_options`, a required note for `working_away`
  (`noteRequiredFor` prop, 500-char cap from the event schema), and a
  cosmetic countdown driven by a core-supplied `deadline`. Buttons
  disable at zero; the component never auto-responds.
- `apps/desktop/src/IdlePrompt.test.tsx` (new): 13 tests — option
  order/subset, each response, note validation + trimming, Back,
  countdown, deadline reset, expiry. One test reads
  `packages/event-schema/schemas/user-prompt-response.schema.json` and
  fails if the local `PromptResponse` list or note cap drifts.
- Full CI-mirror pass green locally (desktop 17, backend 197,
  event-schema 34, shared 19, contract-greythr 8).

**Follow-ups (ADR-0008 §Consequences)**
- Backend `state-machine.ts`: `INPUT_ACTIVITY` from `IDLE_PENDING`
  must stay `IDLE_PENDING`. Separate PR — backend currently still
  implements the ADR-0003 rule.
- 2b.7.2b: prompt window, Rust-owned grace timer, Tauri capabilities.

Refs: ADR-0003, ADR-0008.

### Phase 2b.7.3 — desktop TS component testing (2026-09-24)

Stands up Vitest + Testing Library for the desktop React UI so the
upcoming idle-prompt and state-machine slices land with tests. Retires
the `--passWithNoTests` workaround from `c3db698`.

- `apps/desktop/vitest.config.ts` (new): jsdom environment,
  `src/**/*.test.{ts,tsx}`, `restoreMocks: true`. Separate from
  `vite.config.ts` so dev-server settings don't leak into tests.
  `@tauri-apps/api` has no IPC bridge under jsdom — mock per test.
- `apps/desktop/src/test/setup.ts` (new): registers jest-dom matchers
  and runs `cleanup()` after each test.
- `apps/desktop/src/App.test.tsx` (new): 4 tests covering the home UI
  transitions (not clocked in → clocked in → on break → clocked in →
  not clocked in) and which actions are offered in each state.
- `apps/desktop/package.json`: `test` is now plain `vitest run`.
  New devDependencies: `jsdom`, `@testing-library/react`,
  `@testing-library/dom`, `@testing-library/user-event`,
  `@testing-library/jest-dom`.
- `eslint.config.js`: test-file rule overrides now also match
  `**/*.test.tsx`.
- Full CI-mirror pass green locally: format:check + lint + typecheck +
  test (desktop 4, backend 197, event-schema 34, shared 19,
  contract-greythr 8).

Refs: ADR-0003.

### Phase 2b.7.1 — tray icon + minimal home UI (2026-09-23)

First sub-slice of 2b.7. Tray icon in the Windows notification area
with a working menu; close-to-tray on the main window. Home UI
rebuilt from the 2b.1 scaffold into a real (if placeholder) React
surface. No backend wiring yet — 2b.7.2 adds the idle-prompt window,
2b.7.3 adds TS testing, and the state-machine slice will plumb
actions through to the outbox.

- `apps/desktop/src-tauri/src/tray.rs` (new):
  - `TrayStateSnapshot` enum (`NotClockedIn` / `ClockedIn` / `OnBreak`).
  - Pure `render_status_label(&state) -> String` — 3 unit tests.
  - `install(&AppHandle)` builds the menu:
    `Status: … | Clock in | Take a break | Show CloudPunch | Quit`.
    Menu handlers log to stderr in debug builds for now; `Show`
    calls `show()+set_focus()` on the main webview; `Quit` calls
    `app.exit(0)`. Right-click-only menu (matches Windows convention).
- `apps/desktop/src-tauri/src/lib.rs`:
  - Registered `pub mod tray;` and called `tray::install` from
    `setup()`.
  - `on_window_event` intercepts `CloseRequested` on the `"main"`
    window and hides instead of closing, so the agent keeps running
    in the tray. Tray's `Quit` is the intended exit path.
- `apps/desktop/src-tauri/Cargo.toml`: `tauri` features gained
  `"tray-icon"`.
- `apps/desktop/src/App.tsx`: rebuilt from the getVersion scaffold
  into a real home UI. Local `useState<ClockState>` drives the
  status card + action buttons. Clicks log to console. Inline
  styles; real design system is a later concern.
- 78 Rust tests pass (3 new tray label tests). Full CI-mirror pass
  green locally: format:check + lint + typecheck + test.

**Not in scope for this slice**
- Tray ↔ app state sync (tray label doesn't update yet).
- Any Tauri command handlers or backend calls.
- Idle-back prompt window (2b.7.2).
- TS component testing setup (2b.7.3 retires `--passWithNoTests`).

Refs: ADR-0003.

### Phase 2b.6.3 — network-awareness + env-var opt-in SyncLoop wiring (2026-09-23)

Third and final sub-slice of 2b.6. The sync loop now pauses draining
when the network watcher reports offline, and can actually run on
Tauri boot when six env vars are set (dev opt-in until slice 2b.4
wires the OS keystore + MSAL).

- `SyncLoop::start` gained `is_online: Arc<AtomicBool>`. Each tick
  checks it — `false` → skip drain and sleep. Prevents burning
  `retry_count` on offline HTTP calls.
- `apps/desktop/src-tauri/src/lib.rs`:
  - `WatchersGuard` now owns `is_online: Arc<AtomicBool>` exposed via
    `is_online()`. The drain thread updates it whenever an
    `OsSignal::NetworkReachabilityChanged { reachable, .. }` arrives.
  - New `SyncLoopGuard` (RAII wrapper) + `start_sync_loop_if_configured`
    that instantiates the loop when `SyncBootstrap::from_env` returns
    `Ok`. `Err` → silent no-op in release, `eprintln!` in debug
    explaining which env var was missing.
  - `run()` wires it: watchers → is_online → sync loop, dropped in
    reverse order (sync first, watchers last — is_online outlives
    sync's consumption of it).
- `sync::SyncBootstrap::from_env()` reads six env vars:
  * `CLOUDPUNCH_BACKEND_URL`
  * `CLOUDPUNCH_BEARER_TOKEN`
  * `CLOUDPUNCH_DEVICE_ID`
  * `CLOUDPUNCH_EMPLOYEE_ID`
  * `CLOUDPUNCH_OUTBOX_PATH`
  * `CLOUDPUNCH_OUTBOX_KEY_HEX` (64 hex chars → 32 bytes)
  Any missing → `Err` with an actionable message. Prod safe-by-default
  (unset env → nothing runs). Env-var path is explicitly dev-only and
  goes away with slice 2b.4.
- 75 tests pass (1 new: `syncloop_skips_when_offline_and_resumes_when_
  online_flips` — verifies zero HTTP calls while offline and prompt
  resumption on the flip).

Sub-series 2b.6 complete. Follow-ups tracked separately:
- MSAL / OS-keystore integration (2b.4) replaces the env-var opt-in
  with real production wiring.
- Enqueue-side `event_body` JSON validation to eliminate the
  defensive-Transient path from 2b.6.2.

Refs: ADR-0003 §OS signals, ADR-0004 §6.

### Phase 2b.6.2 — reqwest-based BackendClient (2026-09-23)

Concrete implementation of `BackendClient` that actually posts to
`POST /v1/events`. Integration-tested against an in-process httpmock
server covering every documented response variant.

- `apps/desktop/src-tauri/src/sync/reqwest_client.rs`:
  `ReqwestBackendClient` with `blocking::Client`, 30 s request
  timeout, `Bearer` auth header. Builds the batch envelope by parsing
  each outbox row's `event_body` as `serde_json::Value` so canonical
  bytes embed as real JSON.
- Status-code → response mapping:
  - 200 → parse `results[]`, one `PerEventResult` per entry
    (`accepted` / `duplicate_noop` / `rejected{code,message}`).
  - 400 → `ValidationFailed`.
  - 403 → `AuthDenied`.
  - 409 → dispatch on body `code`:
    - `device_*` → `DeviceInvalid`.
    - `session_*` → `SessionInvalid`.
    - `multi_device_conflict` → `MultiDeviceConflict` with
      `existing_session_id`, `existing_device_id` from body.
    - anything else → `Transient(unexpected 409 code)`.
  - 5xx / connect error / timeout / body-parse fail → `Transient`.
- Defensive: an outbox row whose `event_body` isn't valid JSON
  returns `Transient("event_body is not valid JSON at {ulid}: ...")`
  without hitting the network. Real fix is enqueue-side validation
  (future slice).
- `Cargo.toml` deps added:
  - `reqwest = { version = "0.12", default-features = false,
      features = ["blocking", "json", "rustls-tls-native-roots"] }`.
    `rustls-tls-native-roots` avoids OpenSSL tangling with SQLCipher.
  - `httpmock = "0.7"` (dev-dep) — blocking-friendly HTTP fixtures.
- 74 tests pass (11 new reqwest integration tests covering every
  response variant + request-body shape assertion + network-error
  path).

Auth is a placeholder Bearer string; real Entra token acquisition
lands with 2b.4 (MSAL PKCE).

Refs: ADR-0004 §6.

### Phase 2b.6.1 — sync loop core + outbox poison migration (2026-09-23)

First sub-slice of the sync loop. Drains the outbox against a mock
BackendClient. Real reqwest client and network-awareness land in
2b.6.2 and 2b.6.3.

**Outbox schema migration (v1 → v2)**
- Added `poisoned INTEGER NOT NULL DEFAULT 0` and `poison_reason TEXT`
  columns.
- New `Outbox::mark_poisoned(event_ulid, reason)` method.
- `Outbox::drain` now excludes poisoned rows.
- `Outbox::poisoned_count()` for diagnostics; `Outbox::get()` still
  returns poisoned rows so audit / debugging can inspect them.
- Schema versioning via `PRAGMA user_version`. Fresh DBs come up at
  v2 directly; hypothetical v1 DBs would `ALTER TABLE` up. No shipped
  users to migrate yet.

**New `sync/` module tree**
- `sync/backoff.rs`: pure `BackoffPolicy::delay(retry_count)`. Default
  ladder: 5s → 15s → 45s → 135s → 300s (cap). No jitter yet; add if
  fleet growth introduces thundering-herd behaviour.
- `sync/client.rs`: `BackendClient` trait + `SessionEnvelope` +
  `SendBatchResponse` enum (7 variants covering the observed
  `POST /v1/events` outcomes). `MockClient` test helper records calls
  and supports arbitrary closure-based responses.
- `sync/mod.rs`: `SyncLoop` (dedicated thread) + pure
  `run_tick(&Outbox, &dyn BackendClient, &SyncConfig)` for direct
  unit testing. `run_tick` drains, groups by `session_id` (preserves
  first-seen order), wraps in envelope with a fresh v4 UUID
  correlation_id, and posts one HTTP call per session.

**Response → outbox action mapping (`apply_response`)**
- `Accepted` per-event: `Accepted`/`DuplicateNoop` → `mark_sent`;
  `Rejected{code,message}` → `mark_poisoned(...)`.
- `ValidationFailed` → poison every event in the sent batch.
- `AuthDenied` → `mark_failed` with `auth_retry` (default 60s).
- `DeviceInvalid` / `SessionInvalid` → poison batch with prefixed
  reason.
- `MultiDeviceConflict` → `mark_failed` with `multi_device_retry`
  (default 300s); UI prompt in 2b.7 handles `take_over`.
- `Transient` → `mark_failed` with `backoff.delay(retry_count)`.

New dep: `uuid = "1"` (feature `v4`) for correlation_id generation.

Verification: 63 tests pass (18 new — 4 backoff + 3 outbox poison +
11 sync).

**Not in this slice** (deferred to 2b.6.2 / 2b.6.3)
- Real reqwest-based `BackendClient` (currently only the mock).
- Entra token; `SyncConfig` carries placeholder device_id/employee_id.
- Network-awareness (pause when offline).
- `SyncLoop` wiring into `run()` — that lands with 2b.6.3.

Refs: ADR-0004 §6 (event ingest), ADR-0004 §7 (outbox pattern).

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
