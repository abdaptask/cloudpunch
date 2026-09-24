# ADR-0013 — Tray residency and on-the-clock reminders

- **Status:** Accepted (2026-09-24)
- **Date:** 2026-09-24
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Extends:** ADR-0003 §3 (break-cap soft nudge) and §10 (app exit while
  clocked in).
- **Confidence:** High on behaviour; the intervals are policy defaults.

## Context

Closing the main window hides CloudPunch to the system tray (close-to-tray
since 2b.7.2b). Nothing tells the user; someone can believe they quit
while still on the clock, or forget CloudPunch is tracking at all. The
costliest mistake — forgetting to clock out at the end of the day — has
no safeguard. ADR-0003 §3 specifies a break-cap "soft nudge" but nothing
delivers it.

## Decision

### 1. Closing the window asks

Clicking the window's close button shows an in-window dialog instead of
silently hiding:

- **Clocked in:** "You're still clocked in. CloudPunch will keep
  tracking your time from the system tray." — **Keep running in tray**
  (default) · **Clock out & quit**.
- **Clocked out:** "Close CloudPunch?" — **Keep running in tray** ·
  **Quit**.
- "Don't ask again" remembers **Keep running in tray** on that PC. Quit
  is never remembered.

The tray menu's **Quit** while clocked in opens the same dialog, so the
app can't exit mid-session without clocking out. The first time in a run
the window goes to the tray, a notification says CloudPunch is still
running there.

### 2. On-the-clock reminder

While clocked in **and the main window is hidden**, a native notification
every `reminders.on_clock_minutes` (default **30**): "You're on the clock
— 2h 30m this session. CloudPunch is running in the system tray."
Suppressed:

- during a detected call (it fires when the call ends — never over a
  meeting or shared screen);
- while the idle prompt is showing, or the window is visible;
- during `notifications.quiet_hours` (default 22:00–07:00 local).

### 3. Live tray status

The tray icon is a coloured status disc — green clocked in, amber on a
break, grey clocked out — and the tooltip reads e.g. "CloudPunch —
Clocked in · 2h 30m", refreshed every minute.

### 4. Break-cap nudge

When a bio break passes `break.bio.max_minutes` (10) or a meal break
`break.meal.max_minutes` (60), one notification: "Still on your bio
break? (12 min)". State is unchanged (ADR-0003 §3). Suppressed in quiet
hours.

### 5. Long-shift check

After `reminders.long_shift_hours` (default **9**) in one session, a
notification plus the main window comes forward with a banner: "You've
been clocked in for 9 hours — still working?" **Still working** (asks
again after `reminders.long_shift_repeat_hours`, default 2) · **Clock
out**. **Not** suppressed by quiet hours: a forgotten overnight clock-in
is exactly what it's for.

### 6. Implementation boundaries

- Scheduling is a pure function of state, time, window visibility, and
  local time of day (`reminders.rs`), driven by the existing 1 Hz tick.
- Notifications are sent from Rust (`tauri-plugin-notification`); the
  webview gets no notification permission.
- Local time of day comes from the OS (`GetLocalTime` on Windows); no
  time-zone library is added for this.
- Reminders are local only; nothing is recorded or sent to the server.

## Consequences

### Positive

- Closing the window can't silently leave someone on the clock, and
  quitting mid-session always clocks out properly.
- A glance at the tray shows status; forgotten overnight sessions are
  caught after 9 hours instead of at timesheet review.
- ADR-0003's break-cap nudge is finally delivered.

### Negative

- Notifications can annoy; mitigated by the call, visibility, and
  quiet-hours rules and by policy-configurable intervals.
- One new dependency (`tauri-plugin-notification`), which records
  Linux/macOS notification back-ends in the lockfile.
- In development builds Windows may attribute notifications to the dev
  host process; installed builds use the app's identity.

## Alternatives considered

- **Silent close-to-tray (status quo).** Rejected — the problem.
- **Quit on close.** Rejected — tracking would stop mid-session.
- **Reminders even while the window is visible or during calls.**
  Rejected — noise, and risk of popping up over a shared screen.

## References

- ADR-0003 §3, §10; ADR-0010; ADR-0012
- `docs/policy/idle-policy-defaults.md` §6, §7, §12
