# ADR-0051 — The habits inspector: 30 days of clock-in and clock-out patterns

- **Status:** Accepted (2026-10-15, owner decision)
- **Deciders:** Abdulla Sheikh (owner)
- **Relates to:** ADR-0016 (working days), ADR-0018 §4 (start from sign-in),
  ADR-0040 (reports, `report_sent`), ADR-0047 (insights), ADR-0050
  (locked after the shift)
- **Confidence:** High for the analysis (it reuses the day rows every
  report already builds); medium for the thresholds, which are first
  guesses to tune after the first weekly email.

## Context

The owner asked for an "inspector agent constantly running" that watches
how people log in and out for 30 days and reports back. Two constraints
shape the answer:

- **No running cost** (owner, 2026-10-14). A Claude agent on a schedule
  bills per run and can't reach the database on the internal VM.
- **Data stays in CloudPunch.** The time records already hold everything
  needed: first clock-in, last clock-out, shift, lateness, sessions,
  start from sign-in, and how a session ended (idle cap, ADR-0050's
  locked-after-shift clock-out).

ADR-0047's insights find problems over a rolling 14 days, one rule at a
time. This is different: a fixed window, a description of each person's
usual hours, and how the whole company changes week to week.

## Decision

### 1. A job inside CloudPunch, not an AI agent

A server job, rule-based and free, like the day-end email (ADR-0040 §2).
Nothing leaves CloudPunch except the email to Administrators.

### 2. What it works out

**Window:** 2026-10-15 to 2026-11-13 (30 days, `HABITS_FROM` /
`HABITS_TO` in `apps/backend/src/habits/load.ts`). Per person, from the
same day rows as Reports (`rangeRows`), in their own most common time
zone:

- **Usual start and finish:** the median clock-in and clock-out, with
  the middle half of their days as the range. A clock-out CloudPunch made
  (idle cap, locked after the shift) or a day left clocked in isn't
  counted as their finish.
- **Weekday differences:** median start per weekday.
- **Late** against the shift (count, usual minutes, on-time share),
  **missed clock-ins**, **leaving before the shift end** (15+ min).
- **Leaving clocked in** (still in, or closed by the idle cap) and
  **locking up without clocking out** (ADR-0050).
- **Split days** (more than one session), **long days** (an hour over
  the shift, or 10 h without one), **starting from the computer's
  sign-in** (ADR-0018 §4).

A plain-English **label** sums it up: "Steady 09:05–18:00" when starts
and finishes fall within 30 minutes and nothing else stands out; else
the most important habit ("Often late", "Starts later on Mondays",
"Left clocked in on 3 days", "Irregular start times"). Fewer than 3
days worked: "Not enough days yet".

**Thresholds:** missed 2+; late 3+ and 30%+ of shift days; a weekday
30+ minutes later than usual (only when starts are otherwise steady);
left clocked in 2+; locked out 2+; early 3+; split 3+ and 30%+; long 3+;
irregular when the middle half spans more than 90 minutes.

**Company:** people tracked, on-time share, usual start and finish,
clock-ins and clock-outs by hour, week by week (on time, start, finish,
late, left clocked in), and **who changed**: anyone whose median start
or finish in their latest 7 days moved 30+ minutes against their first
7.

### 3. How it reports

- **Weekly email** to Administrators every Monday from 08:30 India time
  during the window: "Habits so far (week N of ~4)".
- **Final email** on 2026-11-14 from 08:30: "30-day habits report". Then
  it stops.
- Each email is claimed in `report_sent` (report `habits`, the date it
  goes) in the same transaction as the send, so it goes once even with
  retries, restarts or two servers (invariant 4). Migration 0022 widens
  the allowed report kinds.
- **Live page:** Console → Reports → **Habits**
  (`GET /v1/reports/habits`, HR and Administrators like Trends; each view
  audited as `habits_report_viewed`). The email's button opens it
  (`?section=reports&tab=habits`).

### 4. Privacy

Only times CloudPunch already records (invariant 1). Same scope as
Trends: HR and Administrators see everyone; Managers and Employees don't
see this report. Covered by the privacy notice's "Who can see your data"
and patterns sections (ADR-0047); no new data is collected or kept.

## Consequences

- The owner gets a weekly picture and a final report without anyone
  running queries, at no cost.
- The thresholds are guesses; the first weekly email shows whether they
  flag the right people. They are constants in `habits/model.ts`.
- After 2026-11-14 the job does nothing. Running it again means new
  dates in `load.ts` (a code change), on purpose: a monitoring window
  shouldn't extend itself silently.
- The page and email compute from the time records on every request; at
  ~60 people that is a few seconds.

## Alternatives considered

- **A scheduled Claude agent:** billed per run and can't reach the
  internal database without opening it up. Rejected (cost, exposure).
- **Store a nightly snapshot:** not needed. The records are
  append-only, so the window can be recomputed exactly at any time.
- **Fold it into Insights:** insights are per-problem cases with nudges;
  this is a description of habits over a fixed window. Kept separate.
