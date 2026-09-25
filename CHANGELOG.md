# Changelog

All notable changes to CloudPunch are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Device visibility: who signs in from where (2026-09-25)

- Requested by the project owner. Every device a user enrolls is
  already a `device` row, and device IDs are per user and per machine,
  so the row count per user is the number of machines they sign in
  from.
- Enrollment now sets `device.last_seen_at`. The agent enrolls on
  every launch and sign-in, and ingest already updated the field.
- New capability `admin.device.read`, held by **Administrator** and
  **Auditor**. It is read-only; Auditor stays write-free.
- New route `GET /v1/admin/devices`. It returns every device with its
  owner's email and name, OS, app version, hostname hash, enrollment
  time, last-seen time and revocation status, plus a per-user summary
  (active devices, total devices, last seen). Public keys are never
  listed.
- New script `pnpm -F @cloudpunch/backend report:devices`: the same
  data as tables, read-only from the dev DB, for use until the web
  dashboard exists.
- Privacy notice: a new "Who can see your data" bullet says
  administrators and auditors can see which computers each person
  signs in from.
- Known gap: reads by administrators are not yet written to
  `audit_log`.

### Local dev API against the dev VM (2b.4 F4 prep) (2026-09-25)

- `server.ts` now wires `PostgresDb` when `POSTGRES_APP_URL` is set, so
  `/v1/me`, `/v1/devices/enroll` and `/v1/events` are served. Before
  this they were never registered outside tests.
- The URL is honoured only with `CLOUDPUNCH_ENV=dev`. Other
  environments ignore it and log a warning. The pool closes when the
  server shuts down.
- New scripts:
  - `dev:local` runs the API with `--env-file=.env.local`.
  - `seed:dev` (`scripts/seed-dev-user.ts`) creates an active
    `local_admin` employee and links the given Entra user to it. It is
    idempotent, dev-only, and accepts only `@aptask.com` addresses.
- The runbook is in `docs/ops/env-vars.md` §5.1.
- **Verified by the owner on 2026-09-25:** after sign-in, `GET /v1/me` and
  `POST /v1/devices/enroll` both returned 200 against the dev VM, and
  the desktop logged "device enrolled".
- Desktop, found during that run:
  - The browser page after sign-in is now a styled result card. On
    success it tries `window.close()` after 1.5 s. Browsers usually
    ignore that for a tab the OS opened, so the page still says it can
    be closed.
  - New log lines for two cases that used to be silent: the silent
    start-up sign-in finding no usable session, and enrollment blocked
    because the hostname can't be read.

### Desktop device enrollment (2b.4 F3b) (2026-09-25)

- New `enroll.rs`. After sign-in and after the silent start-up
  restore, the agent calls `GET /v1/me` for the employee id, then
  `POST /v1/devices/enroll` with the device id, OS, hostname hash,
  public key and app version. It enrols on every launch. The backend
  treats a repeat as a key refresh, so a key lost at sign-out heals
  itself.
- **Device id:** a UUID v4 per user, stored in the keystore at
  `CloudPunch/device-id/<oid>` (`com.cloudpunch.device-id` on macOS).
  It is kept across sign-out. ADR-0007 §5 is amended to add it.
- **`hostname_hash`:** `sha256-<hex>` of the lower-cased hostname,
  unsalted. The owner accepted that it is guessable, and this is
  recorded under residual risks in the threat model. The hostname
  comes from `GetComputerNameExW` on Windows and `gethostname` on
  macOS.
- **Offline-first:** only a definite answer from the server blocks
  clock-in: no user, no employee, clocking not allowed, a revoked
  device, or a device owned by someone else. `clock_in` returns the
  same code, and the main window shows the reason.
- Network errors, 5xx, 401 and 429 are retried in the background
  (30 s, doubling, capped at 15 min). A newer sign-in or a sign-out
  stops a stale attempt.
