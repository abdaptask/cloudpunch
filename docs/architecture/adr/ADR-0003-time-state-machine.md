# ADR-0003 — Time-tracking state machine

- **Status:** Accepted (Phase 0); §3 `IDLE_PENDING` transitions amended
  by ADR-0008; `ON_CALL` extended by ADR-0009 and ADR-0010 (silent-call
  cap)
- **Date:** 2026-09-23
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Confidence:** High on states and transitions; medium on the exact
  "payable / not payable" defaults per state — those are policy knobs the
  admin can override, see §6.

## Context

The desktop agent, backend, and web dashboard must all agree, at any moment,
on what an employee's *time state* is. Historic ad-hoc timer code produces
duplicate sessions, silently-swallowed events, and disputes at payroll time
that cannot be reconstructed.

CloudPunch models time tracking as an explicit finite state machine so that:

- Every transition is a stored, immutable `time_event`.
- The client is not authoritative — the server verifies each requested
  transition against the current session's state and rejects invalid ones.
- Reports and payroll are derived from the event stream; there is no
  mutable "current state" column that can drift.

Constraints from prior conversations:

- 5-minute inactivity → prompt.
- 30-second grace → auto clock-out if no response.
- Mic or camera in use suppresses the idle prompt (user is on a call).
- Bio-break option in the prompt.
- Autostart-on-login is a togglable feature, off by default.
- Session ends fully on auto clock-out; user must log back in.
- Time captured up to the prompt is preserved; the idle window is **not**
  silently added to payable time.
- Idle threshold, grace, break caps are admin-configurable per policy.
- **No content capture ever.** Mic/camera detection is a boolean OS state,
  not audio or video.

## Decision

### 1. States

Twelve states in a single enum. The enum lives in
`packages/event-schema/state-machine.json` as the schema source of truth
and is codegen'd into TypeScript and Rust.

| # | State | Meaning | Payable by default | Session open? |
|---|---|---|---|---|
| 1 | `CLOCKED_OUT` | No active work session. | — | No |
| 2 | `CLOCKING_IN` | Client submitted clock-in, awaiting server ack. Transitional only, timeout 15 s. | Yes (counted) | Yes (pending) |
| 3 | `ACTIVE` | Working, input recent, no mic/cam activity. | **Yes** | Yes |
| 4 | `ON_CALL` | Mic or camera in use (OS-state, boolean, no content captured) *or* user manually chose "On a phone call". Idle prompt is suppressed. | **Yes** | Yes |
| 5 | `IDLE_PENDING` | 5 min elapsed without input and without call. Prompt visible, 30-s countdown running. | Yes up to prompt appearance; no further payable time accrues until user classifies | Yes |
| 6 | `ON_BREAK` | User classified into a break. Has attribute `break_kind ∈ {bio, meal, other}`. | Depends on `break_kind` — see §6 | Yes |
| 7 | `AWAY` | User classified as working away from computer or in an offline meeting. Has attribute `away_reason ∈ {working_away, phone_call, meeting, other}` and mandatory `note`. | **Yes** (attested work) | Yes |
| 8 | `LOCKED` | Screen locked by the OS. | No | Yes |
| 9 | `SLEEPING` | System entered sleep. | No | Yes |
| 10 | `OFFLINE_PENDING_SYNC` | Network unreachable; agent captures events locally. Session continues; state before offline is preserved. | Per state that was active when offline began | Yes |
| 11 | `CLOCKING_OUT` | Client submitted clock-out, awaiting server ack. Transitional only, timeout 15 s. | No | Yes (pending close) |
| 12 | `ERROR_REQUIRING_ATTENTION` | Invalid transition, clock drift detected, corrupted local DB, or unrecoverable sync conflict. Session is frozen until a `ReviewCase` is resolved. | No | Yes (frozen) |

**Note on `ON_CALL`:** the state exists in the machine so transitions are
recorded, but reports and manager views represent `ON_CALL` time **as
`ACTIVE`**. We do not expose "hours on call" as a separate metric. This
keeps the underlying signal (mic/cam boolean) from becoming a surveillance
axis.

### 2. Events that drive transitions

Ten event families. Every event carries the immutable metadata block from
ADR-0004 (event ID, session ID, client TS, server TS, timezone, device,
app version, offline flag).

