# ADR-0042 — "On a break" after idle counts as a break

- **Status:** Accepted (2026-10-13, the owner chose it)
- **Date:** 2026-10-13
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Amends:** ADR-0018 §2 (explanations never change idle), for the
  break answer only. ADR-0018 stays in force for every other answer.
- **Builds on:** ADR-0023 (break types and their pay rules), ADR-0030
  (corrections: how a manager changes recorded time).
- **Confidence:** High. Nothing new is stored on the server; the day is
  built differently from an event that is already sent.

## Context

The owner (2026-10-13): "i got a popup and i chose on a break.. but it
showed as idle and did not count as break."

That popup is the "Welcome back, what were you doing?" question after
logged idle (ADR-0018 §2). By ADR-0018 every answer was only a note for
the manager, and the time stayed idle until a manager accepted it. The
manager's "Accept explanation" (ADR-0030 §4) was never built, so "On a
break" never became a break.

Asked how it should work, the owner chose: **count it as a break**.

## Decision

1. **The question asks which break.** Choosing "On a break" shows the
   break types on the menu (Bio, Meal, Tea, Personal, …, ADR-0023).
2. **The stretch becomes that break,** on the person's timeline, in day
   history, totals, Team, reports and exports: the break type's pay rule
   applies (for example paid up to its limit), and a break over its
   limit shows as one (ADR-0025). The idle explanation stays attached,
   so a manager can still see it came from an idle answer.
3. **How:** `USER_IDLE_EXPLAINED` gains an optional
   `break_kind` (the break type ids of `USER_START_BREAK`). When the
   answer is `break`, the server builds the stretch as that break.
   Older answers without a type count as **Other break**. The event
   history is unchanged (invariant 2).
4. **No manager step.** A break never adds worked time, so the person's
   answer is taken as given, as when they start a break themselves.
   A manager who disagrees uses a correction (ADR-0030).
5. **Every other answer is unchanged:** working away, a meeting or a
   phone call stay idle until a manager corrects them (ADR-0018 §2,
   ADR-0030).

## Consequences

- Breaks taken without pressing Break first are counted as breaks, not
  idle, the same day.
- A paid break type (Bio or Tea, paid up to their limits by default)
  can turn a few idle minutes into paid break minutes on the person's
  word. That is the same trust as the Break button.
- Idle totals in reports drop where people answered "On a break".

## Alternatives considered

- **Manager accepts first (ADR-0018 as written):** slower and needs the
  approval screen built; the owner preferred the break counting at once.
- **Both** (breaks at once, plus "Accept explanation" for the other
  answers): possible later.

## Plan

One change: the server builds the break (old answers included), the
event schema takes `break_kind`, and desktop 0.1.38 asks which break and
shows it on today's timeline at once.
