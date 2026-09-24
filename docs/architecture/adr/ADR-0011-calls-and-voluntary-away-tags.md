# ADR-0011 — Calls on the employee's own screen, and voluntary away tags

- **Status:** Accepted (2026-09-24); §1 "employee only" superseded by
  ADR-0012 (managers and reports see the call type); §2 "On a phone call"
  tag removed by ADR-0012 §6
- **Date:** 2026-09-24
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Extends:** ADR-0003 §1 (the `ON_CALL` reporting note) and §3
  (`USER_MARK_AWAY`). Neither is superseded.
- **Confidence:** High on §1 and §3; §4 is a policy call by the project
  owner with a known risk.

## Context

ADR-0003 §1 says `ON_CALL` time is represented **as `ACTIVE`** in
reports and manager views, so the mic/camera boolean never becomes a
separate "hours on call" metric. The desktop home window followed the
same rule and showed calls as "Clocked in" / Working.

In use, the project owner found that confusing: on a live Teams call
the app gave no sign it knew about the call, although it was
correctly suppressing the idle prompt (ADR-0009, PR #8).

The owner also wants employees to be able to say they are in a
meeting. Calls on the computer are detected automatically; in-person
meetings and calls on a personal phone are not visible to the agent at
all.

## Decision

### 1. Calls are visible to the employee, and only to the employee

The desktop home window, timeline, and totals show `ON_CALL` as its own
**"On a call"** segment (status "On a call"). This is the employee's
own device, showing the employee's own time.

Unchanged: reports, manager views, and the timesheet still represent
`ON_CALL` as `ACTIVE` (ADR-0003 §1). No new data leaves the device —
`MEDIA_DEVICE_STATE` was already recorded (ADR-0009) — and no
manager-facing surface gains a call metric.

### 2. Voluntary away tags

The home window and tray offer two tags next to the breaks, available
while `ACTIVE`:

| Tag | Event | State | Payable (default) | Note |
|---|---|---|---|---|
| **In a meeting** | `USER_MARK_AWAY {away_reason: "meeting"}` | `AWAY (meeting)` | Yes (`away.payable_reasons`) | optional |
| **On a phone call** | `USER_MARK_AWAY {away_reason: "phone_call"}` | `AWAY (phone_call)` | Yes | optional |

"I'm back" (`USER_MARK_BACK`) returns to `ACTIVE`, as today. Note rules
follow `away.require_note` (`meeting: false`, `phone_call: false`).

`USER_MARK_AWAY` gets its first payload schema,
`schemas/user-mark-away.schema.json`:
`{ away_reason: "working_away" | "phone_call" | "meeting" | "other", note?: string ≤ 500 }`.
The backend requires a valid `away_reason`; the transition stays legal
from `ACTIVE` only. From `ON_CALL` it stays rejected (ADR-0009 §2): a
call on the computer is already tracked.

### 3. No automatic meeting detection

In-person meetings are not detected. The only automatic source would
be the employee's calendar via Microsoft Graph, which is a new data
source close to the no-content-capture invariant (even free/busy
reveals schedule patterns). It is out of scope; adding it needs its own
ADR, a privacy review, and a change to the employee privacy notice.

### 4. No check-in cap for voluntary away

While tagged away, the idle prompt does not run, and there is **no**
check-in prompt after a period without input. Decided by the project
owner (2026-09-24): voluntary tags are trusted, and managers review
away time and notes during timesheet approval.

## Consequences

### Positive

- Employees see that the agent recognised their call, which explains
  why no idle prompt appears.
- Meetings and personal-phone calls can be recorded honestly instead
  of via the idle prompt or a break.

### Negative

- §4 leaves voluntary away time unbounded: someone can tag "In a
  meeting" and leave for the afternoon, and it counts as payable until
  a manager adjusts it. The silent-call cap (ADR-0010) does not cover
  this. A later ADR can add a cap if review finds abuse.
- The employee's screen and the manager's view now label the same
  interval differently ("On a call" vs "Active"). Accepted: the
  difference is deliberate and documented here.

## Alternatives considered

- **Keep calls as Working on the employee's screen (ADR-0003 §1
  literally).** Rejected — confusing in practice, and hiding the call
  from the person on it protects no one.
- **Detect meetings from the calendar.** Deferred (§3).
- **Check-in prompt after 30–90 minutes away.** Offered; rejected by
  the project owner (§4).

## Implementation

- §1: PR on `phase-2b/ui-timeline` (Timeline UI) — `timeline.rs`
  `SegmentKind::OnCall`, frontend `on_call` kind, status label.
- §2: follow-up PR — schema, backend guard + fixture, desktop core
  `MarkAway`, home and tray actions, timeline kinds for meeting.

## References

- ADR-0003 — Time-tracking state machine (§1, §3, §6)
- ADR-0009 — `ON_CALL` state and media events
- ADR-0010 — Silent-call cap
- `docs/policy/idle-policy-defaults.md` §8 (away reasons)