| Event | Origin |
|---|---|
| `USER_CLOCK_IN` | User pressed Clock In |
| `USER_CLOCK_OUT` | User pressed Clock Out |
| `USER_PROMPT_RESPONSE` | User answered the idle prompt (`still_working`, `bio_break`, `meal_break`, `on_phone_call`, `working_away`, `end_shift`) |
| `USER_START_BREAK` | User explicitly started a break outside the prompt |
| `USER_END_BREAK` | User ended a break |
| `USER_MARK_AWAY` / `USER_MARK_BACK` | Manual away / back |
| `INPUT_ACTIVITY` | Debounced keyboard or pointer input observed |
| `INPUT_IDLE_5M` | 5 minutes without `INPUT_ACTIVITY` |
| `PROMPT_TIMEOUT_30S` | Idle prompt received no user response within grace window |
| `MEDIA_DEVICE_STATE` | Mic or camera in-use boolean changed (Windows `IAudioSessionManager2`, macOS `AVCaptureDevice`) |
| `SYSTEM_LOCK` / `SYSTEM_UNLOCK` | Screen lock state change |
| `SYSTEM_SLEEP` / `SYSTEM_WAKE` | Suspend / resume |
| `NETWORK_OFFLINE` / `NETWORK_ONLINE` | Reachability change |
| `SERVER_ACK` / `SERVER_REJECT` | Response to `CLOCKING_IN` or `CLOCKING_OUT` |
| `CLOCK_DRIFT_DETECTED` | Agent sampled wall clock vs monotonic clock; delta > threshold |
| `INTEGRITY_VIOLATION` | Signature mismatch, duplicate `event_ulid`, or session mismatch |

### 3. Transition table (complete)

Read as: **from state — event — [guard] — to state — side effects.**

