# CloudPunch time-tracking state machine — reference

This document is the human-readable companion to
[ADR-0003](adr/ADR-0003-time-state-machine.md). Read the ADR first for
the "why"; use this file for the "how it plays out" and to check your
mental model against worked examples.

Nothing here overrides the ADR. If the two conflict, the ADR wins and
this file is out of date.

## Quick reference — states

| State | One-line meaning | Session open? | Payable? |
|---|---|---|---|
| `CLOCKED_OUT` | No session | — | — |
| `CLOCKING_IN` | Awaiting server ack (transitional, ≤ 15 s) | Pending | yes |
| `ACTIVE` | Working, input recent, no call | Yes | **yes** |
| `ON_CALL` | Mic/camera in use, or user chose "on a call" | Yes | **yes** (reports as `ACTIVE`) |
| `IDLE_PENDING` | 5 min of silence, prompt shown, 30-s grace ticking (input resets the countdown but does not dismiss — ADR-0008) | Yes | classified by the prompt response; not payable on timeout |
| `ON_BREAK` (`bio` \| `meal` \| `other`) | On a break with attributed kind | Yes | policy-dependent (bio yes, meal no by default) |
| `AWAY` (`working_away` \| `phone_call` \| `meeting` \| `other`) | Away from computer with a reason | Yes | yes for attested reasons |
| `LOCKED` | System screen locked | Yes | no |
| `SLEEPING` | System asleep | Yes | no |
| `OFFLINE_PENDING_SYNC` | Network down; agent captures locally | Yes | inherits prior |
| `CLOCKING_OUT` | Awaiting server ack for clock-out | Pending close | no |
| `ERROR_REQUIRING_ATTENTION` | Frozen; ReviewCase created | Yes (frozen) | no |

## Full diagram

```
                                     ┌──────────────────┐
                                     │  CLOCKED_OUT     │◀─────────────────┐
                                     └────────┬─────────┘                  │
                                              │ USER_CLOCK_IN              │
                                              ▼                            │
                                      ┌──────────────────┐                 │
                                      │  CLOCKING_IN     │                 │
                                      └───────┬──────────┘                 │
                                    SERVER_ACK│  SERVER_REJECT             │
                                              ▼                            │
                    ┌──── MEDIA in_use=false ─┤─────────── INPUT ──┐       │
                    │                   ┌─────▼───┐                │       │
                    │                   │ ACTIVE  │◀───────────────┘       │
                    │                   └────┬────┘                        │
                    │            INPUT_IDLE_5M │ (mic+cam idle)            │
                    │                          ▼                           │
                    │                 ┌──────────────────┐                 │
                    │                 │  IDLE_PENDING    │                 │
                    │                 │  30-s countdown  │                 │
                    │                 └────┬─────────────┘                 │
                    │  USER_PROMPT_RESPONSE│                               │
                    │  ├─ still_working ───┼──► ACTIVE (re-arm 5-min)      │
                    │  ├─ bio_break ───────┼──► ON_BREAK (bio)             │
                    │  ├─ meal_break ──────┼──► ON_BREAK (meal)            │
                    │  ├─ on_phone_call ───┼──► AWAY (phone_call)          │
                    │  ├─ working_away ────┼──► AWAY (working_away)        │
                    │  └─ end_shift ───────┼──► CLOCKING_OUT ─────────────►│
                    │  PROMPT_TIMEOUT_30S ─┼──► CLOCKING_OUT              (auto-clock-out)
                    │                                                      │
                    │  MEDIA in_use=true from ACTIVE / IDLE_PENDING        │
                    │       │                                              │
                    │       ▼                                              │
                    │  ┌────────────┐                                      │
                    │  │  ON_CALL   │─── MEDIA in_use=false → ACTIVE       │
                    │  └────────────┘                                      │
                    │                                                      │
                    │  USER_START_BREAK / USER_END_BREAK                   │
                    │       │                                              │
                    │       ▼                                              │
                    │  ┌────────────┐                                      │
                    │  │  ON_BREAK  │─── USER_END_BREAK → ACTIVE           │
                    │  └────────────┘                                      │
                    │                                                      │
                    │  USER_MARK_AWAY / USER_MARK_BACK / INPUT_ACTIVITY    │
                    │       │                                              │
                    │       ▼                                              │
                    │  ┌────────────┐                                      │
                    │  │   AWAY     │─── USER_MARK_BACK → ACTIVE           │
                    │  └────────────┘                                      │
                    │                                                      │
                    │  SYSTEM_LOCK  / SYSTEM_UNLOCK                        │
                    │       │                                              │
                    │       ▼                                              │
                    │  ┌────────────┐                                      │
                    │  │  LOCKED    │─── SYSTEM_UNLOCK → prior state       │
                    │  └────────────┘                                      │
                    │                                                      │
                    │  SYSTEM_SLEEP / SYSTEM_WAKE                          │
                    │       │                                              │
                    │       ▼                                              │
                    │  ┌────────────┐                                      │
                    │  │ SLEEPING   │─── SYSTEM_WAKE → prior state         │
                    │  └────────────┘                                      │
                    │                                                      │
                    │  NETWORK_OFFLINE / NETWORK_ONLINE                    │
                    │       │                                              │
                    │       ▼                                              │
                    │  ┌───────────────────────┐                           │
                    │  │ OFFLINE_PENDING_SYNC  │─── NETWORK_ONLINE →       │
                    │  │ (records prior state) │      drain outbox,        │
                    │  └───────────────────────┘      return to prior      │
                    │                                                      │
                    │  ERROR_REQUIRING_ATTENTION  (from any state on       │
                    │       │       clock drift / signature / dup ULID)    │
                    │       └────── user acknowledgement + reason ────────►│
                    │                                                      │
                    └── USER_CLOCK_OUT ─► CLOCKING_OUT ─► SERVER_ACK ──────┘
```

