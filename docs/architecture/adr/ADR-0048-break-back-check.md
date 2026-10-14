# ADR-0048 — "Back from your break?": breaks are checked like Away

- **Status:** Accepted (2026-10-15, the owner chose "ask, then end it")
- **Date:** 2026-10-15
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Extends:** ADR-0027 §1 ("Welcome back?" while Away) to breaks, and
  ADR-0031 §3 (the loud "Your break is over" alert) to every break with
  a limit, planned or not.
- **Builds on:** ADR-0023 (break types and their limits), ADR-0042
  ("On a break" after idle).
- **Confidence:** High. It reuses the Away check's input timing as is;
  the only new data is `ended_by` on `USER_END_BREAK` (timing metadata,
  invariant 1).

## Context

On 14 Oct Eela answered the idle question with "Bio break" at 10:13 and
stayed on that break for almost seven hours while she worked. Nothing
asked her whether she was back:

- A break started from the idle question has no planned length, and the
  loud alert (window forward, taskbar flash, repeated every 2 minutes,
  ADR-0031 §3) only fired for a planned break.
- An unplanned break got one quiet notification at its type's limit
  ("Still on your break?", 10 min for bio). Missed once, nothing more.
- Using the computer during a break did nothing. Away has asked
  "Welcome back?" since ADR-0027; breaks never did.

The owner: "this is NOT GOOD AT ALL".

## Decision

### 1. "Back from your break?"

Exactly ADR-0027 §1's check, on a break:

- About a minute of steady keyboard or mouse use (no 30 s gap for 60 s)
  while on a break opens **"Back from your break?"**: "{Break} since
  {time}. You've been using the computer since {time}. If you keep
  working, CloudPunch ends your break from then in {n}s." Buttons:
  **I'm back** / **Still on break**. The window comes forward.
- **I'm back** ends the break from when the use began (as Away does: the
  person was working from then).
- **Still on break** keeps it and asks again only after another 10
  minutes of use (Away waits 30: a break is shorter).
- **Unanswered** while use continues for 2 more minutes: the break ends
  from when the use began, recorded as `USER_END_BREAK` with
  `ended_by: "input"`. Team shows "Ended on its own: back at the
  computer".
- A pause in use closes the question quietly; the break goes on.
- A call starting during a break does not end it (unlike Away): calls
  are tracked apart, and a break can include a personal call.

### 2. The loud alert for every break with a limit

The "Your break is over" alert now fires at the planned end if there is
one, else at the break type's limit (HR's `max_minutes`): "Breaks like
this one are up to 10 min. Back now, or a few more minutes?". It repeats
every 2 minutes and is not muted in quiet hours, as before. A break with
no limit gets none. The single quiet "Still on your break?" notification
is dropped when the loud alert covers it. "5 / 10 more min" on an
unplanned break extends from the limit.

## Consequences

- A forgotten break ends within about 3 minutes of the person working
  again, instead of running all day, and the record says how it ended.
- Someone reading or watching something on a break gets asked once, then
  every 10 minutes of use; "Still on break" keeps it.
- Older app versions behave as before until they update.
- Wrong endings are fixed with a correction (ADR-0030), as for Away.

## Alternatives considered

- **Ask only, never end:** keeps the person in control, but an ignored
  question leaves Eela's day as it was. Rejected by the owner.
- **End it silently:** no question, but a break that includes reading
  something on the computer would be cut short without a say.
- **Only make the limit alert loud:** helps when someone sees it, but
  doesn't use the strongest signal that they're back: they're working.