```
CLOCKED_OUT
  ├─ USER_CLOCK_IN                       → CLOCKING_IN     [emit event, send to server]
CLOCKING_IN
  ├─ SERVER_ACK                          → ACTIVE          [start input+call watchers, arm 5-min timer]
  ├─ SERVER_REJECT (assignment_missing)  → CLOCKED_OUT     [show "Access not authorised" screen]
  ├─ SERVER_REJECT (already_open)        → ERROR_REQUIRING_ATTENTION  [show open-session-elsewhere UI]
  ├─ timeout > 15 s                      → OFFLINE_PENDING_SYNC       [keep local state, retry]

ACTIVE
  ├─ INPUT_ACTIVITY                      → ACTIVE          [reset 5-min timer]
  ├─ MEDIA_DEVICE_STATE (in_use=true)    → ON_CALL         [cancel 5-min timer]
  ├─ INPUT_IDLE_5M                       → IDLE_PENDING    [show prompt, arm 30-s countdown]
  ├─ USER_START_BREAK (kind=bio)         → ON_BREAK        [kind=bio; arm bio-cap timer]
  ├─ USER_START_BREAK (kind=meal)        → ON_BREAK        [kind=meal]
  ├─ USER_START_BREAK (kind=other)       → ON_BREAK        [kind=other]
  ├─ USER_MARK_AWAY                      → AWAY            [require reason + note]
  ├─ USER_CLOCK_OUT                      → CLOCKING_OUT
  ├─ SYSTEM_LOCK                         → LOCKED
  ├─ SYSTEM_SLEEP                        → SLEEPING
  ├─ NETWORK_OFFLINE                     → OFFLINE_PENDING_SYNC (prior=ACTIVE)
  ├─ CLOCK_DRIFT_DETECTED                → ERROR_REQUIRING_ATTENTION

ON_CALL
  ├─ MEDIA_DEVICE_STATE (in_use=false)   → ACTIVE          [re-arm 5-min timer from now]
  ├─ INPUT_ACTIVITY                      → ON_CALL         [no state change; do not re-arm 5-min timer while on call]
  ├─ USER_START_BREAK                    → ON_BREAK        [kind attribute]
  ├─ USER_CLOCK_OUT                      → CLOCKING_OUT
  ├─ SYSTEM_LOCK                         → LOCKED
  ├─ SYSTEM_SLEEP                        → SLEEPING
  ├─ NETWORK_OFFLINE                     → OFFLINE_PENDING_SYNC (prior=ON_CALL)

IDLE_PENDING
  ├─ USER_PROMPT_RESPONSE (still_working) → ACTIVE          [re-arm 5-min timer]
  ├─ USER_PROMPT_RESPONSE (bio_break)     → ON_BREAK        [kind=bio]
  ├─ USER_PROMPT_RESPONSE (meal_break)    → ON_BREAK        [kind=meal]
  ├─ USER_PROMPT_RESPONSE (on_phone_call) → AWAY            [reason=phone_call, note optional]
  ├─ USER_PROMPT_RESPONSE (working_away)  → AWAY            [reason=working_away, note required]
  ├─ USER_PROMPT_RESPONSE (end_shift)     → CLOCKING_OUT
  ├─ INPUT_ACTIVITY                       → ACTIVE          [dismiss prompt, re-arm 5-min timer]
  ├─ MEDIA_DEVICE_STATE (in_use=true)     → ON_CALL         [dismiss prompt]
  ├─ PROMPT_TIMEOUT_30S                   → CLOCKING_OUT   [reason=idle_auto_clock_out, preserve time up to prompt appearance, DO NOT include the 5-min idle window OR the 30-s grace in payable time]

ON_BREAK
  ├─ USER_END_BREAK                       → ACTIVE
  ├─ break duration > policy cap AND kind=bio  → soft-nudge (notification only, no state change)
  ├─ break duration > policy cap AND kind=meal → soft-nudge
  ├─ USER_CLOCK_OUT                       → CLOCKING_OUT
  ├─ SYSTEM_LOCK                          → LOCKED         [remember break_kind for resume]
  ├─ NETWORK_OFFLINE                      → OFFLINE_PENDING_SYNC (prior=ON_BREAK, kind)

AWAY
  ├─ USER_MARK_BACK                       → ACTIVE
  ├─ INPUT_ACTIVITY                       → ACTIVE          [ask for confirmation once]
  ├─ USER_CLOCK_OUT                       → CLOCKING_OUT
  ├─ SYSTEM_LOCK                          → LOCKED         [remember away_reason for resume]
  ├─ NETWORK_OFFLINE                      → OFFLINE_PENDING_SYNC (prior=AWAY, reason)

LOCKED
  ├─ SYSTEM_UNLOCK                        → previous state (ACTIVE / ON_CALL / ON_BREAK / AWAY)
  ├─ elapsed > policy max-lock-duration   → ERROR_REQUIRING_ATTENTION  [creates ReviewCase]

SLEEPING
  ├─ SYSTEM_WAKE                          → previous state
  ├─ elapsed > policy max-sleep-duration  → ERROR_REQUIRING_ATTENTION  [creates ReviewCase]

OFFLINE_PENDING_SYNC
  ├─ NETWORK_ONLINE                       → previous state [drain outbox, reconcile with server]
  ├─ server rejects a drained event       → ERROR_REQUIRING_ATTENTION

CLOCKING_OUT
  ├─ SERVER_ACK                           → CLOCKED_OUT
  ├─ SERVER_REJECT                        → ERROR_REQUIRING_ATTENTION
  ├─ timeout > 15 s                       → OFFLINE_PENDING_SYNC       [retry]

ERROR_REQUIRING_ATTENTION
  ├─ User acks + reason recorded          → CLOCKED_OUT   [session marked corrupted, ReviewCase created for HR/manager]
```

### 4. Invariants — enforced in code and CI

1. **Exactly one non-`CLOCKED_OUT` session per employee, across all devices.**
   The backend enforces this with a unique partial index on
   `time_session(employee_id) WHERE closed_at IS NULL`. A second device
   trying to clock in receives `409 Conflict` with `code=session_open_on_other_device`.
2. **All transitions are recorded**, never inferred. Every event in §2 that
   causes a state change generates exactly one `time_event` row.
3. **Time-machine invariant.** `state` is derived from the event stream; it
   is never stored as a mutable column. A cached `latest_state` may exist
   for query performance but must be rebuildable from events.
4. **Ordering.** Events within a session are strictly ordered by `event_ulid`
   (monotonic per session). Server rejects out-of-order or duplicate
   `event_ulid` within a session.
5. **Auto-clock-out preserves history.** The `PROMPT_TIMEOUT_30S` transition
   sets the session's `closed_at` to the moment the prompt appeared (5 min
   after the last `INPUT_ACTIVITY`), **not** to the moment the timeout fired.
   The 5-min idle window and the 30-s grace are recorded as a distinct
   `idle_period` row on the session but do **not** contribute to payable
   hours by default.
6. **No content capture** — enforced by `test/invariants/no-content-capture.ts`
   which greps the event schema for any field name in a deny-list
   (`keystroke`, `screenshot`, `clipboard`, `filename`, `url`,
   `window_title`, `app_name`, `mic_audio`, `camera_frame`). CI fails on
   violation.
