# ADR-0046 — Updates that reach everyone: install when clocked out, push from the console

- **Status:** Accepted (2026-10-14, the owner: "yes go ahead", with the
  Windows-style choices below)
- **Date:** 2026-10-14
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Amends:** ADR-0022 §2 (when a downloaded update installs).
- **Confidence:** High on the cause (measured, below). Medium on the
  timing rules; they are settings-free on purpose and easy to tune.

## Context

The owner asked whether computers are really behind, and how to push
updates to everyone. On 2026-10-14 all 46 computers active in the last
two days reported their real version (the device row and their newest
events agree): 8 on 0.1.25, 10 on 0.1.32, 21 on 0.1.39–0.1.41, the
rest scattered. The behind ones clock out 15–17 times a week, so they
had chances; the updater never took them.

Why (ADR-0022 §2 as built, confirmed by the owner's own `update.log`,
where every automatic install waited "clocked in" or "already worked
today" and only "Restart to update" ever installed):

- An update installs only when clocked out, **nothing tracked yet that
  working day**, and **within 30 minutes of a sign-in, unlock, wake or
  app start**: the first minutes of the morning.
- The app checks a minute after starting, then every 4 hours, and keeps
  a downloaded update in memory only. In the morning the person clocks
  in from the popup before the download finishes, and the window closes.
- On macOS the updater replaces the app but nothing restarts it, so a
  Mac keeps running the old version until CloudPunch is quit.
- Restarting while clocked in counts as a crash: the session is
  recovered and closed (ADR-0003 §10). So "restart mid-shift" can't be
  the answer.

The owner wants Windows-style choices: "update and restart, update and
shut down".

## Decision

1. **Clocked out, it updates by itself.** A downloaded update installs
   once the person has been clocked out for 2 minutes (or straight away
   on a start that finds them clocked out). Today's timeline comes back
   from its journal, so "nothing tracked today" no longer matters. The
   app checks every 30 minutes, and again within a minute of a push.
2. **The person chooses, like Windows Update**, whenever an update is
   ready:
   - **Clock in:** "Update and clock in" (installs, restarts, clocks in
     on the new version, about 20 seconds) or "Clock in now". The
     morning popup offers the same.
   - **Clock out:** "Clock out and update", "Clock out, update and shut
     down", or plain "Clock out".
   - **Clocked in:** a banner, "CloudPunch X is ready: Update and clock
     back in". This clocks out, updates and clocks back in: a new
     session, seconds later, in the same working day (ADR-0016 §1).
     No session is ever resumed across a restart, so crash recovery
     stays as it is.
3. **Pushed from the console.** Computers → **Push the update**: an
   Administrator sets "everyone on the latest version by …" (in 5
   minutes, at 6 pm today, tomorrow 10 am, or a time). Stored in the
   company settings as `updates.required_by` (and `updates.pushed_at`),
   audited like any settings save (ADR-0038 §8). Apps see it at their
   next settings refresh (≤ 15 minutes) and fetch the update at once.
   - Before the time: the choices above, with "Clock in now" still
     allowed.
   - After it: "Clock in now" is gone (update and clock in only), and a
     clocked-in app shows a **5-minute notice**, then clocks out,
     updates and clocks back in by itself.
4. **"Update and shut down"** starts the new version, which then asks
   the computer to shut down (Windows: `shutdown /s /t 60`, which the
   person can cancel with `shutdown /a`; macOS: System Events, which may
   ask once for permission).
5. **macOS restarts after installing**, as Windows already does.
6. **The intent survives the restart** in the existing restart marker
   (`restart-after-update`, ADR-0022 amendment): empty, `clock-in` or
   `shutdown`, honoured only if the marker is fresh (10 minutes).

## Consequences

- Behind computers catch up the first time they're clocked out for two
  minutes on 0.1.42 or later. The 18 on 0.1.25 and 0.1.32 still have the
  old rule; they reach 0.1.42 at a morning start before clocking in, or
  at once if they click "Restart to update" while clocked out.
- An update while clocked in costs about 20 seconds of tracked time and
  shows as two sessions; payroll totals treat them as one working day.
- A computer that isn't running can't be pushed; it updates when it
  next starts (autostart, ADR-0036).

## Alternatives considered

- **Resume the same session after a restart:** no visible break, but it
  changes crash recovery (ADR-0003 §10) and risks double-counting;
  not worth it for 20 seconds.
- **Intune / MDM:** reaches computers where the app isn't running, but
  needs licences and per-device setup; a possible backstop later.
- **Force at once with no choice:** interrupts calls and meetings.
