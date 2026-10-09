# ADR-0037 — Holidays, shift-start alerts, and regular late starters

- **Status:** Accepted (2026-10-09, the owner answered the open
  questions; see "Decided")
- **Date:** 2026-10-09
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0031 (shifts, the shift popup, "Not working
  today"), ADR-0018 §4 (the 8:00 popup), ADR-0025 (team views and
  reporting lines), ADR-0021 / ADR-0032 (email from
  cloudpunch@aptask.com), ADR-0015 (policy).
- **Confidence:** High. The shape reuses tables, mail and patterns we
  already run, and the owner set the behaviour.

## Context

The owner plans to roll CloudPunch out to about 50 more people and
asked for features that cost nothing extra. Two belong together:

1. **Managers learn about a missed clock-in the same day.** Today a
   person with a shift who never clocks in shows as "Not clocked in,
   shift started 08:00" on Team (ADR-0031 §2), but only if a manager
   happens to look. The owner also wants to know who misses starts
   **regularly**.
2. **Holidays.** ADR-0031 left these out; "Not working today" stands
   in. With 50 people, every company holiday would mean 50 popups every
   5 minutes until each person says "Not working today", and the alert
   (1) would wrongly fire for each of them. So holidays come first.

Leave days were considered and **set aside for now** (the owner's
answer). "Not working today" covers a person's own day off, and now
tells their manager (§3).

Nothing here needs new infrastructure. It runs in the existing API on
the pilot VM, stores rows in the existing database, and sends mail
through the cloudpunch@ mailbox the API already sends welcome emails
from (Graph, scoped to that one mailbox). The one new kind of moving
part is a timer inside the API (§3).

## Decision

### 1. Holidays: one company list, kept by HR and Administrators

- New append-only table `holiday` (migration 0010): `date`, `name`,
  `added_by`, `added_at`. Removing one is a new row marking it
  cancelled (as with every CloudPunch history table); the latest row
  for a date wins.
