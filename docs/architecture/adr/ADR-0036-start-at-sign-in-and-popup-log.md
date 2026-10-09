# ADR-0036 — Start at Windows sign-in, a popup log, and a louder clock-in popup

- **Status:** Accepted (2026-10-09: the owner asked for all three and
  merged #135; built in #136, released as desktop 0.1.24)
- **Date:** 2026-10-09
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Amends:** ADR-0031 §2 (the shift popup) and ADR-0018 §4 (the 8:00
  popup): how loudly they open. When they open is unchanged.
- **Confidence:** High on the mechanism (the registry `Run` key, a local
  log file, the taskbar flash the break-overrun alert already uses).
  Medium on the cause it addresses; see Context.

## Context

On 2026-10-09 the 8:00 ET shift popup "didn't come" for the testers.
The pilot API log showed why, as far as it can show anything:

- Neither tester's app was running at 8:00. Their first requests came
  at 8:09 and 8:17 ET (start-up: enrol, fetch the shift, fetch today),
  and each sent an event within seconds, most likely the clock-in. The
  app is not started with Windows, so a computer switched on at 8:09
  has no CloudPunch until someone opens it.
- The owner's app had been running all night, fetching the shift every
  15 minutes, but the owner clocked in at 8:53, before the 9:00 shift, so the
  popup rightly stayed away.
- A test of the real agent with that shift (clocked out, 9:01 ET) opened
  the popup and brought the window forward. Shift data on the server
  was right for everyone.

Two gaps made this slow to diagnose and easy to miss:

1. **Nothing is written down.** The app's `eprintln!` lines go nowhere
   in an installed Windows build, so "why didn't it open" can only be
   answered by reasoning from server logs.
2. **A late popup is quiet.** When the app starts after the shift has
   begun, the popup opens in the same moment as the window itself, with
   no flash or notification, and is easy to read as "the app opened".

## Decision

### 1. CloudPunch starts when the person signs in to Windows

- The app writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
  value `CloudPunch` = `"<path to cloudpunch-desktop.exe>" --autostart`
  every time it starts, if the value is missing or points elsewhere.
  Per user, no admin rights, same as the per-user installer (ADR-0019).
- Only in builds that carry the update key (the installed pilot build),
  so a `cargo run` or dev build never registers itself.
- Started with `--autostart`, the window stays hidden and the app sits
  in the tray. The shift popup (or the 8:00 popup) brings it forward
  when due. Started any other way, the window opens as today. If no one
  is signed in, an autostart opens the window, since a hidden app
  that can't record helps no one.
- Windows' own switch is respected: turning CloudPunch off in Task
  Manager → Startup apps writes a separate `StartupApproved` value,
  which the app never touches. Re-writing `Run` does not undo it.
- Uninstalling removes the value (an NSIS pre-uninstall hook). An
  update runs the installer too; if the value went with it, the app
  writes it back on its next start.
- macOS is out of scope here (the owner asked for Windows). A Login
  Item can follow the same rules later.

### 2. A local popup log

- `logs/popup.log` in the app's log folder, next to `update.log`,
  same format (UTC time, app version, line) and the same 256 KB roll to
  `.old`.
- It records, as they happen: the app starting (and whether by
  autostart), each shift fetch that changes what the app knows or
  fails, and each change in the popup's decision, e.g. `shift popup
  waits: outside the shift`, `… away from the computer`, `… not ready
  (not signed in or not enrolled)`, `… clocked in`, `… snoozed`,
  `… not working today`, `opened`. A decision is written only when it
  changes, not every second.
- What it holds is OS state and the app's own state, no content
  (invariant 1): no window titles, apps, keys or names. It never
  leaves the computer; someone asked to look reads it from
  `%LOCALAPPDATA%\com.aptask.cloudpunch\logs\`.

### 3. The popup opens louder

- Whenever the clock-in popup opens (the shift popup or the 8:00 one),
  the taskbar button flashes until the window is used
  (`request_user_attention`, as the break-overrun alert does).
- The first time it opens for a shift (or day, for the 8:00 popup) a
  notification goes with it: "Your shift started at 8:00. Clock in?"
  (the 8:00 popup: "Good morning. Clock in?"). The 5-minute repeats
  after "Not now" flash but don't notify again.

## Consequences

- Testers whose computers are off at shift start get the popup when
  they sign in to Windows, with a flash and a notification, instead of
  needing to open CloudPunch first.
- The next "the popup didn't come" has a file to read.
- One more thing runs at sign-in. It uses no more than CloudPunch does
  today once opened; people can still switch it off in Task Manager.
- The installer gains a small hook file (`installer-hooks.nsh`).

## Alternatives considered

- **`tauri-plugin-autostart`.** Does the same registry write, but is a
  new dependency; `winreg` is already in the tree.
- **Write `Run` only from the installer.** Fewer moving parts, but a
  value removed by hand or by an update would not come back until the
  next update.
- **Open the window at sign-in, not the tray.** Noisy at every boot,
  hours before some shifts. The popup brings it forward when it matters.
- **Notify on every 5-minute repeat.** Too much for a "Not now" the
  person already gave; the flash is enough.
