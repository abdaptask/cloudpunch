# ADR-0031 — Shifts, a clock-in popup that keeps asking, and a loud break overrun

- **Status:** Accepted (2026-10-07, the owner answered the open questions)
- **Date:** 2026-10-07
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0018 §4 (daily clock-in popup from the sign-in
  time), ADR-0023 (break types and planned breaks), ADR-0015 (policy
  overrides), ADR-0025 (team views), ADR-0028 (one active machine).
- **Confidence:** High. The owner set the behaviour and the shift
  model (answers of 2026-10-07, see "Decided").

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
  0008) with the actor, the reason and the effective date. A change is a
  new row and never an update, matching ADR-0030's correction model.
- **Audit:** every change writes an `audit_log` row (`shift_assigned`).
- **No shift assigned:** the person keeps today's company-wide 08:00
  popup (ADR-0018 §4), so nothing changes for them.
- **Where it shows:** the shift is listed on the Team person screen and
  in the app's day view ("Your shift today: 08:00–17:00").
- **Not in scope:** leave and holidays (greytHR is deferred). A
  **"Not working today"** choice in the popup (§2) covers them for now.

### 2. The popup keeps asking during the shift

The window is the shift (start to end). The popup first appears **at
the shift's start time, in the shift's own time zone**: a shift from
12:00 Asia/Kolkata pops up at 12:00 IST, a shift from 08:00
America/New_York at 08:00 Eastern (following US daylight saving). It
never appears early.

- **When it shows:** while the person is signed in, at the computer
  (input within the last 5 minutes, as now) and not clocked in.
- **Choices:**
  - **Clock in now** (the primary button).
  - **Clock in from HH:MM**, when they signed in (ADR-0018 §4).
  - **Not now.** This snoozes it for **5 minutes** (the owner's answer).
  - **Not working today.** This silences it until the next shift. No
    reason is asked. The choice is sent to the server and shows on
    Team as "Said not working", so a manager can follow up.
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

- One migration (0008: `shift_assignment`, `not_working_day`), one new
  event type (`USER_BREAK_EXTENDED`) accepted by ingest, and a new
  Settings → People → Shift screen for Administrators (see the
  implementation notes).
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

## Decided (2026-10-07, the owner)

1. **Weekly pattern** (same times on the chosen weekdays) is enough.
2. The popup starts **at the shift's start time** in the shift's time
   zone, not before.
3. **"Not working today" asks no reason.**

## Implementation notes (2026-10-07, while building)

These change *how*, not *what*, the owner decided:

1. **Migration 0008, not 0007.** ADR-0030's corrections took 0007.
2. **"Not working today" is not a clock event.** The event ingest only
   accepts events inside a clocked-in session (ADR-0003), and this
   choice is made while clocked out. It is its own append-only table
   (`not_working_day`: person, shift date, when) behind
   `POST /v1/me/not-working-today`, audited, like ADR-0030's
   corrections. `USER_BREAK_EXTENDED` stays an event (it happens inside
   a session).
3. **Shifts reach the app on their own route**, `GET /v1/me/shift`,
   polled with the policy every 15 minutes. The policy document stays
   company and department rules only, so older apps are unaffected.
4. **Administrators only** is a new capability, `admin.shift.write`.
   Managers and HR read shifts through the team views.
5. **The break-overrun alert ignores quiet hours.** "Back yet?" is muted
   in quiet hours, but someone on a break is clocked in, and the owner
   asked for it to be loud.