- New command `enrollment_status` and new event `cp://enrollment`.
- The backend URL comes from `CLOUDPUNCH_BACKEND_URL`. When it is
  unset, enrollment reports `not_configured` and clock-in still works.
- New dependency: `libc` 0.2, macOS only. It was already in the
  lockfile.
- Not wired in yet: the sync loop still reads its identity from env
  vars. F3c switches it to the enrolled identity.

### Desktop signed-event encoder (2b.4 F3a) (2026-09-24)

- New `event/encode.rs` turns a state-machine event into the signed wire
  event the backend ingests. It signs 16 canonical fields with Ed25519,
  including the four that travel on the batch envelope, and adds the
  base64 `integrity_signature`. Timestamps are RFC 3339 with
  milliseconds and the local offset (`chrono`). The zone name comes from
  the OS (`iana-time-zone`) and falls back to `Etc/UTC`.
- New `event/ulid.rs`: a hand-written monotonic ULID generator. Within a
  millisecond, or if the clock steps back, IDs keep increasing.
- **Shared golden fixture** `packages/event-schema/fixtures/signed-events.json`:
  a whole shift of 11 events signed with a fixed test key. The Rust test
  requires the encoder to reproduce it exactly. A backend test
  (`signed-events.fixture.test.ts`) runs the same events through the
  batch schema, signature verification and ingest, and all of them are
  accepted.
- **ADR-0014 (new, Accepted):** one `correlation_id` per session. Today the
  sync loop creates a new one for each batch, so the backend would
  reject every signed event. The fix comes in F3c.
- Dependencies: `chrono` 0.4 (clock and std only) and `iana-time-zone`
  0.1. Both were already in the lockfile through Tauri.
- Not wired in yet: the agent still logs events. The outbox sink and a
  live sync come in F3c.

### Fix: sign-in stuck after closing the browser tab (2026-09-24)

- Found by the project owner: closing the browser mid-sign-in left the
  app waiting up to 5 minutes, and signing in again failed with
  "already in progress".
- A new sign-in now **cancels** the one in progress and opens a fresh
  browser tab (`AuthManager` keeps one cancel flag per attempt; the
  loopback listener checks it while waiting). The replaced attempt ends
  with `cancelled`, which the webview ignores.
- While waiting, the sign-in screen offers **Open the browser again**
  and **Cancel** (new `cancel_sign_in` command). The "busy" error is
  gone.
- Tests: 3 Rust (cancel stops the listener; a second sign-in replaces a
  stuck one; Cancel stops a waiting one), 2 frontend.

### Tray residency and on-the-clock reminders (ADR-0013) (2026-09-24)

- **ADR-0013 (new, Accepted).**
- **Closing the window asks:** clocked in → "You're still clocked in…"
  **Keep running in tray** / **Clock out & quit**; clocked out → **Keep
  running in tray** / **Quit**; "Don't ask again" remembers keep-running
  only (per PC). The tray's **Quit** while clocked in opens the same
  dialog, so the app never exits mid-session. First hide per run shows
  "CloudPunch is still running".
- **Reminders** (`reminders.rs`, pure, on the 1 Hz tick): every 30 min
  while clocked in and hidden; not during calls, the idle prompt, or
  quiet hours (22:00–07:00 local via `GetLocalTime`). Break-cap nudge
  (bio 10 min, meal 60) once per break. **Long-shift check** after 9 h:
  notification + window forward + "still working?" banner (again 2 h
  after **Still working**), even in quiet hours.
