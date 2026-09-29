# ADR-0027 — Checking in on Away: back at the computer, calls, long aways

- **Status:** Accepted (2026-09-29, the owner approved the recommendation)
- **Date:** 2026-09-29
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0011 (voluntary Away tags), ADR-0009 and ADR-0012
  (calls), ADR-0013 (reminders), ADR-0023 (Training), ADR-0025
  (Exceptions).
- **Confidence:** High for the rules, which reuse input timing and the
  mic-in-use signal the app already has. Medium for the thresholds,
  which will be tuned on pilot data.

## Context

On 2026-09-29, Roshni answered the idle prompt with "On a phone call"
at 21:35 IST and showed as "On a phone call" until 23:41, 2 h 6 min,
although the call had long ended. Her log showed why:
- **Away has no end signal.** A phone call off the computer can't be
  detected, so Away lasts until "I'm back".
- **While Away, CloudPunch ignored both typing and a Teams/Zoom call
  starting.** A call was only remembered, and applied after "I'm back"
  (ADR-0009's edge handling).

The owner asked for a check-in popup.

## Decision

Applies to every Away reason: phone call, working away, in a meeting,
training.

### 1. Back at the computer

- **When it asks:** while Away, **about a minute of keyboard or mouse
  use**, meaning input with no gap of 30 s or more for 60 s, opens
  **"Welcome back. Still on your phone call?"** (the reason's own
  words). The main window comes forward.
- **I'm back:** Away ends **from when the typing started**.
- **Still on the call:** Away continues, and it asks again after another
  30 minutes of typing.
- **No answer within 2 minutes while typing continues:** Away ends by
  itself, from when the typing started (owner decision). The person is
  clearly at the computer.
- **Typing stops before the deadline:** the question is dropped quietly,
  and asked again next time.

### 2. A call starts while Away

- **When Teams, Zoom or another call takes the microphone while Away,**
  Away ends and the person shows as **on a call**. The call is tracked
  as usual. That's more accurate than "phone call": they're on the
  computer.

### 3. A long Away

- **After `away.check_after_minutes`** (default 60, range 15–240) with no
  activity, a notification asks **"Still on your phone call?"**, and
  again every 30 minutes (quiet hours respected).
- **Nothing changes if they don't answer:** a long real call is fine.

### 4. Records and visibility

- **How it's recorded:** an automatic end is a `USER_MARK_BACK` with
  `ended_by`:
  - `input`: back at the computer;
  - `call`: a call started.

  A person's own "I'm back" carries no `ended_by`. No new data category:
  input timing and mic-in-use only (invariant 1).
- **The day view:** the Away segment shows how it ended ("ended: back at
  the computer").
- **Team → Exceptions** lists every Away of `check_after_minutes` or
  longer (`long_away`), with the reason and how it ended.

## Consequences

- **Positive:**
  - Stale "phone call" statuses end on their own, as soon as the person
    is back.
  - Managers see long aways.
  - A call picked up on the computer is tracked as a call.
- **Negative:**
  - Someone who types during a real off-computer call gets asked. That's
    a click every 30 minutes at most.
  - The thresholds (60 s of typing, 2 min to answer) are starting
    points.

## Alternatives considered

- **Keep asking, never end Away by itself.** Rejected by the owner: the
  status stays wrong until someone answers.
- **Time limit only** (end Away after N minutes). Rejected: it would cut
  real long calls short, and it doesn't use the "back at the computer"
  signal.
- **End Away on the first keystroke.** Rejected: one bump of the mouse
  is not being back.