7. **Payability is deterministic.** Given the event stream and the active
   policy at the time, the payable minutes are reproducible to the second.
   No LLM, no heuristics, no rounding.
8. **State-transition test coverage ≥ 95%** of transitions in the table
   above (property-based tests). Every transition must have a positive
   test and at least one negative test (attempting the transition from an
   invalid state → server rejects).

### 5. Diagram (ASCII)

```
                                     (agent launch, no open session)
                                                    │
                                                    ▼
                    ┌───────────────────────── CLOCKED_OUT ◀───────────────────┐
                    │                                  │                       │
                    │                    USER_CLOCK_IN │                       │
                    │                                  ▼                       │
                    │                            CLOCKING_IN                   │
                    │                                  │                       │
                    │                       SERVER_ACK │  SERVER_REJECT        │
                    │                                  ▼                       │
                    │  ┌──────── MEDIA in_use=false ─ ACTIVE ◀─── INPUT ──┐    │
                    │  │                                │                 │    │
                    │  │           MEDIA in_use=true    │ INPUT_IDLE_5M   │    │
                    │  │                     ┌──────────┴─────┐           │    │
                    │  ▼                     ▼                ▼           │    │
                    │ ON_CALL          IDLE_PENDING          ON_BREAK ────┤    │
                    │  │                (prompt shown)      (bio/meal/    │    │
                    │  │                 30-s grace)        other)        │    │
                    │  └────── MEDIA in_use=false ────►     │             │    │
                    │                                       │             │    │
                    │  USER_PROMPT_RESPONSE  ┌──────────────┴──┐          │    │
                    │  ├─ still_working      │                 │          │    │
                    │  │        └─► ACTIVE   │                 │          │    │
                    │  ├─ bio_break          │                 │          │    │
                    │  │        └─► ON_BREAK │                 │          │    │
                    │  ├─ meal_break         │                 │          │    │
                    │  │        └─► ON_BREAK │                 │          │    │
                    │  ├─ on_phone_call      │                 │          │    │
                    │  │        └─► AWAY     │  PROMPT_TIMEOUT_30S        │    │
                    │  ├─ working_away       │                 ▼          │    │
                    │  │        └─► AWAY     │           CLOCKING_OUT ────┼────┤
                    │  └─ end_shift          │                            │    │
                    │           └─► CLOCKING_OUT ────────────────────────►│    │
                    │                                                     │    │
                    │  SYSTEM_LOCK/SLEEP from any working state           │    │
                    │           │                                         │    │
                    │           ▼                                         │    │
                    │       LOCKED / SLEEPING ────── UNLOCK/WAKE ────────►│    │
                    │           │                                         │    │
                    │           └─── elapsed > max ────► ERROR            │    │
                    │                                                     │    │
                    │  NETWORK_OFFLINE from any working state             │    │
                    │           │                                         │    │
                    │           ▼                                         │    │
                    │    OFFLINE_PENDING_SYNC ─── NETWORK_ONLINE ────────►│    │
                    │                                                     │    │
                    └──── CLOCKING_OUT ─── SERVER_ACK ────────────────────┘    │
                              │                                                │
                              │ SERVER_REJECT / timeout                        │
                              ▼                                                │
                    ERROR_REQUIRING_ATTENTION ─── user acks ────────────────► ─┘
                                (creates ReviewCase)
```

### 6. Payability defaults (policy-configurable)

Every deployment ships with these defaults; admin can override per policy,
per team, or per employee.

| State | Sub-attribute | Payable | Notes |
|---|---|---|---|
| `ACTIVE` | — | **Yes** | |
| `ON_CALL` | — | **Yes** | Same as ACTIVE; not separately reported. |
| `IDLE_PENDING` | up to prompt | Yes | Only the time up to the prompt appearance. |
| `IDLE_PENDING` | 5-min idle + 30-s grace | **No** | The idle window before response, and the grace before auto-clock-out, are not payable. Recorded as `idle_period`. |
| `ON_BREAK` | `bio` (≤ cap) | **Yes** | Cap default 10 min. Time beyond cap is `no` and generates a nudge. |
| `ON_BREAK` | `meal` | **No** | India norm: unpaid meal. Override per policy. |
| `ON_BREAK` | `other` | **No** | Explicit user attestation required. |
| `AWAY` | `working_away` (with note) | **Yes** | Manager may adjust during timesheet review. |
| `AWAY` | `phone_call` | **Yes** | Same as ACTIVE. |
| `AWAY` | `meeting` | **Yes** | |
| `AWAY` | `other` | **No** unless manager approves | |
| `LOCKED` | — | **No** | Not working. |
| `SLEEPING` | — | **No** | |
| `OFFLINE_PENDING_SYNC` | inherits prior | prior's rule | If offline began during `ACTIVE`, still payable — user was working during the outage. |