- **Live tray status:** coloured status disc drawn in code (green on the
  clock, amber on a break, grey clocked out) and a tooltip ("CloudPunch
  — Clocked in · 2h 30m") refreshed every minute.
- Commands `hide_to_tray`, `quit_app` (refused while clocked in),
  `clock_out_and_quit`, `ack_long_shift`; `cp://close-requested` event.
- Policy: `reminders.on_clock_minutes` (30), `reminders.long_shift_hours`
  (9), `reminders.long_shift_repeat_hours` (2) in the policy schema and
  `idle-policy-defaults.md`. Compiled-in defaults until policy fetch.
- **New dependency (approved):** `tauri-plugin-notification` 2.4
  (notifications sent from Rust only). Lockfile gains 23 entries, mostly
  Linux / macOS back-ends.
- Found: Tauri 2.11 already requires Rust 1.77.2, so the workspace
  `rust-version = "1.75"` is stale — added to doc fixes.
- Tests: Rust 223 (8 scheduler, tray icon/tooltip, agent reminder and
  long-shift tests), desktop 54 (7 new).

### 2b.4 F2 — Microsoft sign-in on the desktop (2026-09-24)

- `apps/desktop/src-tauri/src/auth/` (new), per ADR-0002 §5:
  - `pkce.rs` — S256 verifier/challenge (RFC 7636 vector tested),
    random `state`, authorize URL (`prompt=select_account`).
  - `loopback.rs` — ephemeral `127.0.0.1` (+ `::1`) listener for the
    `http://localhost:<port>` redirect; checks `state`, answers "you can
    close this window", ignores stray requests, 5-minute timeout.
  - `token.rs` — code exchange and refresh via the existing `reqwest`;
    errors surface only the OAuth error code; tokens are never logged
    (`Debug` redacts). The ID token is decoded to read `oid` / name and
    checked for tenant and audience; its signature is **not** verified
    on the device — the backend validates every access token.
  - `AuthManager` — interactive sign-in through the **system browser**;
    silent restore at start-up from the stored refresh token (rotated
    when Entra returns a new one; cleared if rejected); access token in
    memory only, refreshed within 5 minutes of expiry; sign-out deletes
    the refresh token, the current-user pointer, and the F1 device and
    outbox keys (ADR-0007 §5).
- `keystore.rs`: refresh-token slot `CloudPunch/msal/<tenant>/<client>/<oid>`
  and a current-user pointer; `Arc<store>` is a store.
- **Fix found in the owner's first real sign-in:** Windows Credential
  Manager holds at most 2560 bytes per entry (1280 UTF-16 characters),
  and Entra refresh tokens are longer, so saving it failed
  (`keystore`). Long values are now split across `<target>/part<i>`
  entries behind a `cloudpunch-chunked:v1:<n>` header (`Chunked`);
  short values are stored as before. A missing part is an error, never a
  silently truncated token. Verified with a 3000-character value against
  the real Credential Manager.
- **Sign-in screen:** official-style "Sign in with Microsoft" button
  (four-square logo, Segoe UI Semibold 15px, 41px, light / dark per
  Microsoft's branding guidance) on a "Welcome to CloudPunch" card.
- **Name:** "apTask" corrected to **ApTask** across the app (publisher,
  sign-in text), docs, `LICENSE`, and `package.json`.
- Commands `auth_status`, `sign_in` (async, off the UI thread),
  `sign_out` (refused while clocked in: `clock_out_first`); `clock_in`
  refused while signed out (`not_signed_in`); tray "Clock in" opens
  the window when signed out. `cp://auth` carries status changes.
- Home window: sign-in screen until signed in; name and **Sign out**
  (while clocked out) in the header.
- `docs/ops/env-vars.md`: registered tenant / client IDs (ADR-0002
  step F).
- **New dependencies (approved):** `sha2` 0.10 and `url` 2 (both
  already in the lockfile), `open` 5.4 (+ tiny `is-docker`, `is-wsl`).
- Tests: 18 Rust auth tests (full sign-in against a fake browser and a
  mock token endpoint, restore, rotation, revoke, refresh margin,
  sign-out, denial), keystore slot tests, 5 frontend sign-in tests.

### 2b.4 F1 — device secrets in the OS secure store (2026-09-24)

First slice of 2b.4 (sign-in, device keys, signed events). Not wired
into the app yet: F2's sign-in supplies the Entra `oid`.

- `apps/desktop/src-tauri/src/keystore.rs` (new): `Secrets` loads or
  creates, per `oid`, the Ed25519 **device key** and the 32-byte
  **outbox (SQLCipher) key** from the OS CSPRNG, stored base64url in
  Windows Credential Manager / macOS Keychain under ADR-0007 §5 names
  (`CloudPunch/device-key/<oid>`, `CloudPunch/sqlite-key/<oid>`).
  `forget` deletes both (sign-out). The `oid` must be a UUID, so it
  can't inject separators into the target name. A corrupt stored value
  is reported, never silently replaced (that would orphan the outbox).
- **New dependencies (approved):** `keyring` 3.6.3 (`windows-native`,
  `apple-native`; 3.x keeps the Rust 1.75 MSRV, 4.x needs 1.88),
  `getrandom` 0.3 and `base64` 0.22 (both already in the lockfile).
  Lockfile gains keyring, `windows-sys` 0.60 + target shims, and
  macOS-only `security-framework` / `core-foundation`.
- Tests: 8 unit tests on an in-memory store, plus an opt-in round trip
  against the real Credential Manager (passes; leaves nothing behind).

### Call type detection (ADR-0012) (2026-09-24)

- **ADR-0012 (new, Accepted):** the agent classifies the app holding
  the microphone into a category — `teams`, `zoom`, `other` — and
  records only the category on `MEDIA_DEVICE_STATE` (`call_type`).
  Managers and reports see it (project owner's decision; owner
  declined a legal / HR review). Supersedes parts of ADR-0003 §1 / §7,
  ADR-0009 §1, ADR-0011 §1 / §2. `CLAUDE.md` invariant 1 and the
  employee privacy notice updated.
- **Bug fix:** a softphone that keeps the microphone open while idle
  (`ace dialer.exe`) made anyone with it open show as "On a call"
  since #8. Such apps are now on an ignore list (session check and
  consent-store fallback); their calls aren't tracked.
- **Removed:** the manual "On a phone call" tag (home and tray). "In a
  meeting" stays.
- Desktop: `call_type.rs` (allowlist, ignore list, priority),
  `audio_session::active_call_type` (process → category; the exe name
  is never stored or logged); switching app mid-call records the new
  category. Timeline kinds `call_teams` / `call_zoom` / `call_other`;
  status and tray read "On a Teams / Zoom call" or "On a call".
- Backend: `MEDIA_DEVICE_STATE.call_type` optional, known values only,
  only with `in_use: true`; fixture regenerated (198 cases).
- Found: `test/invariants/no-content-capture.ts` referenced by
  `CLAUDE.md` doesn't exist — tracked under the CI item.
- Tests: Rust 179, backend 444, desktop 42.

### Voluntary away tags: In a meeting / On a phone call (ADR-0011 §2) (2026-09-24)

- Home window and tray: **In a meeting** and **On a phone call** tags
  while clocked in (not during a detected call, ADR-0009 §2). "I'm
  back" returns to working. No check-in cap (ADR-0011 §4).
- `packages/event-schema/schemas/user-mark-away.schema.json` (new):
  `{ away_reason: working_away | phone_call | meeting | other, note? }`.
- Backend `USER_MARK_AWAY` now requires a known `away_reason`; still
  `ACTIVE`-only. Shared fixture regenerated (180 cases).
- Desktop core: `AwayReason::Meeting`, `Input::MarkAway { reason, note }`,
  note rules from `away.require_note` (working_away required); new
  `mark_away` command (meeting / phone_call only).
- Tray shows **On a call** during Teams / Zoom calls, **In a meeting**,
  **On a phone call**, or **Working away**.
- Timeline: new `away_meeting` segment (fuchsia); working away moves to
  violet. Calls, meetings, phone calls and working away count as
  **Working** in the totals (per the project owner) and are shown
  separately while they happen; the totals card breaks Working down
  (at the computer / on a call / in a meeting / on a phone call /
  working away).
- Tests: Rust 168, backend 422, desktop 40.

### Fix: migration 0001 could not be applied (2026-09-24)

- `apps/backend/db/migrations/0001_baseline_identity.sql`:
  `employee_override_active_idx` used `WHERE effective_until > now()`;
  Postgres rejects non-`IMMUTABLE` index predicates, so 0001 failed on
  every real database and 0002 could never run. Now a plain index on
  `(employee_id, field_name, effective_until)`; queries still filter
  by `effective_until` at run time.
- One-time exception to the forward-only rule, documented in the
  migrations README: no database had 0001 recorded.
- Found on the first apply to the internal dev VM (`cloudpunch-abd`,
  Postgres 16.15), where 0001 and 0002 now apply cleanly.
- Follow-up (CI item): run the Postgres integration tests in CI.

### Desktop UI — Timeline view + ADR-0011 §1 (2026-09-24)

Redesigned home window, chosen by the project owner: status card
with a live session timer, one primary action with break chips, and
today's timeline with tracked totals. Light and dark follow the OS.
No new dependencies.

- `src-tauri/src/timeline.rs` (new): builds today's segments
  (working / bio, meal, other break / away phone, working / idle
  prompt) from state changes; active and on-call merge into one
  working segment (ADR-0003 §1). `StateView` gains
  `sessionStartedAt` and `timeline`.
- Frontend: `ui/theme.tsx` (tokens, OS light/dark), `ui/Button.tsx`
  (primary / secondary / chip), `timelineModel.ts` (clip to today,
  totals, formatting), `TimelineView.tsx` (day strip + list),
  `useNow`; `App.tsx` rebuilt; the idle prompt uses the same theme.
- Per-kind colours (working, bio / meal / other break, away phone /
  working, idle prompt) with a legend under the day strip; the status
  dot uses the current segment's colour.
- Durations are exact to the second ("42s", "12m 04s", "1h 05m 12s")
  in the list and in a "Today's totals" card: one row per kind plus
  **On the clock**.
- Today's segments are grouped by clock-in session ("Session 2 ·
  14:02 – now · 1h 10m 05s"); the latest session starts expanded,
  earlier ones collapsed. `Segment` / `SegmentView` gain `session`.
- The main window resizes to fit its content (clock in/out, a session
  expanding, a notice): `useFitWindow` measures the page and calls a
  new `fit_window` command, which clamps height to 360 px … screen
  work area and ignores other windows. The page itself gets no window
  permissions.
- **ADR-0011 (new, Accepted):** calls show as their own **On a call**
  segment (rose) and status on the employee's own screen; reports and
  manager views still count them as active (ADR-0003 §1). Also records
  the voluntary "In a meeting" / "On a phone call" tags, no automatic
  meeting detection, and no check-in cap for voluntary away — those
  tags are implemented in the next PR. ADR-0003 status header notes
  the extension.
- Totals are labelled as **tracked on this device**, not paid hours:
  payroll rules (bio cap, unpaid meal, prompt classification) are
  applied server-side.
- Styles stay inline objects: the CSP (`default-src 'self'`) blocks
  the `<style>` tags Vite injects in dev.
- Tests: Rust 161 (9 new), desktop 38 (11 new).

**Known limitation:** the timeline is in memory until the outbox lands
(2b.4 F3); restarting the app starts an empty day. Viewing past days
(date picker) needs server-side history and follows 2b.4.

### Silent-call cap implementation (ADR-0010) (2026-09-24)

While on a call, the idle prompt now appears after 30 minutes with no
keyboard or pointer input. No new dependencies.

- `packages/policy-schema/idle-policy.schema.json`: new
  `idle.max_silent_call_minutes` (integer 15–480 or `null`, default
  30); documented in `docs/policy/idle-policy-defaults.md` §4.
- `packages/event-schema/schemas/input-idle-5m.schema.json` (new):
  optional `trigger` = `input_idle` | `silent_call`.
- Backend `state-machine.ts`: `INPUT_IDLE_5M` checks its trigger —
  `input_idle` (or absent) only from `ACTIVE`, `silent_call` only from
  `ON_CALL`, anything else rejected. Slightly stricter than ADR-0010's
  table, which lists `ON_CALL → IDLE_PENDING` without a guard; stops
  a mislabelled prompt event being recorded.
- Shared fixture regenerated: 162 cases (was 144).
- Desktop `machine`: `CoreConfig.max_silent_call` (default 30 min);
  `Core` tracks when `ON_CALL` was entered and, while on a call,
  emits `INPUT_IDLE_5M {trigger: silent_call}` once
  max(call start, last input) is 30 min old. The normal prompt now
  carries `trigger: input_idle`. Rust mirror updated.
- `docs/architecture/state-machine.md`: new Scenario H.
- Tests: backend 8 new (trigger rules + a fold) plus 18 new fixture
  rows; desktop 9 new (cap timing, input reset, call not dismissing,
  still-working restart, timeout, disabled cap).

Not wired to a real policy source yet: the desktop uses the default
until policy fetch exists.

Refs: ADR-0010, ADR-0009, ADR-0003.

### ADR-0010 — silent-call cap (2026-09-24)

Docs only; the implementation follows in its own PR.

- **ADR-0010 (new, Accepted)** — while `ON_CALL`, show the normal
  idle prompt after `idle.max_silent_call_minutes` with no keyboard or
  pointer input (default **30**, range 15–480, `null` disables),
  measured from the later of entering the call and the last input.
  Reuses `INPUT_IDLE_5M` with payload `{ "trigger": "silent_call" }`;
  `ON_CALL → IDLE_PENDING` becomes legal. The silent call stays
  payable; a timeout ends the session with `closed_at` = prompt shown.
  Bounds walk-away, left-open-meeting, and mic-holding-app cases that
  PR #8's capture-session detection would otherwise leave unbounded.
- ADR-0003 and ADR-0009 status headers note the extension (content
  unchanged).

Refs: ADR-0003, ADR-0008, ADR-0009, ADR-0010.

### Phase 2b.7.2b PR E — mic detection via audio sessions (2026-09-24)

Fixes the PR D smoke-test failure: a Teams call did not dismiss the
idle prompt, because the consent-store registry check never marked
the mic in use during a live, unmuted call.

- `apps/desktop/src-tauri/src/watchers/audio_session.rs` (new):
  `capture_session_active()` — true iff any non-system-sounds session
  on an active capture endpoint is `AudioSessionStateActive`
  (`IAudioSessionManager2`, the primary source in ADR-0003 §7). One
  boolean; never the owning process, name, or audio. COM failures read
  as "not capturing" (fail safe, ADR-0003 §7). Includes an
  `#[ignore]`d live probe that prints counts only.
- `watchers/mic_cam.rs`: new `WindowsMediaState` source — mic =
  capture session active OR consent store; camera = consent store.
  `lib.rs` uses it instead of `WindowsConsentStore`.
- `Cargo.toml`: enables the `Win32_Media_Audio` feature of the
  existing `windows` crate. No new crate; `Cargo.lock` unchanged.
- Verified on the project owner's machine: during a connected Teams
  call on a webcam mic the probe reported one active capture session;
  the consent store reported none.
- Smoke-tested on top of PR D (Windows): clocking in during a call
  enters `ON_CALL` at once; hang-up is recorded after the 5 s
  debounce; a call started while the prompt is showing closes it; Teams
  stays unmuted.

**Risk:** any app holding a capture stream open (voice assistant,
browser tab with mic access, streaming software) now suppresses the
idle prompt while it runs. `idle.suppress_prompt_when_media_active`
can turn suppression off per policy.

**Doc inconsistency (not changed here):** ADR-0004's example
`MEDIA_DEVICE_STATE` payload shows `device_kind` and `detected_via`;
ADR-0009 fixed the payload to `{ in_use }` only.

Refs: ADR-0003 §7, ADR-0009.

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
