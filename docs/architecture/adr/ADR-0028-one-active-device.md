# ADR-0028 — One machine at a time: strict block, admin sign-out

- **Status:** Accepted (2026-09-30, the owner approved)
- **Date:** 2026-09-30
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0003 §8 (multi-device conflict), ADR-0020 (People),
  ADR-0025 (audited views). Replaces the `multi_device.on_second_signin`
  default (`prompt_take_over`) in `docs/policy/idle-policy-defaults.md`
  §10 with `deny`.
- **Confidence:** High for the server rule, which reuses the existing
  one-open-session index and 409. Medium for the admin sign-out timing,
  which depends on how quickly the other machine next talks to the API.

## Context

The owner asked that someone working on one machine can't sign in on
another (2026-09-30).

What exists today:
- **The server:** a second clock-in while a session is open on another
  device gets `409 multi_device_conflict` (`events/ingest.ts`). A
  `take_over` flag lets the caller close the other session.
- **The desktop app:** it never tells the person. The batch is retried
  quietly (`sync/mod.rs`), so the second machine *looks* clocked in
  while none of its time reaches the server.
- **Sign-in:** nothing is checked.

The owner chose a **strict block**: only an admin can end the person's
session on the other machine ("Take over here" as an admin action, not
the employee's).

## Decision

### 1. "Working" means clocked in

A person is working on a machine when that device has an **open
session** on the server. Being signed in but clocked out elsewhere
doesn't block: most people leave the app running on a laptop they also
use at home, and blocking on that would need an admin every time.

### 2. Sign-in is blocked while clocked in elsewhere

- **New endpoint:** `GET /v1/me/active-device` returns the open session's
  device name and `opened_at`, or 204. Called right after sign-in and
  enrolment, before the main screen.
- **Blocked screen:** *"You're clocked in on ASHEIKH-LT since 9:02 am.
  Clock out there first, or ask an admin to sign you out of it."* Only
  **Sign out** and **Check again** are offered.
- The app stays signed in to Entra (no new Microsoft prompt), but
  records nothing and offers no clock-in.

### 3. Clock-in is blocked too (the safety net)

A clock-in that still meets `multi_device_conflict` (for example the
other machine clocked in a moment later) shows the same message, drops
the refused batch from the outbox, and returns to Clocked out. It no
longer retries silently. The employee's app never sends `take_over`,
and the server rejects `take_over: true` from anyone who isn't an
Administrator (§4).

### 4. Admin: "Sign out of other machine"

- **Where:** Settings → People → the person → **Active machine**,
  showing the device name, since when, and **Sign out of this machine**.
  Administrator role only (not HR, not Manager).
- **What it does:**
  - The server closes the open session at the device's last event time,
    `closed_reason = 'remote_takeover'`, flagged for the manager like a
    reconstructed session (ADR-0003 §10).
  - It writes an `audit_log` row (who, whose session, which device).
  - It marks the device `signout_requested`. The next time that app
    talks to the API (sync, policy poll every 15 min, or update check),
    it gets `409 device_signed_out`, clears its local session and signs
    out, keeping unsent events for the next sign-in.
- The person can then sign in on the new machine.

### 5. Policy

`multi_device.on_second_signin` becomes `deny` (was `prompt_take_over`).
`prompt_take_over` and `auto_take_over` stay possible settings, but
aren't offered in Settings for now.

## Consequences

- **Positive:**
  - Two machines can't both record time for one person.
  - The silent-retry bug is gone: a refused clock-in is always visible.
  - The admin override is audited.
- **Negative:**
  - A laptop left clocked in at home blocks the person until an admin
    acts (the owner's choice).
  - A dead or stolen laptop needs an admin. Its session is closed at its
    last event time, so no time is invented.
  - The other machine signs out only when it next reaches the API: up to
    about 15 minutes, or never if it's switched off (it signs out when
    it's next switched on).

## Alternatives considered

- **Employee "Take over here":** rejected by the owner; only admins.
- **Block on "signed in elsewhere", not "clocked in elsewhere":**
  rejected. The server only knows a device is signed in from its polls,
  so it would block for up to 15 minutes after closing the laptop, and
  every home/office switch would need an admin.
- **Leave it at the clock-in 409:** the silent retry makes this invisible,
  which is how the bug went unnoticed.