## Transition rules — canonical table

The complete transition table lives in ADR-0003 §3. Skim it there;
this file expands on the intent rather than restating rows.

## Payable-time worked example: "Alice's Wednesday"

Alice is a software engineer in Bengaluru, `Asia/Kolkata` (UTC+05:30).
Her day:

- 09:00 clocks in
- 09:00–10:30 coding
- 10:30–11:00 on a Zoom stand-up
- 11:00–11:15 stares at whiteboard (idle)
- 11:15 back to coding
- 13:00–14:00 lunch (walks away from desk, does not clock out)
- 14:00–16:00 focused coding
- 16:00 laptop crashes (kernel panic)
- 16:10 laptop back up; app recovers
- 16:10–17:00 more coding
- 17:00 clocks out

The event stream, in order:

| # | Time (IST) | Event | New state | Notes |
|---|---|---|---|---|
| 1 | 09:00:03 | `USER_CLOCK_IN` | `CLOCKING_IN` | Sequence 1 |
| 2 | 09:00:03 | `SERVER_ACK` | `ACTIVE` | Session opens; timer armed |
| 3 | 09:00–10:30 | many `INPUT_ACTIVITY` (debounced) | `ACTIVE` | Timer keeps resetting |
| 4 | 10:30:00 | `MEDIA_DEVICE_STATE {in_use:true}` | `ON_CALL` | Zoom starts using mic |
| 5 | 11:00:00 | `MEDIA_DEVICE_STATE {in_use:false}` | `ACTIVE` | Zoom ends. Timer re-armed. |
| 6 | 11:05:00 | last `INPUT_ACTIVITY` for a while | `ACTIVE` | Alice on whiteboard |
| 7 | 11:10:00 | `INPUT_IDLE_5M` fires | `IDLE_PENDING` | Prompt shown |
| 8 | 11:10:20 | `USER_PROMPT_RESPONSE {response: still_working}` — Alice clicks "I'm still working" | `ACTIVE` | Moving the mouse reset the grace countdown but did not dismiss the prompt (ADR-0008) |
| 9 | 13:00:00 | Alice explicitly clicks Bio → Meal Break | `ON_BREAK` (meal) | Sequence marches on |
| 10 | 14:02:00 | `USER_END_BREAK` | `ACTIVE` | |
| 11 | 14:02–16:00 | `INPUT_ACTIVITY` | `ACTIVE` | |
| 12 | 16:00:00 | (crash) | — | No further events |
| 13 | 16:09:30 | agent relaunches; detects stale open session in local SQLite | `OFFLINE_PENDING_SYNC` | Sequence continues from local counter |
| 14 | 16:09:31 | `NETWORK_ONLINE` | `OFFLINE_PENDING_SYNC` → resumes | Drains outbox |
| 15 | 16:09:31 | server sees stale session, agent emits `SESSION_RECOVERED` with evidence | `ACTIVE` | Reconstructed event; last heartbeat at 15:59:40, so `reconstruction_evidence` records the gap |
| 16 | 16:09–17:00 | `INPUT_ACTIVITY` | `ACTIVE` | |
| 17 | 17:00:04 | `USER_CLOCK_OUT` | `CLOCKING_OUT` | |
| 18 | 17:00:04 | `SERVER_ACK` | `CLOCKED_OUT` | Session closes |

**Payable time calculation** (defaults from ADR-0003 §6):

| Interval | State | Duration | Payable? |
|---|---|---|---|
| 09:00:03–10:30:00 | ACTIVE | 1:29:57 | yes |
| 10:30:00–11:00:00 | ON_CALL | 0:30:00 | yes |
| 11:00:00–11:05:00 | ACTIVE | 0:05:00 | yes |
| 11:05:00–11:10:00 | ACTIVE (silent input) | 0:05:00 | yes |
| 11:10:00–11:10:20 | IDLE_PENDING (answered `still_working`) | 0:00:20 | yes (classified by response, ADR-0008 §3) |
| 11:10:20–13:00:00 | ACTIVE | 1:49:40 | yes |
| 13:00:00–14:02:00 | ON_BREAK (meal) | 1:02:00 | **no** (meal default) |
| 14:02:00–15:59:40 | ACTIVE | 1:57:40 | yes |
| 15:59:40–16:09:30 | (crash gap, reconstructed) | 0:09:50 | **no** — reconstructed events don't accrue payable time by default. Alice will see this on her timesheet with a "please confirm" prompt. |
| 16:09:31–17:00:04 | ACTIVE | 0:50:33 | yes |