**Policy JSON schema** for these defaults lives in
`packages/policy-schema/payability.schema.json` and is validated on load.

### 7. Intelligent-idle: mic/camera in-use detection

**What we detect:** a single boolean per moment — "any process on this
machine is currently using the microphone OR any camera device."

**What we do not detect and do not store:**
- Which app is using it
- Audio content, transcript, or waveform
- Video frames or camera feed
- Meeting name, participant list, or duration in any recognisable form

**Windows implementation (Rust `windows` crate):**
- `IMMDeviceEnumerator` → `IMMDevice` for the default communications
  microphone.
- `IAudioSessionManager2::GetSessionEnumerator()` → iterate
  `IAudioSessionControl2` → check `GetState()` for `AudioSessionStateActive`.
- Poll every 5 seconds. Coalesce edge transitions into `MEDIA_DEVICE_STATE`
  events (`in_use=true` when first active session appears; `in_use=false`
  when the last active session ends and stays absent for ≥ 5 s to debounce
  transient audio like system beeps).
- **Cross-check** against
  `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone`
  `LastUsedTimeStop = 0` (means "currently in use") for robustness.

**macOS implementation (Rust `objc2` + `core-foundation`):**
- `AVCaptureDevice.default(for: .audio)` on the built-in mic. Observe the
  `AVCaptureDevice.isInUseByAnotherApplicationKey` KVO property.
- Camera: same for `.video`.
- `TCC` system service surfaces the orange status-bar dot state — we
  observe the same private conditions used by that dot, which are readable
  from user space without special entitlement on macOS 12–14 and are still
  observable on macOS 15 via `AVCaptureDevice` observation (not the direct
  TCC read).
- Poll every 5 seconds; same debounce rules as Windows.

**Fallback (both OSes):** if the OS API is not accessible at runtime (e.g.
new macOS version broke the reader), the agent **fails safe** — treats the
system as *not* on a call, so the idle prompt fires normally. The user
still has the "On a phone call" manual option in the prompt. We log the
API failure as a health telemetry event, never as an anomaly.

### 8. Multi-device handling

- The `time_session` table has a unique partial index preventing two open
  sessions per employee across devices.
- If the user attempts to clock in on a second device while a session is
  open elsewhere, the backend returns
  `409 { code: "session_open_on_other_device", device_name: "…", opened_at: "…" }`.
  The desktop UI offers two choices:
  - **Take over here** — sends `USER_CLOCK_OUT` for the other device
    (with reason `remote_takeover`) and immediately opens a new session.
  - **Cancel** — no-op.
- If both devices are simultaneously reporting input activity within any
  10-second window (which the transition machine should make impossible),
  a `MULTI_DEVICE_CONCURRENT_ACTIVITY` anomaly signal is raised. This is a
  ReviewCase, not an accusation.

### 9. Clock drift and clock manipulation

- Agent samples `wall_clock` (`SystemTime::now`) and `monotonic_clock`
  (`Instant::now`) every 30 seconds. Records deltas.
- If two consecutive samples show `(wall_delta − monotonic_delta) > 60 s`
  (default; policy-configurable), emit `CLOCK_DRIFT_DETECTED`. The state
  machine transitions to `ERROR_REQUIRING_ATTENTION`. A ReviewCase is
  created with the sample deltas as evidence.
- On every event, the server also compares `client_ts` and `server_ts`.
  Deltas > 60 s beyond the token's `iat` skew tolerance are flagged and
  stored, but do not auto-freeze the session — only agent-side detection
  does.

### 10. Session-close scenarios

- **Normal:** `USER_CLOCK_OUT` → `CLOCKING_OUT` → `SERVER_ACK` → `CLOCKED_OUT`.
- **Auto-idle:** `PROMPT_TIMEOUT_30S` → `CLOCKING_OUT` (reason
  `idle_auto_clock_out`) → server-acked → `CLOCKED_OUT`. Session
  `closed_at = idle_prompt_shown_at`. **User must log in again.**
