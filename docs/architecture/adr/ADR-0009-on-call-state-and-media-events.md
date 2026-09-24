# ADR-0009 — `ON_CALL` state, media events, and call-dismissed prompts

- **Status:** Accepted (2026-09-24); §2 `ON_CALL` transitions extended
  by ADR-0010 (silent-call cap); §1 payload extended by ADR-0012
  (optional `call_type`)
- **Date:** 2026-09-24
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Extends:** ADR-0003 §2–§3 (`MEDIA_DEVICE_STATE`, `ON_CALL`) and
  ADR-0008 §3 (prompt-pending classification). Neither is superseded.
- **Confidence:** High on the transitions (they are ADR-0003's, now
  implemented); medium on the payable classification in §3 — a policy
  call confirmed by the project owner, which HR may want to revisit.

## Context

ADR-0003 defines an `ON_CALL` state entered and left by
`MEDIA_DEVICE_STATE`. The backend MVP state machine
(`apps/backend/src/events/state-machine.ts`) treated
`MEDIA_DEVICE_STATE` as ambient and had no `ON_CALL` state, so a call
starting while the idle prompt was visible did not leave
`IDLE_PENDING` server-side, contrary to ADR-0003 and ADR-0008 §1.

Implementing it surfaced four gaps the earlier ADRs leave open:

1. **Payload shape.** No schema exists for `MEDIA_DEVICE_STATE`. The
   desktop watcher observes mic and camera separately.
2. **Prompt-pending interval when a call dismisses the prompt.**
   ADR-0008 §3 classifies that interval by the user's response, but a
   call starting is not a response.
3. **`USER_MARK_AWAY` from `ON_CALL`.** ADR-0003 §3 does not list it.
4. **Grace-countdown resets.** ADR-0008 §2 has input reset the grace
   countdown, which can happen every second; ADR-0003 §2 describes
   `INPUT_ACTIVITY` as an event.

## Decision

### 1. Payload: one boolean

`MEDIA_DEVICE_STATE.payload = { "in_use": boolean }`, nothing else
(`schemas/media-device-state.schema.json`, `additionalProperties:
false`). `in_use` is `mic || camera`. The agent never reports which
device, matching ADR-0003 §7 ("a single boolean per moment") and
invariant 1. A `MEDIA_DEVICE_STATE` without a boolean `in_use` is an
invalid transition in every state.

### 2. Transitions (backend and desktop)

```
ACTIVE
  ├─ MEDIA_DEVICE_STATE (in_use=true)    → ON_CALL
  ├─ MEDIA_DEVICE_STATE (in_use=false)   → ACTIVE          [no-op]
IDLE_PENDING
  ├─ MEDIA_DEVICE_STATE (in_use=true)    → ON_CALL         [dismiss prompt]
  ├─ MEDIA_DEVICE_STATE (in_use=false)   → IDLE_PENDING    [no-op]
ON_CALL
  ├─ MEDIA_DEVICE_STATE (in_use=false)   → ACTIVE          [re-arm idle timer from now]
  ├─ MEDIA_DEVICE_STATE (in_use=true)    → ON_CALL         [no-op]
  ├─ INPUT_ACTIVITY                      → ON_CALL
  ├─ USER_START_BREAK                    → ON_BREAK
  ├─ USER_CLOCK_OUT                      → CLOSED
  └─ anything else                       → rejected
ON_BREAK / AWAY / CLOSED
  └─ MEDIA_DEVICE_STATE (either value)   → unchanged       [recorded, ambient]
```

`USER_MARK_AWAY`, `INPUT_IDLE_5M`, and `USER_PROMPT_RESPONSE` are
rejected from `ON_CALL`. A user on a call who wants to step away ends
the call first; the prompt cannot fire during a call so there is
nothing to respond to.

### 3. A call dismissing the prompt is payable

When `MEDIA_DEVICE_STATE (in_use=true)` ends `IDLE_PENDING`, the
interval from prompt shown to the media event is classified as
`ON_CALL` — **payable**, the same as `still_working` in ADR-0008 §3.
The user demonstrably returned to work (joined or took a call) before
the grace window expired. `derivePeriods` records the idle period with
`resolution = 'media_dismiss'`.

The 5-minute silent window before the prompt keeps its ADR-0003
treatment: payable because the session continued.

### 4. Grace resets are not events

Resetting the grace countdown on input (ADR-0008 §2) happens inside
the desktop core and emits **no** `INPUT_ACTIVITY` event. The server
does not change state on `INPUT_ACTIVITY`, and emitting one per
countdown reset would put up to one event per second into the ledger
while the prompt is visible.

## Consequences

### Positive

- Backend, ADR-0003, and ADR-0008 now agree on what a call does to a
  visible prompt.
- The ledger records exactly two bits of media information per edge:
  the event type and `in_use`.

### Negative

- A call that starts in the middle of the prompt window pays that
  window. A user could in principle start any mic-using app to dodge
  the prompt; that was already true of ADR-0003's suppression rule.
  `ON_CALL` is reported as `ACTIVE` (ADR-0003 §1), so this adds no
  new manager-visible metric.
- Malformed `MEDIA_DEVICE_STATE` events, previously accepted as
  ambient, are now rejected. No client has shipped, so nothing in
  production is affected.

## Alternatives considered

- **Separate `mic` / `cam` booleans.** Rejected — more information
  than the state machine needs, and a step toward per-device
  observation.
- **Prompt-pending interval unpaid when a call dismisses it.**
  Rejected — penalises the common case of a user returning to their
  desk to answer a Teams call.
- **Allow `USER_MARK_AWAY` from `ON_CALL`.** Deferred — not in
  ADR-0003, no requirement for it yet. Can be added by a later ADR.

## References

- ADR-0003 — Time-tracking state machine (§2, §3, §7)
- ADR-0008 — Idle prompt: input while the prompt is visible
- `docs/policy/idle-policy-defaults.md` §4
