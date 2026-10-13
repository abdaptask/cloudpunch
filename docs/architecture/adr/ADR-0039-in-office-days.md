# ADR-0039 — In-office days for hybrid workers

- **Status:** Proposed
- **Date:** 2026-10-13
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0031 (shifts, the shift popup), ADR-0037 (holidays
  and shift-start alerts: the "day off" path), ADR-0038 (admin console,
  bulk changes).
- **Confidence:** High on the shape (it reuses the holiday path). Medium
  on one behaviour the owner should confirm: what happens if someone
  clocks in on an office day anyway (§4).

## Context

Some people work a hybrid schedule: some days from home, some in the
office. CloudPunch is for remote time. On an office day today it treats
them like anyone else: the shift popup asks them to clock in every 5
minutes, Team shows "Not clocked in, shift started 09:00", and the
shift-start email (ADR-0037 §3) tells their manager they're late. None
of that is true.

The owner asked (2026-10-13) for an admin setting: "if they are in the
office, the admins can check that option and it won't show them as
logged in late or away or anything of that sort." The owner's answers:

- **How it's set:** each person's **usual office weekdays** (e.g. Tue
  and Thu), and **one-off dates** ticked or unticked when plans change.
- **What CloudPunch does:** **steps back entirely** for that day: no
  clock-in popup, no late or missed alerts or emails, no idle or away
  checks; Team shows **In office**; their time isn't tracked that day.

## Decision

### 1. What an office day is

A date on which a person is in the office. It's decided per person and
date, in the person's shift zone (as holidays are, ADR-0037 §1):

1. A **one-off** for that date, if any: "in office" or "not in office"
   (the latest one set wins).
2. Otherwise their **usual office weekdays** in force on that date.

A holiday stays a holiday: an office day on a holiday changes nothing.

### 2. Storage (migration 0015, append-only)

- `office_pattern`: employee, weekdays (ISO 1–7, may be empty), from
  date, reason, by, at. The latest on or before a date applies, as
  shifts do (ADR-0031).
- `office_day`: employee, date, `in_office` (true / false), reason, by,
  at. The latest row per person and date wins; "untick" is a new row
  with `false`.
- Both append-only (triggers, the invariant scan) with an `audit_log`
  row per change. One resolver function answers "is this an office
  day?", used by everything below.

### 3. What steps back

On an office day, for that person:

- **The app:** `GET /v1/me/shift` answers `day_off: { kind: "office" }`
  (today it says `kind: "holiday"` on a holiday). The app already skips
  the shift popup and the 8:00 popup on a day off; it shows "In office
  today" where it would say "Holiday".
- **Alerts:** no shift-start email (not clocked in, late, not working),
  as on a holiday (ADR-0037 §3).
- **Monday late-starters email:** office days don't count as missed or
  late starts (ADR-0037 §4).
- **Team:** shows **In office** instead of "Not clocked in" or late.
- **Day summaries and reports:** the day shows as **In office**, with
  no hours (time isn't tracked that day).

### 4. If they clock in anyway

Someone may go home at lunch and work the afternoon remotely. Clock-in
stays available; **once they clock in, the day is tracked as normal**
(idle and away checks included), and the office marker stays on the day
for managers to see. The steps-back in §3 cover the not-clocked-in
case, which is what the owner described. (Owner to confirm, see Open.)

### 5. Who sets it, and where

- **Administrators and HR** (the people who set managers today,
  `hr.employee.write`), checked by the server (invariants 5, 6).
  Managers see it on Team but don't set it.
- **Admin console:**
  - **Person panel → Office days:** weekday chips (Mon–Sun) with a
    start date, and the coming one-offs with **Add a date** /
    **Remove**.
  - **Bulk bar → Set office days** (ADR-0038 §5): the same weekdays for
    many people, all or nothing, once per idempotency key.
  - **People table:** an "Office" column ("Tue, Thu"), and a filter.
- **Endpoints:**
  - `GET /v1/admin/office-days?from&to`: everyone's patterns and
    one-offs in a range.
  - `PUT /v1/admin/employees/:id/office-pattern` `{weekdays, effective_from?, reason?}`.
  - `PUT /v1/admin/employees/:id/office-days/:date` `{in_office, reason?}`.
  - `PUT /v1/admin/employees/bulk/office-pattern`.

### 6. Privacy (invariant 1)

Nothing new is collected from anyone's computer. The office schedule is
set by admins, not detected (no location, no network checks). Connection
location (ADR-0029) stays separate and is not used to decide this.

## Consequences

- Hybrid workers stop getting popups and late emails on office days,
  and managers stop seeing false "late".
- One more thing for admins to keep current. The weekly pattern keeps
  that small; one-offs handle changes.
- The desktop needs a small release (the "In office today" wording);
  the popups already stop on any day off, so the server change alone
  stops them.

## Alternatives considered

- **Detect the office automatically** (office Wi-Fi or IP): no new
  admin work, but it is location tracking, needs network details we
  don't have, and fails on VPN. Not now.
- **Let people mark their own office days:** easy to misuse ("in
  office" to avoid late flags). The owner asked for admins.
- **Treat office days as "not working":** wrong in reports, and would
  tell their manager they're off.

## Open (owner)

1. **Clock-in on an office day (§4):** track it as normal once they
   clock in (proposed), or keep idle/away checks off all day?
2. **HR too, or Administrators only** (§5)? Proposed: both, as for
   managers.

## Plan

1. This ADR.
2. Server: migration 0015, resolver, endpoints, and the four places in
   §3. No desktop release needed for the popups to stop.
3. Admin console: person panel, bulk bar, table column (desktop 0.1.34
   with the "In office today" wording).