**Total payable: ~7 h 08 min.** Total elapsed session: ~8 h 00 min.
The delta is meal break plus the reconstructed crash window. Alice
sees both explicitly on her timesheet and can request a correction on
the crash window (with a reason like "I was in a meeting on my phone
during the crash").

## Notable transition scenarios

### Scenario A — user is on a phone call at their desk

Mic/camera unused (phone is offline hardware). After 5 minutes of no
mouse/keyboard input, the prompt fires. User clicks **On a phone
call**. Transitions to `AWAY (reason=phone_call)`. Time keeps
accruing. When the call ends, user clicks **Back** or moves the mouse
— transitions to `ACTIVE`, timer re-armed.

### Scenario B — user goes to the restroom

User clicks the tray icon → **Bio break**. Transitions to `ON_BREAK
(kind=bio)`. Bio-break cap is 10 minutes; at 11 minutes a soft
notification nudges "Still on break?" but does not change state.
`USER_END_BREAK` returns to `ACTIVE`. Bio-break time up to the cap is
payable.

### Scenario C — laptop screen locks while active

`SYSTEM_LOCK` transitions to `LOCKED`. Payable time stops accruing.
User comes back, unlocks the screen (`SYSTEM_UNLOCK`), state returns
to the prior (`ACTIVE`). The `LOCKED` interval is recorded and shown
on the timesheet.

If the lock lasts longer than the policy's `max_lock_duration`
(default 2 h), the state transitions to `ERROR_REQUIRING_ATTENTION`
and a ReviewCase is created — the assumption being that a >2h locked
period during a session is either "user forgot to clock out" or
"stolen device with a slow lock-timeout".

### Scenario D — Wi-Fi drops for 45 minutes

`NETWORK_OFFLINE` transitions to `OFFLINE_PENDING_SYNC` while
recording that the prior state was `ACTIVE`. Agent continues
tracking, writing events to the encrypted SQLite outbox. When Wi-Fi
returns, `NETWORK_ONLINE` fires; the sync loop drains the outbox in
sequence order. Server accepts every event because ULIDs are unique
and signatures verify. State returns to `ACTIVE`. Payable time
accrued during the offline window is preserved.

### Scenario E — two devices try to clock in

Alice starts CloudPunch on her Mac at home, clocks in, then heads to
the office and opens CloudPunch on her Windows machine. Attempting
`USER_CLOCK_IN` on Windows returns `409
session_open_on_other_device`. Windows UI offers **Take over here**.
Alice accepts. Windows sends a synthetic `USER_CLOCK_OUT` for the Mac
session with `reason=remote_takeover`, closes the Mac session, then
opens a fresh session on Windows. Time from the Mac session is
preserved; the takeover is audited.

### Scenario F — clock manipulation attempt

An employee tries to advance the system clock to end the shift
earlier. The agent samples wall vs monotonic every 30 seconds. Between
two samples wall advances 70 minutes while monotonic advances 30
seconds — delta is 69m30s, far beyond the 60-second threshold.
`CLOCK_DRIFT_DETECTED` fires, session transitions to
`ERROR_REQUIRING_ATTENTION`. The `time_event` records both sample
deltas as evidence. ReviewCase is created for the manager. **No
punitive action is taken automatically** — the review case merely
surfaces the discrepancy with the raw evidence.

### Scenario G — user closes the app while clocked in

Agent has an OS shutdown/quit hook. It emits a final event
`intent=CLOCK_OUT, reason=app_exit_reconstructed`, `origin=reconstructed`,
before the process dies. On next launch the agent notices the session
was closed by that reconstructed event. Manager sees it on the
timesheet with a warning icon and a "please confirm exact clock-out
time" prompt.

## Invariants — one-line summary

1. Exactly one non-`CLOCKED_OUT` session per employee across all devices.
2. Every state change is a persisted, signed event. Nothing is inferred.
3. `state` is derived from events; never stored as a mutable column.
4. Events within a session are strictly ordered by ULID and sequence
   number.
5. Auto-clock-out preserves history correctly: `closed_at` is when the
   prompt appeared, not when the timeout fired.
6. **No content capture, ever.** The mic/cam detection is a boolean OS
   state and cannot be used to derive who Alice was on a call with, or
   what she was saying.
7. Payability is deterministic given the event stream and the policy
   at that time. Reproducible to the second.

## When you find a bug

- If the bug is in the machine (an "impossible" transition, a
  duplicated event that shouldn't have been), open an issue and
  reference the exact ADR-0003 section that expresses the rule.
- If the bug is in the reference docs (this file or the ADR) but not
  in the code, fix the doc first, then decide whether the code needs a
  test to catch the case.
- Never fix a state-machine bug by adding a special case. Special
  cases here become payroll disputes later. Change the enum, add the
  event, update the ADR.
