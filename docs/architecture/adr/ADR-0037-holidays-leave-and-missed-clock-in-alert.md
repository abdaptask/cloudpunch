# ADR-0037 — Holidays, leave days, and a missed clock-in alert to managers

- **Status:** Proposed (2026-10-09, the owner asked for it; open
  questions below)
- **Date:** 2026-10-09
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0031 (shifts, the shift popup, "Not working
  today"), ADR-0018 §4 (the 8:00 popup), ADR-0025 (team views and
  reporting lines), ADR-0021 / ADR-0032 (email from
  cloudpunch@aptask.com), ADR-0015 (policy).
- **Confidence:** High on the shape (it reuses tables, mail and
  scheduling patterns we already run). Medium on the details until the
  owner answers the open questions.

## Context

The owner plans to roll CloudPunch out to about 50 more people and
asked for features that cost nothing extra. Two belong together:

1. **Managers learn about a missed clock-in the same day.** Today a
   person with a shift who never clocks in shows as "Not clocked in,
   shift started 08:00" on Team (ADR-0031 §2), but only if a manager
   happens to look.
2. **Holidays and leave.** ADR-0031 left these out ("greytHR is
   deferred"); "Not working today" stands in. With 50 people, every
   company holiday would mean 50 popups every 5 minutes until each
   person says "Not working today", and an alert (1) would wrongly fire
   for each of them. So holidays have to come first.

Nothing here needs new infrastructure. It runs in the existing API on
the pilot VM, stores rows in the existing database, and sends mail
through the cloudpunch@ mailbox the API already sends welcome emails
from (Graph, scoped to that one mailbox). The one new kind of moving
part is a timer inside the API (§4).

## Decision

### 1. Holidays: one company calendar, kept by HR and Administrators

- New append-only table `holiday` (migration 0010): `date`, `name`,
  `added_by`, `added_at`. Removing one is a new row marking it
  cancelled (as with every CloudPunch history table); the latest row
  for a date wins.
- Managed in **Settings → Holidays** (desktop and web) by HR and
  Administrators: a new capability `hr.holiday.write`, given to both.
  Everyone can see the list.
- **One calendar for everyone** to start with. If India and US-hours
  teams need different days, calendars per department can follow
  (open question 1).

### 2. Leave days: recorded for a person by their manager, HR or an Administrator

- New append-only table `leave_day`: `employee_id`, `date`, `added_by`,
  `added_at`, optional short note, cancellable like holidays. Whole
  days only to start with (open question 3).
- Recorded on the Team person screen. The person's own manager can add
  leave for their direct reports (`team.leave.write`); HR and
  Administrators for anyone (`hr.leave.write`). No one adds their own
  (separation of duties, as with corrections in ADR-0030).
- The person sees their own leave days in the app. There is no request
  and approval flow yet (open question 2).
- greytHR stays the system of record for leave. When its API is
  available, its leave can fill this table instead of manual entry.

### 3. What a day off changes

A date counts as a **day off** for a person if it is a holiday or one
of their leave days. The date is the shift's date in the shift's zone
(an overnight shift belongs to the day it starts, ADR-0031).

- **No popups:** neither the shift popup nor the 8:00 popup. The app
  learns about the day off from `GET /v1/me/shift`, which gains
  `day_off: { kind: "holiday" | "leave", name }`. Older apps ignore the
  field and keep asking, so the desktop release (0.1.25) should go out
  before the first holiday.
- **Team:** shows "Holiday: Diwali" or "On leave" instead of "Not
  clocked in, shift started".
- **No missed clock-in alert** (§4).
- **Never blocking:** if someone clocks in on a day off, the time is
  recorded as usual.

### 4. Missed clock-in alert to the manager

- **When:** a person with a shift has not clocked in **15 minutes**
  after the shift started (policy `alerts.missed_clock_in_minutes`,
  default 15, open question 4), and the day is not a day off, and they
  haven't said "Not working today" (open question 6).
- **To whom:** the person's reporting manager (`reporting_manager_id`).
  With no manager set, the Administrators (open question 5).
- **What:** one email per manager per check, listing everyone missing,
  from cloudpunch@aptask.com:
  "Not clocked in yet: <name> (shift 08:00 ET, 15 min ago)", with
  a link to Team on the web dashboard. Names, shift times and minutes
  only; nothing about what anyone is doing (invariant 1). The manager
  already sees the same on Team, so no one gets data they couldn't see
  (invariant 5).
- **Once per person per shift.** New table `missed_clock_in_alert`
  (`employee_id`, `shift_date`, `sent_to`, `sent_at`), unique on
  `(employee_id, shift_date)`. The alert is claimed by inserting the
  row first and mailed second, so a restart, a retry, or later two
  servers in AWS (ADR-0035) can't send it twice (invariant 4).
- **How it runs:** a check inside the API process every minute. This
  is the API's first background job (today it only answers requests),
  so it gets its own start/stop with the server and a log line per
  send. No new service, no cron.
- **Offline apps:** a clock-in made offline reaches the server later.
  The email says "no clock-in received by 08:15", not "absent", and the
  15 minutes absorbs a short outage. A later clock-in sends nothing
  more (open question 7 asks about a follow-up).
- **Switch:** ships **off**. An Administrator turns it on in Settings
  (as with connection location) once the holiday list is in.

### 5. Order of work

1. Backend: migration 0010, holiday and leave APIs, `day_off` on
   `GET /v1/me/shift`, Team statuses.
2. Screens: Settings → Holidays; leave on the Team person screen
   (desktop and web).
3. Desktop 0.1.25: popups respect `day_off`. Publish before the first
   holiday on the list.
4. The alert: the check, the email, the switch and its policy setting.

## Consequences

- Managers hear about a missed start within about 15 minutes, without
  opening CloudPunch.
- Holidays stop being 50 people pressing "Not working today".
- Leave in CloudPunch duplicates greytHR until the integration exists:
  someone has to enter it in both places. That is the cost of not
  waiting for greytHR.
- Email reliability is now part of the product: if Graph mail fails,
  the alert is logged and retried on the next check (the claim row
  records only a successful send), and Team still shows the status.
- One migration, three new capabilities, one policy setting, one
  desktop release. No new services or costs.

## Alternatives considered

- **Teams messages instead of email.** Free too, but needs a bot or
  workflow setup per team. Email works today; Teams can follow.
- **A systemd timer script for the alert.** We use timers for backups
  and health, but the alert needs the app's rules (shifts, zones, days
  off, roles). Keeping it in the API keeps one copy of those rules.
- **Alert the employee instead of the manager.** The desktop popup
  already asks the employee every 5 minutes; the gap is the manager
  not knowing (open question 8 asks about adding the employee).
- **Wait for greytHR leave.** Blocked on API access with no date.

## Open questions for the owner

1. **Holidays:** one company list for everyone, or separate lists
   (e.g. India and US holidays)? Which holidays do people on US-hours
   shifts take?
2. **Leave:** is manager / HR / Administrator entry enough, or should
   employees request leave in the app for their manager to approve?
3. **Half days:** needed now, or whole days only?
4. **Grace period:** 15 minutes after shift start?
5. **No manager set:** alert the Administrators, HR, or nobody?
6. **"Not working today":** should the manager get an email for that
   too, or is Team enough?
7. **Follow-up:** when someone clocks in after the alert, email
   "clocked in at 08:40"? Or leave it for a later daily digest?
8. **Employee copy:** also email the person, or is the popup enough?
