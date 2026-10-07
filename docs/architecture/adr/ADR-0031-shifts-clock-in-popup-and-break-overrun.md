# ADR-0031 — Shifts, a clock-in popup that keeps asking, and a loud break overrun

- **Status:** Proposed (2026-10-07)
- **Date:** 2026-10-07
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0018 §4 (daily clock-in popup from the sign-in
  time), ADR-0023 (break types and planned breaks), ADR-0015 (policy
  overrides), ADR-0025 (team views), ADR-0028 (one active machine).
- **Confidence:** High for the popup and break-alert behaviour (the
  owner's answers, 2026-10-07). Medium for the shift model in §1: a
  weekly pattern is assumed and needs the owner's confirmation.

## Context

The owner asked for three things on 2026-10-07:

1. **Shift assignment** for team members.
2. A clock-in popup that **keeps coming back during the shift** until
   the person clocks in, and that still applies after a clock-out.
3. When a planned break runs over, a **flashing red alert with the
   relevant options**, even when the app is minimised.

Today there is one company-wide popup at 08:00 in the policy zone
(America/New_York by default). It shows once a day and only if the
person is at the computer, signed in and clocked out. A planned break
gives one "Back yet?" notification at the planned time, and nothing more.

The pilot showed the cost of this. People had the app open all shift
without being clocked in (2026-10-05 to 07), and nobody noticed.

## Decision

### 1. Shifts: a weekly pattern per person, set by an Administrator

The owner's answer is that **only Administrators** assign shifts.
Managers and HR can see them but not change them.

A shift is a weekly pattern:

| Field | Example | Notes |
| --- | --- | --- |
| `days` | Mon–Fri | any set of weekdays |
| `start` / `end` | 08:00 / 17:00 | `end` may be after midnight (overnight shift) |
| `tz` | America/New_York | defaults to the policy zone |
| `effective_from` | 2026-10-12 | a new row replaces the old one from that date |

- **Storage:** a new append-only table `shift_assignment` (migration
  0007) with the actor, the reason and the effective date. A change is a
  new row and never an update, matching ADR-0030's correction model.
- **Audit:** every change writes an `audit_log` row (`shift_assigned`).
- **No shift assigned:** the person keeps today's company-wide 08:00
  popup (ADR-0018 §4), so nothing changes for them.
- **Where it shows:** the shift is listed on the Team person screen and
  in the app's day view ("Your shift today: 08:00–17:00").
- **Not in scope:** leave and holidays (greytHR is deferred). A
  **"Not working today"** choice in the popup (§2) covers them for now.

### 2. The popup keeps asking during the shift

The window is the shift (start to end). It opens at shift start.

- **When it shows:** while the person is signed in, at the computer
  (input within the last 5 minutes, as now) and not clocked in.
- **Choices:**
  - **Clock in now** (the primary button).
  - **Clock in from HH:MM**, when they signed in (ADR-0018 §4).
  - **Not now.** This snoozes it for **5 minutes** (the owner's answer).
  - **Not working today.** This silences it until the next shift. The
    choice is sent to the server and shows on Team as "Said not
    working", so a manager can follow up.
- **After a clock-out:** if the shift hasn't ended, the popup starts
  again 5 minutes after a clock-out. It always respects a break; there
  is no popup while on a break.
- **Clock out keeps you signed in** (the owner's answer). Sign out stays
  a separate action, so the popup can still reach the person. Signed
  out, the app can't record anything, so the popup doesn't show. Instead
  the tray says "Signed out: sign in to clock in".
- **Team view:** Team shows a new status, **"Not clocked in, shift
  started HH:MM"**, in amber.

The policy's `reminders.clock_in_prompt_at` stays as the fallback for
people with no shift. It is never an automatic clock-in.

### 3. Break overrun: the full alert

At the planned end of a break (ADR-0023 §2), while still on that break:

- **Window:** the app window comes to the front, even if it was
  minimised. It shows a **blinking red banner**: "Your 15-min break
  ended 2 min ago".
- **Taskbar or Dock:** the icon flashes. On Windows this uses
  `FlashWindowEx`, via Tauri's `request_user_attention(Critical)`. On
  macOS the Dock icon bounces until the app is focused.
- **Tray:** the tray icon turns red.
- **Notification:** a system notification fires.
- **Repeats:** the alert repeats **every 2 minutes** until the person
  answers.
- **Options:**
  - **I'm back.** This ends the break.
  - **5 more min** and **10 more min.** These extend the planned end and
    send a new event, `USER_BREAK_EXTENDED { planned_minutes }`.
  - **Switch to…** This opens the existing break/away picker.
- **What managers see:** the existing `break_over_planned` exception
  stays. An extension is shown on the day ("extended +5").
- **No new data:** nothing about the screen or the content of what the
  person was doing is captured (invariant 1).

## Consequences

- One migration (0007, `shift_assignment`), two new event types
  (`USER_NOT_WORKING_TODAY` and `USER_BREAK_EXTENDED`) accepted by
  ingest, and a new Settings → People → Shift screen for Administrators.
- Shifts give ADR-0030 corrections and later timesheets a baseline:
  expected hours against worked hours.
- A popup every 5 minutes will annoy people who start late on purpose.
  "Not working today" and the shift itself are the release valves.
- Taking focus from other apps on Windows is limited by the OS's
  foreground rules. Flashing the taskbar is the guaranteed part.
- **Releases:** the desktop changes ship as one release. The backend
  ships first (it is backward-compatible: old apps keep today's
  behaviour).

## Alternatives considered

- **Shifts by department only:** too coarse. The pilot already has
  different start times.
- **Managers assign shifts:** the owner chose Administrators only.
- **Clock-out also signs out:** rejected (the owner's answer). The
  popup couldn't reach anyone, and every sign-in needs the browser.
- **Auto clock-in at shift start:** rejected, as in ADR-0018. A
  clock-in is always the person's own act.

## Open questions for the owner

1. Is a **weekly pattern** (same times on chosen weekdays) enough, or
   do some people need different times on different days?
2. Should the popup also appear a few minutes **before** shift start
   (for example 10 minutes early)?
3. Should "Not working today" need a reason (leave, sick, holiday)?
