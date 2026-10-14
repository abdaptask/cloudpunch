# ADR-0047 — Actionable insights: findings people can act on and close

- **Status:** Accepted (2026-10-14, the owner's answers below)
- **Date:** 2026-10-14
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on / replaces part of:** ADR-0040 §3 (the Overview: its
  tiles and tables become secondary to Insights), ADR-0039 (office
  days), ADR-0030 (corrections), ADR-0037 (mail from
  cloudpunch@aptask.com), ADR-0043 (Teams posts).
- **Confidence:** High on the rules and the case flow (all inputs exist
  in the day rows). Medium on wording and thresholds; they are settings.

## Context

The owner (2026-10-14): "i dont like the way overview looks… i dont
think you are showing me anything meaningful there.. reports need to be
actionable.. if i am seeing someone logging in late i can take action
from there… think like AI from an enterprise perspective… effective
for user and the admins and all personas."

The Overview shows totals and charts. It answers "how many", not "who
needs what, and what do I do about it". Nothing it shows can be acted
on, followed up or closed.

Owner's answers:

1. **Action one click away: nudge the person.** (The other actions
   stay where they are: shifts, office days, corrections.)
2. **Employees see their own insights** as personal coaching.
3. **AI writes the weekly narrative and suggests actions**, with
   **names removed** before anything is sent.
4. **Findings are tracked to a close**, with a follow-up.

## Decision

### 1. Findings (rules, nightly, from the day rows)

Each night after the day-end summary, CloudPunch looks at the last 14
days of each active person (ADR-0040 day rows) and opens a **finding**
when a pattern holds. The thresholds are company settings
(`insights.*`) with these defaults:

| Finding | When | Severity |
|---|---|---|
| Late starts | 3+ late starts in 14 days | warning |
| Missed starts | 2+ shift days without a clock-in | serious |
| Short days | 3+ finished days under 80% of the shift | warning |
| Long idle | 3+ days with an hour or more idle | warning |
| Breaks over limit | 5+ breaks over their limit | info |
| Forgets to clock out | 2+ days still clocked in at day end | info |
| Long days | 3+ days an hour or more over the shift (wellbeing) | info |

One open finding per person and kind; a new night adds evidence to it
instead of opening another. Holidays, office days and "not working"
never count (ADR-0039).

### 2. A finding is a case

- **States:** open → nudged → resolved, or dismissed (with a reason).
- **Evidence:** the days behind it, drawn as a 14-day strip (one mark
  per day: on time, late, missed, short, off), with the numbers.
- **Follow-up:** 14 days after a nudge, CloudPunch checks the same rule
  again: better → resolved automatically ("Improved: 0 late starts
  since"), not better → back to open, flagged "no change after nudge".
- **History:** every step (opened, evidence added, nudged, dismissed,
  resolved) is an append-only `insight_event` row with who and why
  (invariant 2's spirit; ADR-0038 §8 change history shows it).
- Migration 0021: `insight` (current state, one row per finding) and
  `insight_event` (append-only).

### 3. The action: nudge

- **Nudge** opens a short message drafted for the finding, editable:
  "Hi Isha, you started after 9:15 on 4 days in the last two weeks
  (Mon 5, Wed 7, …). Is anything making mornings hard? Reply to this
  email or tell your manager." Sent from cloudpunch@aptask.com to the
  person, manager copied, and shown in their app (§5).
- The finding moves to **nudged** with the follow-up date.
- Nudges are never automatic; a person acts.

### 4. Who sees what (invariant 5)

- **Administrators and HR:** Reports → **Insights**, everyone: an inbox
  by severity and team, filters (open, nudged, no change after nudge),
  each finding with its strip, numbers, history and Nudge / Dismiss.
  The old Overview stays as **Trends** below it, redesigned to compare
  with the previous period ("Late starts 18, up 6 on last fortnight")
  and broken down by team, every number clickable to the people behind
  it.
- **Managers:** the same for their direct reports, in Team →
  **Insights**.
- **Employees:** **My week** in the app (§5).

### 5. Employees: My week (personal coaching)

In the desktop app and on the web for themselves: their own last 14
days as the same strip, on-time rate, hours against the shift, idle,
and any finding about them with its wording and a way to add context
("explain these days"), before or after a nudge. A nudge appears here
as well as by email. Nothing about anyone else, ever.

### 6. AI narrative and suggestions (names removed)

- Weekly (Monday, with ADR-0037 §4's email) and on demand in Insights:
  a short narrative per team and company-wide, and a suggested next
  step on each open finding.
- **What leaves CloudPunch:** counts and patterns with **pseudonyms**
  ("P17", "Team B"), weekdays, and finding kinds. No names, emails,
  notes, idle explanations or locations. Names are put back inside
  CloudPunch before anyone reads it.
- Model: the Claude API (current Sonnet), called from the server with a
  key in `/etc/cloudpunch/api.env`; off until the key is set; a failed
  call just means no narrative that week. Cost at ~60 people: a few
  dollars a month.
- The AI never acts: it writes text a person reads.

## Consequences

- Late starts become a short list of people with evidence and a nudge
  button, not a number.
- Every finding has an owner, a state and a history, so "did we do
  anything about it?" has an answer.
- Employees see what their manager sees about them, which is fairer and
  cuts follow-up conversations.
- The privacy notice gains two lines: findings and nudges, and the
  pseudonymised AI summary (HR/legal review, with the rest).

## Alternatives considered

- **Charts only, prettier:** still nothing to act on.
- **Automatic nudges:** faster, but people should decide; can come
  later as a setting.
- **Full data to the AI:** better wording, but names and hours leave
  the company; the owner chose pseudonyms.

## Plan

1. This ADR.
2. Server: findings job, `insight` + `insight_event` (migration 0021),
   settings, endpoints (list, act, history), the nudge email.
3. Console: Reports → Insights (inbox, cards, strip, Nudge, Dismiss) and
   Trends (period comparison, by team, drill-down).
4. Team → Insights for managers; My week for employees (desktop
   release).
5. AI narrative and suggestions (needs the API key).
