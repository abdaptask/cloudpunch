# ADR-0008 — Idle prompt: input while the prompt is visible

- **Status:** Accepted (2026-09-24)
- **Date:** 2026-09-24
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Amends:** ADR-0003 §3 (`IDLE_PENDING` transitions). ADR-0003
  otherwise stands, including §4 invariant 5.
- **Confidence:** High that the ADR-0003 rule is unworkable as
  written; medium on the payable classification of the
  prompt-pending interval (§3 below) — that is a policy call the
  project owner should confirm, and HR may want to weigh in.

## Context

ADR-0003 §3 defines, for `IDLE_PENDING`:

```
IDLE_PENDING
  ├─ USER_PROMPT_RESPONSE (...)   → ACTIVE / ON_BREAK / AWAY / CLOCKING_OUT
  ├─ INPUT_ACTIVITY               → ACTIVE   [dismiss prompt, re-arm 5-min timer]
  ├─ PROMPT_TIMEOUT_30S           → CLOCKING_OUT
```

The prompt is answered by clicking or keyboard-selecting an option.
Both of those are keyboard/pointer input, which the idle watcher
(`GetLastInputInfo` on Windows) reports as activity. Under the rule
above, the mouse movement toward "Bio break" dismisses the prompt as
`ACTIVE` before the click lands. The break, away, and end-shift
options would be effectively unreachable, and every prompt would
silently resolve to "still working".

The agent cannot tell "input aimed at the prompt" apart from "input
in another app" without inspecting which window has focus or where
the pointer is — the kind of per-app observation the no-content-capture
invariant forbids. So the fix has to be in the state machine, not in
input filtering.

The backend already implements the ADR-0003 rule
(`apps/backend/src/events/state-machine.ts`, `INPUT_ACTIVITY` from
`IDLE_PENDING` → `ACTIVE`), so this is caught before any client ships
against it, but not before code exists.

## Decision

### 1. Input no longer dismisses a visible prompt

Once the prompt has been shown, only an explicit
`USER_PROMPT_RESPONSE`, a `MEDIA_DEVICE_STATE (in_use=true)`, or the
grace timeout leaves `IDLE_PENDING`. `INPUT_ACTIVITY` keeps the
state in `IDLE_PENDING`.

### 2. Input resets the grace countdown

`INPUT_ACTIVITY` while in `IDLE_PENDING` resets the grace countdown
to the full `idle.grace_seconds` (default 30 s). It does not stop it.
If the user touches the mouse and then walks away without answering,
the countdown runs out as usual and `PROMPT_TIMEOUT_30S` fires. This
bounds how long a prompt can sit unanswered: `grace_seconds` after
the last input.

The countdown is owned by the Rust core, not the webview, so it
fires even if the UI is hung. The UI's countdown display is
cosmetic.

Amended transition table:

```
IDLE_PENDING
  ├─ USER_PROMPT_RESPONSE (still_working) → ACTIVE          [re-arm 5-min timer]
  ├─ USER_PROMPT_RESPONSE (bio_break)     → ON_BREAK        [kind=bio]
  ├─ USER_PROMPT_RESPONSE (meal_break)    → ON_BREAK        [kind=meal]
  ├─ USER_PROMPT_RESPONSE (on_phone_call) → AWAY            [reason=phone_call, note optional]
  ├─ USER_PROMPT_RESPONSE (working_away)  → AWAY            [reason=working_away, note required]
  ├─ USER_PROMPT_RESPONSE (end_shift)     → CLOCKING_OUT
  ├─ INPUT_ACTIVITY                       → IDLE_PENDING    [prompt stays; reset grace countdown]   ← changed
  ├─ MEDIA_DEVICE_STATE (in_use=true)     → ON_CALL         [dismiss prompt]
  ├─ PROMPT_TIMEOUT_30S                   → CLOCKING_OUT    [reason=idle_auto_clock_out; unchanged from ADR-0003]
```

### 3. Payable classification of the prompt-pending interval

The interval from prompt shown to `USER_PROMPT_RESPONSE` takes the
classification of the response:

| Response | Prompt-pending interval is… |
|---|---|
| `still_working` | payable (as `ACTIVE`) |
| `bio_break` / `meal_break` | break time of that kind (payable per `break.*` policy) |
| `on_phone_call` / `working_away` | away time (payable per `away.payable_reasons`) |
| `end_shift` | not payable; `closed_at` = prompt shown |
| *(timeout)* | not payable; `closed_at` = prompt shown (ADR-0003 §4.5, unchanged) |

This keeps the ADR-0003 worked example's outcome (Alice's 20 s at
11:10 is payable) — she now gets there by clicking "I'm still
working" instead of by moving the mouse.

The 5-minute silent window *before* the prompt is unchanged from
ADR-0003: payable if the session continues, not payable on timeout.

### 4. Before the prompt appears — unchanged

`INPUT_ACTIVITY` in `ACTIVE` still resets the 5-minute timer. Nothing
about pre-prompt behaviour changes.

## Consequences

### Positive

- Every prompt option is reachable with a mouse or keyboard.
- The recorded response reflects a deliberate choice, which makes the
  timesheet more defensible than an inferred "still working".
- Walk-away after an accidental mouse bump still ends in
  auto-clock-out within `grace_seconds`.

### Negative

- A user who is actively working in another window while ignoring
  the prompt will keep resetting the countdown indefinitely without
  answering. Their time is not lost (it classifies on the eventual
  answer), but the prompt stays up. Mitigation: the prompt window is
  always-on-top and takes focus once when shown.
- One more click for people who were genuinely working. Accepted —
  that click is the point.

### Required follow-up changes

1. **Backend** `apps/backend/src/events/state-machine.ts`:
   `INPUT_ACTIVITY` from `IDLE_PENDING` returns `IDLE_PENDING`, and
   the matching test in `state-machine.test.ts` flips. Separate PR.
2. **ADR-0003** status header: add "§3 `IDLE_PENDING` transitions
   amended by ADR-0008". Content is not edited.
3. **`docs/architecture/state-machine.md`** worked example row 8:
   "Alice moves mouse, clicks *I'm still working*" instead of "moves
   mouse — prompt dismissed automatically"; payable table note
   updated to "classified by response".
4. **Desktop** (slice 2b.7.2b): Rust core owns the grace timer and
   resets it on `IdleEnded`/input while a prompt is pending.

Items 2 and 3 land with this ADR once accepted. Items 1 and 4 land
with their slices.

## Alternatives considered

### B — Input dismisses the prompt as "still working" (ADR-0003 as written)

Simplest. **Rejected** — makes breaks and away reachable only from
the home screen/tray, never from the prompt, which defeats the
prompt's six-option design in `idle.prompt_options`.

### Input stops (rather than resets) the countdown

**Rejected** — a mouse bump followed by walking away would leave the
prompt, and the session, open indefinitely with no auto-clock-out.

### Ignore input only when it's aimed at the prompt window

Would need focus/pointer-location observation. **Rejected** — per-app
and per-window observation is outside the OS-state-metadata boundary
of the no-content-capture invariant, and it's fragile besides.

## References

- ADR-0003 — Time-tracking state machine
- `docs/policy/idle-policy-defaults.md` §1, §2, §5
- `docs/architecture/state-machine.md` — worked example