- **One list for everyone** (the owner's answer).
- Managed in **Settings → Holidays** (desktop and web) by HR and
  Administrators: a new capability `hr.holiday.write`, given to both.
  Everyone can see the list.

### 2. What a holiday changes

The date is the shift's date in the shift's zone (an overnight shift
belongs to the day it starts, ADR-0031). People without a shift use
the policy zone of the 8:00 popup.

- **No popups:** neither the shift popup nor the 8:00 popup. The app
  learns about it from `GET /v1/me/shift`, which gains
  `day_off: { kind: "holiday", name }` (the `kind` leaves room for
  leave later). Older apps ignore the field and keep asking, so the
  desktop release (0.1.25) must go out before the first holiday.
- **Team:** shows "Holiday: Diwali" instead of "Not clocked in, shift
  started".
- **No alerts** (§3), and it never counts as a missed start (§4).
- **Never blocking:** if someone clocks in on a holiday, the time is
  recorded as usual.

### 3. Shift-start emails

All from cloudpunch@aptask.com. Names, shift times and clock-in times
only; nothing about what anyone is doing (invariant 1). Every reader
already sees the same on Team or has cross-team read, so no one gets
data they couldn't see (invariant 5).

**Who gets them:** the person, and their reporting manager
(`reporting_manager_id`). A person with **no manager set**: the
Administrators and HR instead of a manager.

| Email | When | Text (summary) |
| --- | --- | --- |
| **Missed clock-in** | 15 min after the shift started, not clocked in, not a holiday, and they haven't said "Not working today" | "Not clocked in yet: <name>, shift 08:00 ET (15 min ago). No clock-in received by 08:15." |
| **Clocked in late** | after a missed clock-in email, when the clock-in arrives | "<name> clocked in at 08:40 (shift 08:00 ET)." |
| **Not working today** | when the person chooses "Not working today" in the popup | "<name> said they aren't working today (shift 08:00 ET)." |

- **Grace period:** 15 minutes (policy `alerts.missed_clock_in_minutes`,
  default 15; the owner's answer).
- **Once each.** New table `shift_alert` (`employee_id`, `shift_date`,
  `kind` = `missed` | `late_clock_in` | `not_working`, `sent_to`,
  `sent_at`), unique on `(employee_id, shift_date, kind)`. The row is
  inserted and the email sent inside one database transaction: a
  second server or a retry hits the unique key and sends nothing
  (invariant 4), and a failed send rolls the row back so the next
  check tries again. The table is append-only.
- **Managers get one email per check**, listing everyone, not one per
  person. The person's copy is their own email.
- **How it runs:** a check inside the API process every minute. This
  is the API's first background job (today it only answers requests),
  so it gets its own start/stop with the server and a log line per
  send. No new service, no cron. "Not working today" is picked up by
  the same check, so a mail failure there retries too.
- **Offline apps:** a clock-in made offline reaches the server later.
  The email says "no clock-in received by 08:15", not "absent". If the
  clock-in then arrives with an earlier time, the follow-up says when
  it was actually made.
- **Switch:** ships **off**. An Administrator turns it on in Settings
  (as with connection location) once the holiday list is in.

### 4. Regular late starters

The owner wants to know who misses starts regularly.

- **What counts:** each `missed` row in `shift_alert` (not clocked in
  15 minutes after the shift started, on a working day). "Not working
  today" is counted separately, not as a miss. A holiday is neither.
- **Regular:** **3 or more missed starts in the last 30 days** (policy
  `alerts.regular_late_count` = 3 and `alerts.regular_late_days` = 30).
- **Where it shows:**
  - The Team person screen: "Missed starts: 4 in 30 days · Not working
    today: 1".
  - A **weekly email on Monday at 09:00 ET**: each manager gets their
    direct reports at or over the threshold; Administrators and HR get
    everyone at or over it. No email when the list is empty.
- **Counts start when the alert is switched on.** Days before that
  aren't scored.

### 5. Order of work

1. Backend: migration 0010 (`holiday`, `shift_alert`), holiday API,
   `day_off` on `GET /v1/me/shift`, Team status "Holiday".
2. Screens: Settings → Holidays (desktop and web).
3. Desktop 0.1.25: popups respect `day_off`. Publish before the first
   holiday on the list.
4. The emails (§3): the check, the three emails, the switch.
5. Regular late starters (§4): Team counts and the Monday email.

## Consequences

- Managers hear about a missed start within about 15 minutes, and the
  person gets the same nudge by email as well as the popup.
- Holidays stop being 50 people pressing "Not working today".
- The Monday email turns single misses into a pattern a manager, HR
  and Administrators can act on.
- Email volume: with 50 people, a bad morning could mean a dozen
  emails. Managers get one combined email per check to keep it down.
- Email reliability is now part of the product: a failed send retries
  on the next check, and Team still shows the status.
- Personal days off still go through "Not working today", which now
  reaches the manager. Planned leave in CloudPunch waits (with greytHR
  as the system of record).
- One migration, one capability, four policy settings, one desktop
  release. No new services or costs.

## Alternatives considered

- **Teams messages instead of email.** Free too, but needs a bot or
  workflow setup. Email works today; Teams can follow.
- **A systemd timer script.** We use timers for backups and health,
  but the alerts need the app's rules (shifts, zones, holidays, roles).
  Keeping them in the API keeps one copy of those rules.
- **Leave days now.** Set aside by the owner; "Not working today" with
  a manager email covers the same-day case.
- **Counting late clock-ins (any minute after the start) as offences.**
  Too noisy; 15 minutes is the line the owner chose for an alert, so
  the same line marks a miss.

## Decided (2026-10-09, the owner)

1. **One holiday list** for everyone.
2. **Leave days: not now.**
3. **No popup on a holiday** (or leave day, once leave exists).
4. **15-minute grace period**, and the owner wants to **know regular
   offenders** (§4; the 3-in-30-days threshold is Architecture's
   default, adjustable in policy).
5. **No manager set:** Administrators and HR get the alerts.
6. **"Not working today" emails the manager** when the person chooses
   it.
7. **Follow-up** when someone clocks in after a missed clock-in email:
   yes.
8. **The employee gets a copy:** yes.

## Implementation notes (2026-10-09, while building)

These change _how_, not _what_, the owner decided:

1. **`GET /v1/me/shift` also lists the holidays** from yesterday to 60
   days ahead (`holidays: [{ date, name }]`), next to `day_off`. The app
   needs them for the 8:00 popup (people without a shift, whose date is
   the policy zone's) and to know about a holiday while offline.
2. **Holidays are read by anyone signed in** at `GET /v1/holidays`, and
   changed at `PUT` / `DELETE /v1/admin/holidays/:date` (HR and
   Administrators). A rename is a new row; a removal is a new row with
   `cancelled`.
3. **Migration 0010 creates `shift_alert` now**, ahead of the emails
   (§3), so the owner runs one migration for this ADR, not two.
4. **Team's holiday status** shows only during the person's shift
   hours, like "Not clocked in, shift started"; outside them it stays
   "Clocked out".
5. **The Holidays editor is in the desktop app only** (Settings →
   People), where HR and Administrators already keep shifts and roles.
   The web dashboard shares only the Team and person screens, so it
   shows "Holiday: …" on Team but has no editor.
6. **One email per person and event, with the manager copied**, rather
   than one combined email per manager per check. Each email is claimed
   and sent in its own transaction; a combined email would either send
   twice after a partial failure or lose some. With ~50 people it is a
   handful of emails on a bad morning.
7. **Who the Administrators and HR are** (the owner chose "remember
   roles", 2026-10-09): migration 0011 adds `role_seen`, the roles each
   person's latest sign-in token carried, written only when they change,
   and updated at once when Settings → People changes someone's roles.
   Used only to choose recipients, never for access (invariant 6).
   Someone whose role is removed directly in Entra keeps getting these
   emails until they next sign in.
8. **The switch and the grace period** are `alerts.shift_emails`
   (default off) and `alerts.missed_clock_in_minutes` (default 15) in
   the global policy, read from the global settings only.
9. **The email check only looks at shifts in progress.** A clock-in
   after the shift has ended sends no follow-up.
