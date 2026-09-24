# ADR-0010 — Silent-call cap: prompt after a long call with no input

- **Status:** Accepted (2026-09-24)
- **Date:** 2026-09-24
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Extends:** ADR-0003 §3 (`ON_CALL` transitions) and ADR-0009 §2.
  Neither is superseded.
- **Confidence:** High on the mechanism (§1–§3). The default (§2) and
  the payable treatment (§4) are policy calls, decided by the project
  owner on 2026-09-24; HR may revisit §4.

## Context

While the mic or camera is in use the agent is `ON_CALL`, the idle
timer does not run, and the prompt cannot appear (ADR-0003 §3,
ADR-0009). That is right for real meetings, where people often go long
stretches without touching the keyboard or mouse.

It also means the prompt never appears for as long as a capture stream
stays open, whoever or whatever holds it. Since PR E (#8) detects mic
use from Core Audio capture sessions, this includes:

- a user who walks away from a meeting without leaving it;
- a user muted in Teams, if Teams keeps the capture stream open when
  muted in-app (likely, not yet verified on our machines);
- any app that holds the mic open — voice assistants, a browser tab
  with mic access, streaming or dictation software.

In each case time accrues as payable `ON_CALL` with no bound. The only
control today is `idle.suppress_prompt_when_media_active`, which is
all-or-nothing: turning it off brings prompts back into every meeting.

## Decision

### 1. Prompt after a long silent call

While `ON_CALL`, the desktop core tracks input exactly as it does in
`ACTIVE`. If there has been no keyboard or pointer input for
`idle.max_silent_call_minutes`, measured from the later of *entering
`ON_CALL`* and *the last input*, the core shows the normal idle
prompt.

Any input during the call resets the measure, so participants in a
normal meeting who type, click, or scroll now and then are never
prompted.

### 2. Policy knob

**Setting:** `idle.max_silent_call_minutes`
**Default:** `30` (project owner, 2026-09-24: 60 was too long;
25–30 minutes preferred)
**Range:** `15`–`480`, or `null` to disable (unbounded, today's
behaviour).
**Scopes:** global / team / per-employee, as for every idle setting
(`docs/policy/idle-policy-defaults.md`).

### 3. Event and transitions

The prompt is opened with the existing `INPUT_IDLE_5M` event, carrying
a new optional payload field:

```json
{ "trigger": "silent_call" }
```

`trigger` is `"input_idle"` (the default when absent — today's
prompt) or `"silent_call"`. A new schema
`schemas/input-idle-5m.schema.json` defines it
(`additionalProperties: false`).

Amended transitions (backend `nextState`, desktop mirror, shared
fixture):

```
ON_CALL
  ├─ INPUT_IDLE_5M                        → IDLE_PENDING    [show prompt; silent-call cap reached]   ← new
IDLE_PENDING (entered from ON_CALL)
  ├─ USER_PROMPT_RESPONSE (still_working) → ACTIVE          [core sees the mic still on and records
  │                                                          MEDIA_DEVICE_STATE {in_use:true} → ON_CALL;
  │                                                          cap measure restarts]
  ├─ other responses / PROMPT_TIMEOUT_30S → as ADR-0003 / ADR-0008
```

The mic is still in use while this prompt is showing. That does
**not** dismiss it: ADR-0009 dismisses the prompt on a
`MEDIA_DEVICE_STATE (in_use=true)` edge, and there is no new edge
while the same call continues. Input still resets the grace countdown
(ADR-0008 §2).

The server does not check the cap's timing, just as it doesn't check
the 5-minute idle threshold. The timing is the client's; the server
only enforces legal transitions.

### 4. Payable treatment

| Interval | Treatment |
|---|---|
| The silent call, up to the prompt | **Payable** as `ON_CALL` — unchanged. |
| Prompt shown → answer | Classified by the answer (ADR-0008 §3). |
| Prompt shown → timeout | Not payable; `closed_at` = prompt shown (ADR-0003 §4.5, unchanged). |

**Decided (project owner, 2026-09-24):** on a timeout the silent call
itself stays **payable**; the timeout only ends the session. The
stricter alternative — unpaying the silent call up to
`max_silent_call_minutes`, mirroring ADR-0003's rule for the 5-minute
window before an unanswered prompt — was rejected because:

- it keeps `closed_at = prompt shown`, like every other timeout;
  retroactively unpaying up to 8 hours on a 30-second miss would be
  severe;
- a genuine long listen-only meeting ending in a missed prompt is more
  likely than fraud, and managers still see the auto clock-out during
  timesheet review.

If HR later prefers the stricter rule, a superseding ADR changes §4
and `derive.ts` gains a `silent_call` idle period; the mechanism in
§1–§3 stays the same.

## Consequences

### Positive

- Walk-away, left-open, and mic-holding-app cases are bounded at
  `max_silent_call_minutes` + grace instead of unbounded.
- Normal meetings are unaffected as long as there is occasional input.
- Suppression stays on for everyone, so prompts don't interrupt
  active calls.

### Negative

- Someone in a long listen-only meeting with no input at all (a
  training, an all-hands) gets one prompt every 30 minutes by default
  and must click "I'm still working". The prompt is always-on-top and
  may appear over a shared screen.
- `INPUT_IDLE_5M` now also means "silent call cap reached"; the name is
  historical (event types are never renamed — event-schema README).

## Alternatives considered

- **New event type (`SILENT_CALL_CAP`).** Cleaner name, but it adds a
  second prompt-opening event that `derive.ts`, the fixture, and every
  report must treat the same as `INPUT_IDLE_5M`. Rejected in favour of
  a payload field.
- **Cap on call duration regardless of input.** Rejected — prompts
  active participants in long meetings for no reason.
- **Turn off suppression (`suppress_prompt_when_media_active: false`).**
  Already possible per policy; rejected as the default because it
  prompts during every quiet stretch of every meeting.
- **Ignore apps other than Teams / known meeting apps.** Rejected —
  requires identifying the process holding the mic, which invariant 1
  forbids.

## Required follow-up changes

1. `docs/policy/idle-policy-defaults.md` §4: add
   `idle.max_silent_call_minutes`; `packages/policy-schema`: add the
   field.
2. `packages/event-schema/schemas/input-idle-5m.schema.json` (new).
3. Backend `state-machine.ts`: `INPUT_IDLE_5M` valid from `ON_CALL`;
   fixture regenerated.
4. Desktop `machine`: silent-call measure in `OnCall` tick, mirror
   updated, tests.
5. `docs/architecture/state-machine.md`: new scenario.

## References

- ADR-0003 — Time-tracking state machine (§3, §4.5, §6)
- ADR-0008 — Idle prompt: input while the prompt is visible
- ADR-0009 — `ON_CALL` state, media events, and call-dismissed prompts
- PR #8 — mic detection via Core Audio capture sessions