- **App exit while clocked in:** agent registers OS shutdown/quit hooks.
  Writes a final event `intent=CLOCK_OUT, reason=app_exit_reconstructed`.
  Marked as `reconstructed=true` on the session; visible to the manager
  during timesheet review with a "please confirm" nudge.
- **System shutdown / crash:** agent's next launch detects a stale open
  session in local SQLite, emits `SESSION_RECOVERED` event, and enters
  `CLOCKING_OUT` with `reason=system_shutdown_reconstructed`. Timestamp is
  the last known heartbeat time. Manager review required.
- **Termination in greytHR while clocked in** (once greytHR is enabled):
  next backend heartbeat check terminates the session with
  `reason=greythr_termination_forced`, records last heartbeat as
  `closed_at`, and freezes the session for HR review.

### 11. Autostart-on-login (policy)

- **Default: disabled.** Employee launches the app deliberately each
  session.
- Toggle available in the app settings and in the CloudPunch admin console.
- Admin can set the toggle default globally or override per user.
- If autostart is enabled, the app opens minimised to the tray/menu bar
  and requires the user to click "Clock In" — it does not clock in
  automatically. This is deliberate: an autostart is a system launch, not
  a user intention to start work.

### 12. Notes on the "on a phone call" path

Someone on a **phone** (not a computer) call cannot be detected via
mic/cam. They will hit the idle prompt. The prompt option "On a phone call"
transitions to `AWAY (reason=phone_call)` which is payable by default,
preserves the reason for the manager view, and does not require a note
(but allows one).

## Consequences

### Positive

- Zero ambiguity about payable time: the event stream is the ledger.
- Auditability is inherent — every state change is a row with actor, TS,
  device, and reason.
- Explicit invariants let CI catch regressions in payability calculation.
- Manager review has structured signals to look at, not a pile of raw
  input events.

### Negative

- More events per session than a "just log when they clock in and out"
  design. Rough estimate: ~30 events per 8-hour session at peak (idle
  timers, calls, breaks, locks). At 1000 employees × 250 workdays that is
  ~7.5M events/year. Aurora Postgres handles this trivially with monthly
  partitioning (ADR-0004).
- Mic/camera detection has OS-version quirks. Explicit fallback and
  "manual override in prompt" cover it.

### Neutral

- ON_CALL is a first-class state but hidden from user-facing reports. This
  is intentional to avoid the metric becoming a manager pressure signal.

## Alternatives considered

### Two separate state machines (payroll clock + presence)

Cleaner separation in theory. **Rejected** — combinatorial transition
tables become opaque and the payable-minutes rule ends up scattered across
two engines.

### Mic/cam detection as a state-suppressing condition, not a state

Simpler. **Rejected** because we lose the audit record of when the
suppression was in effect. The `ON_CALL` state gives us that with a small
cost.

### Auto-classify idle time as "away, working elsewhere" without prompting

Nicer UX. **Rejected** — silent classification is exactly the surveillance
posture we are avoiding. The user must classify; the system offers a
sensible default and a 30-s grace, then closes the session honestly.

### Longer grace window (5 minutes instead of 30 seconds)

**Rejected** — the whole point is that unresponsive time is not payable.
A 5-minute grace lets an inattentive user pad their day; 30 s is enough
to move the mouse and click "still working" if they were briefly away.

## Follow-up

- ADR-0004 defines the exact `time_event` schema and idempotent-ingest rules.
- ADR-0005 defines the employee source-of-truth question and how state
  survives an employee transferring from `local_admin` to `greythr`.
- `docs/architecture/state-machine.md` will hold the human-readable
  reference version of this diagram and a transition-by-transition example
  ("Alice's Wednesday").
- `docs/policy/idle-policy-defaults.md` documents the admin-configurable
  knobs and their defaults.
- Phase 1 will produce `packages/event-schema/state-machine.json` and the
  Rust + TS codegen script.

## References

- Nygard, *Documenting Architecture Decisions*, 2011.
- Microsoft `IAudioSessionManager2` docs —
  https://learn.microsoft.com/windows/win32/api/audiopolicy/nn-audiopolicy-iaudiosessionmanager2
- Apple `AVCaptureDevice` docs —
  https://developer.apple.com/documentation/avfoundation/avcapturedevice
- Prior conversation on 2026-09-23 with the project owner: 5-min threshold,
  30-s grace, bio-break option, auto-clock-out on unresponsive idle,
  mic/cam metadata-only detection acceptable.
