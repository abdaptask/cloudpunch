# ADR-0016 — Day history: what a "day" is, which clock, how far back

- **Status:** Accepted (2026-09-25, decisions set by the project owner)
- **Date:** 2026-09-25
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0003 (sessions and states), ADR-0004 (events carry
  `client_ts` with offset, `tz_iana`, and the server's `server_ts`),
  ADR-0011 (the employee's own timeline), ADR-0014 (sessions).
- **Confidence:** High. The owner stated the rules directly; the data
  to apply them is already on every event.

## Context

The desktop shows today from its local journal. Employees want to look
back at earlier days, including time recorded on another computer.
ApTask's computers are in more than one time zone (US Eastern and
India), so "which day does this belong to" and "which clock do we show"
must not depend on where the server or the viewer is. The owner's rule:
**time zones should not matter as long as people clock in and clock
out.**

## Decision

### 1. A session belongs to the day it was clocked in, in its own zone

The **shift date** of a session is the local calendar date of its
`USER_CLOCK_IN`, in the zone recorded on that event (`tz_iana` and the
offset in `client_ts`). A session is **never split at midnight**: a
22:00–03:00 shift belongs entirely to the day it started. A 09:00–17:00
shift in New York and one in Hyderabad are both on the same date,
though they are hours apart in real time.

There is no time-zone setting and no zone parameter on the API. Each
session carries its own.

### 2. Times are shown on the clock of the computer where the work happened

Segment and session times are the **local wall-clock times recorded by
the computer** (`client_ts` with its offset), which is what the employee
saw. When that zone differs from the viewer's current zone, the app
labels it (for example "09:00 EST"). Durations never depend on zones.

`server_ts` is kept for audit, ordering and clock-drift checks
(ADR-0003 §9); it is not the displayed time.

### 3. The API

- `GET /v1/me/days/{date}` (`date` = `YYYY-MM-DD`): the caller's
  sessions whose shift date is `date`. For each session it returns:
  - times (ISO 8601 with the recorded offset), the zone, the device,
    the close reason and `reconstructed`;
  - its **segments**, derived by replaying the session's events through
    the shared state machine, using the kinds the desktop already draws
    (`working`, `call_teams`/`call_zoom`/`call_other`,
    `bio_break`/`meal_break`/`other_break`,
    `away_meeting`/`away_phone`/`away_working`, `prompt`).

  It also returns the day's totals (worked, calls, meetings, breaks).
- `GET /v1/me/days?from=…&to=…`: per-day totals for up to 31 days,
  for a history strip.
- **Self only.** It needs `self.timeline.read` and returns only the
  caller's own sessions (CLAUDE.md invariant 5). Manager and HR views
  come with the web dashboard, under their own capabilities.

### 4. Look-back: 30 days

The app offers today and the previous 30 days. The API rejects dates
more than 30 days back or in the future. This is display look-back,
not data retention: the ledger keeps everything (ADR-0004 §11).

### 5. Today stays local, for now

Today's view keeps using the local journal. It is instant and works
offline. Merging in sessions from other computers for today is a
follow-up.

## Consequences

- One rule, independent of server, viewer and machine zones; a shift
  is never cut in two.
- A session's date is fixed at clock-in, so a later move to another
  zone never re-files past days.
- The day view reuses the desktop's dial and lists unchanged, because
  the server returns the same segment kinds.
- Derived segments are computed on request from the immutable ledger,
  so there is no new table and nothing to keep in sync. Materialised
  periods (derive.ts, Phase 3) can replace it if volume demands.
- A computer with a wrong clock shows wrong wall times for its
  sessions. Clock-drift detection (ADR-0003 §9) is the guard, and
  `server_ts` keeps the true order.

## Alternatives considered

- **Split days at the viewer's or the server's midnight.** Rejected:
  a US shift would straddle two India dates, and the same shift would
  land on different days for different viewers.
- **Show times in the viewer's zone.** Rejected: an employee in New
  York would see their morning as "18:30".
- **An employee-profile time zone.** Unnecessary: each event already
  records where it happened, and people who travel keep correct days.
- **Server receive time for display.** Rejected: offline events arrive
  late, so their displayed times would be wrong.
