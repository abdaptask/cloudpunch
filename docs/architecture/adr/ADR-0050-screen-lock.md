# ADR-0050 — Locking the screen: stepping away during the shift, the end of the day after it

- **Status:** Accepted (2026-10-15, the owner approved both rules, with
  5 minutes after the shift)
- **Date:** 2026-10-15
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Decides:** ADR-0003 §1's deferred `LOCKED` / `SLEEPING` states: a
  lock is **idle**, not a state of its own.
- **Builds on:** ADR-0018 (idle logging, the idle cap, "What were you
  doing?"), ADR-0031 (shifts), ADR-0042 ("On a break" after idle counts
  as that break), ADR-0048 (break back-check).
- **Confidence:** High for the rules. Medium on platform timing: Windows
  reports lock, unlock, sleep and wake as they happen; macOS's poller
  notices a sleep only on waking, so the lock and the sleep are reported
  together then.

## Context

The desktop app has watched for the screen locking since slice 2b.7 but
did nothing with it. A lock was only "no keyboard or mouse":

- **During the shift**, the idle question appeared after 2 minutes,
  behind the lock screen where nobody saw it, and idle was logged from
  the last input. A deliberate lock (Win+L, closing the lid) waited two
  minutes to be noticed.
- **After the shift**, a person who locked up and went home stayed
  clocked in until the 2-hour idle cap closed the session, every day: a
  2-hour idle tail, and the "didn't clock out" insight (ADR-0047)
  counting it.

No time was ever paid wrongly (idle never counts as worked), but the
records were noisy and the person learned nothing.

## Decision

### 1. A lock during the shift is stepping away, at once

When the screen locks (or the computer goes to sleep) while the person
is **working** (`ACTIVE`, or with the idle question up):

- idle starts **at the lock**, with no 2-minute wait and no idle prompt
  (nobody could see it). On the wire it is the usual
  `INPUT_IDLE_5M` + `IDLE_STARTED`, both at the lock time; with the
  question already up, idle runs from the last input as before;
- input on the lock screen doesn't end it; **unlocking** does, and asks
  the usual "What were you doing?" (ADR-0018 §2) with the same answers:
  "On a break" still makes that stretch the break (ADR-0042);
- **on a call, on a break or Away**, a lock changes nothing (a laptop
  locked during a Teams call or a meeting is still working; a break is
  already a break, ADR-0048 checks it);
- the **idle cap** (2 hours by default) still closes the session as the
  fallback.

### 2. A lock after the shift is the end of the day

If the screen stays locked (or the computer asleep) **5 minutes past the
later of the lock and the shift's end**, CloudPunch clocks the person
out, **dated at the lock**:

- locked at 18:10 after an 18:00 shift: clocked out at 18:10, decided at
  18:15 if still locked; unlocked at 18:12: nothing happens;
- locked at 14:00 and never back: clocked out at 14:00, decided at 18:05
  (unless the idle cap closed it first, at 16:00);
- asleep past it (no ticks run): decided on waking, still dated at the
  sleep;
- **on a call or Away** the day doesn't end; if a call ends while still
  locked, idle starts then and the day ends there;
- **which shift:** the one whose day spans the lock, from 4 hours before
  its start to 12 hours after its end (overnight shifts belong to the
  night they start, ADR-0031). **No shift** that day, or none at all:
  only rule 1 and the idle cap apply.

It's `USER_CLOCK_OUT` with `reason: "locked_after_shift"` (the session
closes as `user_clock_out`; no migration). The day view and Team
exceptions read the reason: "Clocked out automatically at 6:10 pm:
computer locked after the shift". The person sees, on the app:

> We clocked you out at 6:10 pm when you locked your computer after your
> shift. Still working? **Ask to correct today**

which opens the same-day correction (ADR-0030, desktop 0.1.45).

### 3. What is recorded

Only the timing of a lock, unlock, sleep or wake, and the reason on the
clock-out (invariant 1: no content). Lock events themselves aren't sent;
they shape the idle and clock-out events above.

## Consequences

- A lock is noticed at once, the idle question waits for the person to
  come back, and nobody accrues a 2-hour idle tail after going home.
- Someone who locks after the shift and keeps working elsewhere (a phone
  call, say) is clocked out; they see why and can ask to correct it the
  same day. On a call on the computer they aren't.
- The "didn't clock out" insight (ADR-0047) fires less, for the right
  reason.
- macOS reports a sleep only on waking: a Mac that slept through the
  shift's end is clocked out on waking, dated at the sleep.

## Alternatives considered

- **`LOCKED` as a state of its own** (ADR-0003 §1): the server state
  machine, reports and corrections would all need a new state for what
  is, to payroll, idle.
- **Clock out at the shift's end, not the lock:** pays nothing more
  (idle isn't paid) but leaves a misleading idle stretch.
- **End the day only at the idle cap** (as before): the noise this ADR
  removes.
- **A longer wait (15 minutes):** the owner chose 5.
