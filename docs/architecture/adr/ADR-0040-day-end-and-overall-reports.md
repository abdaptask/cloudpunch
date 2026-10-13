# ADR-0040 — Day-end summary and overall report

- **Status:** Proposed
- **Date:** 2026-10-13
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0025 (team views, who sees whom), ADR-0031 (shifts),
  ADR-0037 (shift-start emails, the Monday email, mail from
  cloudpunch@aptask.com), ADR-0038 (admin console), ADR-0039 (office
  days).
- **Confidence:** High on the data (everything comes from days the
  server already builds for Team). Medium on two choices for the owner:
  when the day-end email goes, and who else sees the overall report
  (see Open).

## Context

The owner asked (2026-10-12) for "a day-end summary report for everyone
that's logged in, and an overall report that shows me some meaningful
data". Their answers (2026-10-13):

- **Day-end summary:** each **manager gets their own team's day by
  email**; **Administrators get everyone**. Also viewable in the admin
  console.
- **Overall report:** all four areas: **hours and attendance**,
  **lateness and missed starts**, **idle, breaks and away**, and
  **adoption and health** (who uses CloudPunch, versions, computers
  behind, corrections waiting).

Today the data is there but scattered: Team shows one day at a time per
person, exceptions are per range, and the Monday email lists only
regular late starters.

## Decision

### 1. One day, per person (the building block)

For a person and a date (their shift date, in their shift zone), the
server already builds the working day. The report row adds what the
shift says:

- **Status:** Worked · Late · Not clocked in · Not working today ·
  Holiday · In office (ADR-0039).
- **Start:** first clock-in, and minutes late against the shift start.
- **End:** last clock-out (or "still clocked in").
- **Hours worked** (work, calls and Away-working count), against the
  shift length.
- **Idle**, **breaks** (with any over their limit), **away**.
- **Corrections** waiting for that day.

One function builds these rows for a list of people and dates; the
email, the console page and the overall report all use it.

### 2. Day-end summary

- **Who gets what:** each manager, their direct reports; each
  Administrator, everyone. Someone who is both gets one email (the
  Administrator one). The server checks the roles as for Team
  (invariants 5, 6); people with no manager appear only in the
  Administrators' email.
- **What:** a header ("Monday 13 Oct · 12 worked · 2 late · 1 not
  clocked in · 1 in office"), then one line per person sorted with
  problems first, then a link to the console for detail. Plain,
  readable on a phone. No idle explanations or connection locations
  in email (they stay in the app).
- **When:** once a day for the day before, at a time set in **Rules →
  Reports** (company-wide), default **08:00 India time**: by then the
  India day, the India–US split shift and the US Eastern day have all
  ended. Off until switched on, like the shift-start emails.
- **Once only:** a `report_sent` row per (report, day, recipient)
  claimed before sending, as `weekly_report_sent` does (invariant 4).
  Migration 0016, append-only.
- **Console:** **Reports → Day summary** shows the same for any date,
  with the person's day a click away. Managers see their team; HR and
  Administrators everyone.

### 3. Overall report

**Admin console → Reports → Overview**, for a range (this week, last
week, this month, last month, or any dates up to 3 months):

1. **Hours and attendance:** per person and in total: days worked,
   hours, scheduled hours, attendance (days worked ÷ shift days, not
   counting holidays, office days or "not working").
2. **Lateness and missed starts:** per person: late starts, average
   minutes late, missed starts; a week-by-week trend for everyone.
3. **Idle, breaks and away:** per person: idle hours and share of the
   day, break minutes per day, breaks over their limit, away hours.
4. **Adoption and health:** people with the Employee role vs people
   who clocked in at least once; computers by app version and how many
   are behind; corrections waiting; uploads the server refused (such
   as a computer with a wrong clock).

Each table sorts and filters like the other console tables (ADR-0038
§9) and downloads as CSV. Charts are simple bars and lines, readable in
light and dark.

**Weekly email:** the Monday email to Administrators (ADR-0037 §4)
gains the headline numbers for last week and a link to the overview.

### 4. Endpoints

- `GET /v1/reports/day?date=`: the day rows for the caller's scope.
- `GET /v1/reports/overview?from&to`: the four sections (Administrators
  and HR).
- `GET /v1/reports/overview.csv?from&to&section=`.

Each read is audited like opening someone's day (ADR-0025 §4), once per
request, not per person.

### 5. Privacy (invariant 1)

Nothing new is collected. Reports summarise what Team already shows to
the same people. Emails carry totals and statuses only, go to aptask.com
addresses from cloudpunch@aptask.com, and never include idle
explanations, notes or connection locations.

## Consequences

- Managers get their team's day without opening the app; the owner gets
  trends instead of single days.
- Building 3 months for ~60 people is about 5,000 person-days; the
  server builds days quickly, so this is done on request without a
  separate store. If it gets slow, a nightly summary table can come
  later.
- Wrong clocks and refused uploads become visible in the overview
  instead of only in server logs.

## Alternatives considered

- **A separate analytics store or BI tool:** more moving parts for 60
  people; not now.
- **Each employee gets their own day by email:** not asked for; the
  app's end-of-day summary already shows it.
- **Send the day-end email at each team's own day end:** more exact but
  hard to explain with mixed shifts; one company time is simpler.

## Open (owner)

1. **Day-end send time:** 08:00 India time the next morning (proposed),
   or another time?
2. **Overall report for HR too,** or Administrators only? Proposed:
   both (HR already sees everyone's time).

## Plan

1. This ADR.
2. Server: day rows, `GET /v1/reports/day`, the day-end email job,
   migration 0016, Rules → Reports settings.
3. Console: Reports → Day summary (desktop 0.1.35).
4. Server + console: Overview with charts and CSV; the Monday email's
   headline numbers.
