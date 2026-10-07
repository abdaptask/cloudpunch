# Changelog

All notable changes to CloudPunch are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### ADR-0030 time corrections, part C: asking, endorsing, approving

- `POST /v1/me/corrections`: ask to correct your own time.
- `POST /v1/team/:id/corrections`: a manager corrects a direct report's
  time; it counts as endorsed. HR has no part (404, as for strangers).
- `GET /v1/corrections/queue`: what waits on you (to endorse as the
  manager, to approve as an Administrator).
- `POST /v1/corrections/:id/decision`: endorse, approve, reject or
  withdraw. An Administrator approves only what their manager endorsed
  (or, with no manager, what was asked), and never a correction they
  asked for or endorsed, or one on their own time. Final decisions are
  final.
- Limits: never in the future, at most 16 hours, within the last 30
  days, a known kind and time zone, a reason, and no overlap with a
  pending correction for the same person.

### ADR-0030 time corrections, part B: corrected days and totals

- Approved corrections are laid over every day before anything is
  totalled (`daysAround`), so the day view, the day picker's totals,
  Team today and exceptions all count them. Inside a session the
  correction's kind replaces what was there; `not_worked` removes the
  time; outside every session it adds a `corrected` session, which is
  how a day the app never recorded gets its hours. Where two overlap,
  the later-approved one wins. Pending and rejected ones change nothing.
- The day view lists the corrections touching the day with their
  status and who asked and decided (`corrections`), and marks corrected
  stretches (`correction_id`) and sessions (`corrected`). Only known
  kinds appear, so older desktop versions read corrected days as is.

### ADR-0030 time corrections, part A: storage

- Migration 0007: `time_correction` (with the person's zone, as events
  record it) and `time_correction_decision`,
  both append-only (triggers reject UPDATE and DELETE; the invariants
  scan now covers them). Limits in the database: at most 16 hours, a
  reason of 1 to 500 characters, one endorsement and one final decision
  per correction.
- New capability `admin.correction.approve` (Administrator only).
- Repositories (Postgres and in-memory): request (a manager's own
  correction is stored endorsed), decide, list; every request and
  decision writes an `audit_log` row. Nothing uses them yet.

### Desktop 0.1.15: an expired sign-in says so

- 0.1.14 was published before this was merged, so it ships as 0.1.15.
- When Microsoft refuses to renew someone's sign-in (expired, revoked,
  password changed), the app used to look signed in and every screen
  said "Can't reach CloudPunch", while clock events silently waited.
  Now a red banner says the sign-in has expired, that time is kept on
  the computer, and offers **Sign in again**. Screens say "Sign in
  again" instead of "Can't reach". The app stops asking Microsoft
  after the first refusal.

### Backend: a late clock-in never clocks out the live session (ADR-0003 §10 amendment)

- A clock-in held on a computer (for example a sign-in that couldn't
  refresh) and sent after the person had clocked in again used to close
  the live session, so Team showed a working person as clocked out.
  Now an older session arriving late is recorded as a closed,
  reconstructed session (closed at its last event, never past the live
  session's start) and the live session stays open.

### Desktop 0.1.14: "Check for updates" in the account menu

- The menu under your initials has **Check for updates**, with the
  version you're on underneath. It runs the same check as the 4-hourly
  one, now, and answers in the menu: up to date, a new version ready
  (Restart to update while clocked out), or why it couldn't check.
  Every manual check is noted in `update.log`.

### ADR-0031 accepted: shifts, a clock-in popup that keeps asking, loud break overrun

- Administrators assign each person a weekly shift. During the shift,
  the clock-in popup returns every 5 minutes until they clock in (or
  say "Not working today"), including after a clock-out. Clock out
  keeps you signed in.
- Owner's answers: a weekly pattern per person; the popup first shows
  at the shift's start in the shift's own time zone (12:00 IST, 08:00
  Eastern), never early; "Not working today" asks no reason.
- A break past its planned end brings the window forward with a
  blinking red banner, flashes the taskbar/Dock and repeats every 2
  minutes: I'm back, 5 or 10 more minutes, or switch.

### Desktop 0.1.13: "Clock in from sign-in" now records the day

- Choosing "clock in from 07:55, when you signed in" (the start popup
  or the link under Clock in) started the timer on screen but recorded
  nothing: the recorder only opened a session for a plain clock-in, so
  every event of that session was dropped as "outside a session". Both
  clock-ins now open the session, and the policy version rides on
  either. Broken since the popup shipped (2026-09-28). Days
  already lost need corrections (ADR-0030); there is nothing to resend.

### ADR-0030 accepted: time corrections

- A correction is one interval with a new meaning (`working`,
  `away_working`, a break type, `not_worked`) and a reason, covering
  missing, mislabelled and extra time. Stored in two new append-only
  tables, never in `time_event`; laid over the derived day.
- Employee asks; their manager endorses (or corrects a report
  directly); **an Administrator approves** every correction. No manager:
  straight to an Administrator. HR has no part for now. Nobody decides
  on their own. "Accept explanation" on idle exceptions (ADR-0018).

### Pilot VM: the office path can't fake a location (ADR-0029)

- Caddy (the office HTTPS path) now drops any `Cf-*` header a client
  sends, so only Cloudflare can say where a request came from. Tested
  first with a throwaway Caddy, then installed; the previous file is
  kept on the VM.
- The Caddyfile is now in the repo (`infra/pilot/Caddyfile`), installed
  with **`scripts/install-caddyfile.sh`** (back up, validate, reload,
  restore if the reload fails).

### Desktop 0.1.12: where people connect from (ADR-0029)

- **Team** (Managers, and Administrators who have it): each person's
  approximate city on the list, and **Day / Connections** tabs when you
  open someone. HR doesn't get the Connections tab.
- **Settings → Connections** (Administrators): everyone's latest
  connection, for admins without a Team tab.
- **Account menu → Where you connect from**: every employee sees their
  own history.
- **Settings → Rules** (company-wide only): **Record where people
  connect from**, off until the privacy notice has gone out.
- Each list says it's approximate (a VPN or office shows its own
  location), kept 30 days, and credits "IP data by DB-IP".

### Backend: who can see where people connect from (ADR-0029 §5)

- `GET /v1/me/connections`: your own, last 30 days (not audited).
- `GET /v1/team/:employeeId/connections`: a person's history, audited
  as `connections_viewed`.
- `GET /v1/team/connections`: each person's latest, for the Team list.
  Audited at most once an hour per viewer and person, because the list
  refreshes every 30 seconds.
- New capabilities: `admin.connection.read` (Administrator, everyone),
  `team.connection.read` (Manager, direct reports only),
  `self.connection.read` (every employee). **HR and Auditors get none**,
  even with HR's org-wide team view. Outside your scope is 404.
- Every response carries `recording` (whether `connections.record` is
  on) and the CC BY credit "IP data by DB-IP".

### Backend: provider names and the 30-day purge (ADR-0029)

- New connection rows get the **internet provider** and network number
  from DB-IP's free "IP to ASN Lite" file, read on the VM with the
  `maxmind` package (new dependency, MIT). No address leaves the server.
  Missing file: no provider name, retried every 10 minutes. A new
  monthly file is picked up without a restart. Path: `DBIP_ASN_MMDB`
  (default `/opt/cloudpunch/geo/dbip-asn-lite.mmdb`).
- **`scripts/install-connection-jobs.sh`** (run once after deploy)
  installs two systemd timers from `infra/pilot/`: a monthly DB-IP
  download (checked, then swapped in) and a nightly purge of rows over
  30 days old, run as `cloudpunch_migrator` (the app role has no DELETE).

### Backend: record where devices connect from (ADR-0029, off by default)

- Migration **0006** adds `device_connection`: IP, approximate
  city/state/country (Cloudflare's headers), and room for the provider
  (next PR). The app role gets SELECT/INSERT/UPDATE only; the 30-day
  purge will run as the migrator.
- Recorded on event uploads and device enrolment (every launch and
  sign-in). One row per network: IPv4 exact, IPv6 by `/64`.
  Same network: `last_seen_at` moves on at most every 15 minutes.
  Kept in memory per device, so most requests write nothing.
- Location headers are believed only with `cf-ray` (through
  Cloudflare), so not on the office path through Caddy. The server logs
  once whether they arrive, not their values.
- New setting **`connections.record`** (global only, default off).
  Nothing is recorded until it's turned on.

### Privacy notice: where you connect from (ADR-0029)

- New section **"Where you connect from"**: IP address, approximate
  city/state/country and internet provider, worked out on the server
  (never GPS or Wi-Fi names); who sees it (the employee, their manager,
  administrators; every view logged); kept 30 days. Applies only once
  ApTask turns it on.
- "Your physical location or GPS coordinates" in the not-recorded list
  is reworded to "GPS coordinates or exact location".
- ADR-0029 amendment: `maxmind` package for the DB-IP file, IPv6
  compared by `/64`, and a correction (testers arrive from several
  addresses, not one).

### Desktop 0.1.11: account menu in the header

- The header's name and sign-out links wrapped the pin icon onto a
  second line (owner feedback). They're now an **account button** (your
  initials) on the right, opening a menu with your name, sign-in name and
  **Sign out**, or **Clock out and sign out** while clocked in. The
  header stays on one line.

### Release scripts: clearer notes prompt

- `build-windows.ps1` showed "What's new in " with no version
  (PowerShell read `$version?` as a variable name) and stopped on an
  empty first note. Both scripts now ask "Note 1:", "Note 2:"… with the
  version shown, and an empty first note asks again instead of failing.

### Desktop 0.1.10: "Clock out and sign out", and today after signing in again

- **Clock out and sign out** (owner request): while clocked in, the
  header offers it instead of Sign out. It asks first, records a normal
  clock-out, waits for it to reach the server, then signs out.
- **Today comes back after signing in again** (ADR-0016 amendment): the
  app loads today's history from the server when nothing is on screen,
  keeping only the current working day (a night shift stays one day).

### One command per release on each machine

- **`scripts/build-windows.ps1 -Publish`** (new; PowerShell 5.1 and 7)
  and **`scripts/build-mac.sh … --publish`**: ask for the notes, check
  SSH to the VM, build, sign and publish. No more copying files between
  machines; the owner's Mac now has its own SSH key on the VM.
- **`publish-installer.sh`** asks for the notes when none are given, or
  reads them from `CLOUDPUNCH_NOTES` (one per line), so there's no quoting
  across shells. It and `deploy-pilot.sh` are now executable in git.

### Desktop 0.1.9, ADR-0028: one machine at a time

- **Blocked while clocked in elsewhere:** after sign-in and enrolment,
  and on every policy poll, the app asks `GET /v1/me/active-device`. If
  the person is clocked in on another computer, Clock in is replaced by
  "You're clocked in on your other Windows computer / Mac since …" with
  **Check again** and **Sign out**; the tray, the 8 am popup and the
  reminder are held too. Network trouble never blocks (fail open).
- **Signed out by an admin:** an answer of `this_device.signed_out`, or a
  batch refused with `409 device_signed_out`, signs the app out, even
  clocked in, without recording a clock-out (the server already closed
  the session). Unsent events are kept for the next sign-in. The sign-in
  screen says "An admin signed you out of this computer." At start-up
  the app asks before enrolling again, since enrolling clears the mark.
- **No more silent retry of `multi_device_conflict`:** the refused
  session's events are set aside in the outbox (poisoned, never re-sent,
  so they can't add overlapping time later or hold up the outbox), the
  app returns to clocked out without a clock-out event, and shows the
  blocked message.
- **Settings → People → Active machine (Administrators):** OS, clocked
  in since, last activity, and **Sign out of this machine** with a
  confirmation.

### ADR-0028 backend: one machine at a time

- **`GET /v1/me/active-device?device_id=`:** whether the caller is
  clocked in on another of their machines (`elsewhere`), and whether an
  Administrator signed this one out (`this_device.signed_out`).
- **Admin, by employee id (Administrator only):**
  `GET /v1/people/:employeeId/active-device` (the open session's
  machine, or 204) and `POST …/active-device/sign-out` `{device_id}`:
  closes that machine's open session at its last event time
  (`remote_takeover`, flagged as reconstructed), marks the device signed
  out and writes an `audit_log` row (`device_signed_out`).
- **Ingest:** a signed-out device's batches get
  `409 device_signed_out`; `take_over: true` counts only for an
  Administrator, so a second-machine clock-in still gets
  `409 multi_device_conflict`.
- **Enrolment** (after each sign-in) clears the sign-out mark.
- **Migration 0005** adds `device.signout_requested_at` and
  `signout_requested_by`.

### ADR-0028 and ADR-0029 accepted

- **ADR-0028, one machine at a time:** clocked in on one machine blocks
  signing in (and clocking in) on another; only an Administrator can
  sign the person out of the other machine. Replaces the
  `prompt_take_over` default with `deny`.
- **ADR-0029, connection location:** IP, city, state, country and
  provider for each network a device connects from, via Cloudflare's
  location headers and the free DB-IP ASN database. Admins and the
  person's managers see it; kept 30 days; off until employees are told.

### Desktop 0.1.8: false idle ends, and updates for late starters

- **Idle ended a moment after it started (all testers):** the OS
  last-input time is re-read each tick and wobbles by a few ms, which
  counted as coming back. Idle then flickered: zero-length idle, the
  "what were you doing?" popup for a 1 ms stretch, and real idle counted
  as work (76 of 88 idle ends in the pilot were false). Input must now
  be more than 1 s after the mark (`INPUT_JITTER`), for idle and Away.
- **Auto-update held by the clock-in popup (ADR-0022 amendment):** it
  no longer blocks the install, so people who start after 8 am ET get
  updates at sign-in.
- **`update.log`:** each check, download, install and reason to wait.

### Fix: Mac sign-in couldn't save to the keychain (ADR-0007 §5, ADR-0026)

- **Symptom:** on the Mac, sign-in with Microsoft succeeded but the app
  said "Couldn't save your sign-in securely on this computer".
- **Cause:** `keyring` reads an entry's target as the keychain to use on
  macOS, and rejected our Windows-style `CloudPunch/…` targets.
- **Fix:** on macOS, entries are service + account (the ADR-0007 names)
  in the login keychain. Windows is unchanged. A new test makes an entry
  for every slot, so the macOS CI job catches this.
- **`build-mac.sh`:** checks the updater key is one line of base64 before
  building, instead of failing at the end.
- Still 0.1.7: it was never published.

### `scripts/build-mac.sh`: one command for the Mac build (ADR-0026)

- Finds the Developer ID certificate and Team ID in the keychain, checks
  the updater key, Rust targets and packages, asks for the two passwords
  without showing them, then runs the signed, notarized universal build.
- Refuses to run anywhere but macOS (e.g. over SSH on the VM).

### Desktop 0.1.7: the first version on both Windows and macOS

- **Why a bump:** Windows 0.1.6 was built before the macOS work (ADR-0026
  steps 1–5). 0.1.7 is the same code on both platforms, and the first
  Mac release.

### macOS app, steps 4–5: Mac packaging, updates and download (ADR-0026)

- **`tauri.pilot.macos.conf.json`:**
  - `app` and `dmg` targets, macOS 14 minimum, hardened runtime;
  - updater artefacts, with the same updater key as Windows.
- **Signing and notarization** go through Tauri's `APPLE_*` variables.
  `docs/ops/pilot-vm.md` has one-time Mac setup (tools, the Developer ID
  certificate, an app-specific password, the updater key) and the build
  command.
- **Updates:**
  - `GET /v1/desktop/update/darwin/:current` and
    `/files/darwin/:file` serve the signed `.app.tar.gz`, from
    `downloads/macos/releases.json`;
  - Windows is unchanged;
  - the desktop updater asks for `darwin` on macOS.
- **Website:** **Download for Mac** (`/download/mac`, the `.dmg`, behind
  Access) appears next to Windows once a Mac release exists.
- **`scripts/publish-installer.sh --mac`** publishes the `.dmg` and the
  `.app.tar.gz` (as `update_file`), and runs on macOS or Windows.

### macOS app, step 3: mic, camera and call type (ADR-0026)

- **Mic in use:** any *input* device Core Audio reports running
  somewhere. Speakers alone don't count.
- **Camera in use:** from CoreMediaIO.
- **Call type (macOS 14+):** Core Audio's process objects list the apps
  capturing input. Their bundle ids are matched to the ADR-0012
  allowlist and never recorded. `com.microsoft.teams2` and
  `com.microsoft.teams` are Teams, `us.zoom.xos` is Zoom, anything else
  is "other".
- **Ignore list:** apps on it don't count as a call.
- **Allowlist:** the macOS bundle ids are added to the built-in list and
  to the policy default (`idle.call_type_apps`).
- **The macOS poller** reports mic/camera changes through the same pure
  step as lock and network.

### macOS app, step 2: idle, lock, sleep, network, local time (ADR-0026)

- **Idle:** on macOS the core's tick reads CoreGraphics' seconds since the
  last input. Before this, macOS reported "input just now", so idle and
  the presence check never fired.
- **Lock / unlock:** from `CGSessionCopyCurrentDictionary`.
- **Sleep / wake:** from a wall-clock jump.
- **Network:** from `SCNetworkReachability` for the API host.
- **How:** a 1 Hz poller (`watchers/mac_poller.rs`) feeds a pure,
  cross-platform step (`watchers/poll.rs`, tested everywhere).
- **Local time** uses `localtime_r` (it was UTC), and the **login time**
  for the 8 am popup comes from utmpx's console entry.
- **The shared event-handling thread** (network, unlock/wake, mic) now
  serves Windows and macOS.
- **Nothing new is read:** metadata only, and no permission prompts.
  Mic/camera and call type follow in step 3.

### macOS app, step 1: CI (ADR-0026, 2026-09-29)

- **ADR-0026 accepted** (owner):
  - macOS 14+;
  - ApTask's existing Apple Developer account;
  - builds on the owner's Mac;
  - a macOS CI job on every PR.
- **CI:** a new `rust-macos` job builds, lints (clippy `-D warnings`) and
  tests the desktop Rust crate on `macos-latest` (Apple Silicon).

### Away check-in: back at the computer, calls, long aways (ADR-0027, in desktop 0.1.6)

Owner report: Roshni showed "On a phone call" for 2 h 6 min after
answering the idle prompt. While Away, CloudPunch had no end signal, and
it ignored both typing and a Teams call starting.

- **Back at the computer:** about a minute of keyboard or mouse use
  while Away asks **"Welcome back. Still on your phone call?"**.
  - **I'm back** ends the Away from when the typing began.
  - **Still on the call** asks again after 30 more minutes of use.
  - Unanswered for 2 minutes while typing continues, the Away ends on its
    own (`USER_MARK_BACK.ended_by: input`).
- **A call starting while Away** ends it and shows the call (`ended_by:
  call`).
- **A long Away:** a "Still on your phone call?" notification after
  `away.check_after_minutes` (default 60), then every 30 minutes.
- **Records:** the day view says how an Away ended, and Team →
  Exceptions lists long aways.
- **Settings:** Away → "Ask 'Still away?' after (minutes)".
- **The privacy notice** has a section on it.

### Reporting lines warn about a manager without the Manager role (desktop 0.1.6)

- **The problem (owner request):** picking someone as a manager didn't
  give them the Team tab, which needs the Manager (or HR) role.
- **The warning:** Reporting lines now says "Mona Test doesn't have the
  Manager role yet", with a **Give Mona Test the Manager role** button.
  The button keeps their other roles and is audited like any role
  change.
- **Plumbing:** `GET /v1/admin/employees` now includes each person's
  Entra `oid`, to match People's roles.

### Fix: sessions close at the recorded clock-out time (2026-09-29)

- **The bug:** a clock-out closed the session at the time the laptop's
  events reached the server. A laptop that was offline for hours got a
  session that ran on past its real clock-out.
- **The fix:** `USER_CLOCK_OUT`, `PROMPT_TIMEOUT_30S` and the
  integrity-freeze events now close at their own `client_ts`, kept
  within [opened, now], as the idle cap and crash recovery already did.
- **Existing pilot data isn't affected:** all 19 clock-outs so far
  closed within 6 s of their recorded time.

### Presence check for propped keys and mouse jigglers (ADR-0024, in desktop 0.1.5)

- **Detection:** CloudPunch spots either of these from input **timing**
  only (never keys):
  - 20 minutes of input with no 3-second pause (a held key);
  - input at a fixed rhythm for 10 minutes (a jiggler).
- **The check:** it asks **"Are you there?"**. Typing doesn't answer it,
  and it asks at most once every 30 minutes.
- **Unanswered:** the time is idle from when the pattern began. Only
  **I'm back** ends it, and the idle cap still applies.
- **Records:** `INPUT_IDLE_5M` gains `trigger: input_pattern` and
  `pattern`. The day view marks the check (`presence_check`), and Team →
  Exceptions lists answered and unanswered checks.
- **Off by default:** Settings → Idle → "Presence check for propped keys
  and mouse jigglers" (`idle.input_pattern_check`).
- **The privacy notice** has a section on it. Tell employees before
  turning it on.

### Team tab, reporting lines, Versions: desktop 0.1.5 (ADR-0025 PR 2, 2026-09-29)

- **Team** (Managers and HR; a **Team** button in the header):
  - **Today:** each person's status now ("Personal · back by 10:45",
    "In a meeting since 2:10 pm", "late" once a break passes its
    back-by time) and worked time today. It refreshes every 30 s.
  - **A person's day:** tap someone to see their day (on their own
    clock) for the last 30 days, with break types, "Planned 20 min ·
    took 24 min", idle with what they said, and worked / paid / unpaid
    totals. The server audits each day opened.
  - **Exceptions:** the last 7 days of long idle, breaks over plan or
    limit, long shifts, automatic clock-outs and recovered sessions.
- **Settings → People → Reporting lines** (HR and Administrator): choose
  who each person reports to, with an optional reason for the audit log.
- **Settings → Versions** (Administrator): which CloudPunch version each
  computer runs, with anything behind the newest marked.

### Team views, backend (ADR-0025 PR 1, 2026-09-29)

- **`GET /v1/team`** (Team today): each person in the caller's scope with
  live status (working, call, break with type and back-by, away, idle,
  clocked out), since when, and worked time today.
- **`GET /v1/team/:employeeId/days/:date`** and **`?from&to`:** a
  person's day as in `/v1/me/days`, including break type, planned
  minutes, idle explanations, and paid/unpaid totals.
- **`GET /v1/team/exceptions?from&to[&employee_id]`:**
  - long idle (15 min or more, with the person's explanation);
  - breaks over plan or over limit;
  - long shifts;
  - idle clock-outs;
  - reconstructed sessions.
- **Scope, checked server-side on every request:** a Manager sees direct
  reports only, HR sees everyone. Anyone else gets 403; out-of-scope
  people are 404.
- **Read audit:** each opening of someone's day or exceptions writes an
  `audit_log` row (`day_viewed` / `exceptions_viewed`).
- **Reporting lines:**
  - `GET /v1/admin/employees`;
  - `PUT /v1/admin/employees/:id/manager` (HR and Administrator),
    audited `reporting_manager_set`;
  - no self or loops.
- **Versions:** `device.app_version` now follows the version a device
  sends events with (`/v1/admin/devices` shows it).

### ADR-0024 and ADR-0025 (2026-09-29, Accepted)

- **ADR-0024, presence check for propped keys and mouse jigglers:**
  - it spots continuous or strictly periodic input from input timing
    only (never keys);
  - it asks "Are you there?" through the idle prompt
    (`trigger: input_pattern`);
  - if unanswered, the time is idle from when the pattern began, and the
    manager decides;
  - the employee and the manager both see it;
  - off until HR turns it on.
- **ADR-0025, manager team views and reports:**
  - reporting lines set in People;
  - a server-side scope check (a manager sees only direct reports, HR
    sees everyone, 404 outside scope);
  - Team today, a person's day, Exceptions, and App versions;
  - each view of someone's day is audited;
  - a desktop Team tab (this amends ADR-0016).
  - Timesheets and a payroll preview are deferred (owner).

### Privacy notice: break types and planned breaks (ADR-0023 PR 4, 2026-09-29)

- "What CloudPunch records" now includes:
  - the break type (with the names HR sets);
  - the optional "Back in?" time, with the statement that the reason for
    a break is never asked or recorded;
  - the In a meeting / In training tags.
- "Who can see your data" now says the manager sees each break's type,
  and planned vs. actual time.

### Desktop 0.1.4: version on screen, Restart to update (2026-09-29)

Owner request after the first live update test (the update downloaded,
but waited for the next morning because the owner had clocked in that
day).

- **The version** ("CloudPunch 0.1.4") shows at the bottom of the main
  window and in the tray tooltip.
- **Restart to update:** while an update is downloaded and you're
  clocked out, a bar says "CloudPunch 0.1.x is ready" with a button that
  installs now. It isn't offered while clocked in, and the command
  refuses then too. The automatic morning install is unchanged
  (ADR-0022 amendment).
- The tray tooltip shows "Update ready" as soon as the download finishes.

### Break types, screens: desktop 0.1.3 (ADR-0023 PR 3, 2026-09-29)

- **Take a break** replaces the Bio / Meal buttons, in the window, the
  strip and the tray. It opens one picker:
  - the types HR offers, by HR's names;
  - **"Back in?"** (5–60 min, or Not sure), starting on the type's
    limit, so Start is one tap;
  - during a call, the picker also says what happens to the call. This
    replaces the separate "break during a call" dialog.
- The status shows **"Personal · back by 10:45"** for a planned break.
  **In training** sits next to In a meeting when HR offers it.
- **Settings → Breaks (HR and Administrator):** on/off, name, pay rule
  (Paid / Unpaid / Paid up to the limit) and limit for each type. **Away:**
  Offer Training. Save is blocked with every type off or a bad name or
  limit.
- The timeline, dial and status use HR's names. New colours for Tea
  break, Personal and Training.
- The strip's Take a break opens the full window (the picker needs
  room). The tray's "Take a break…" does the same.

### Break types, desktop core (ADR-0023 PR 2, 2026-09-29)

- **Types:**
  - `BreakKind` gains `Rest` (Tea break) and `Personal`;
  - `AwayReason` gains `Training`;
  - the timeline records `rest_break`, `personal_break` and
    `away_training`.
- **"Back in?":**
  - `start_break` takes an optional `planned_minutes`
    (5/10/15/20/30/45/60) and sends it on `USER_START_BREAK`;
  - a **"Back yet? You planned 20 min"** notification fires once at that
    time;
  - the type's limit reminder can still follow;
  - quiet hours mute both.
- **Policy:**
  - the app reads each type's on/off, name and limit;
  - a disabled type, or Training when it's switched off, is refused
    with `option_not_offered`;
  - reminders use the type's own name ("Still on your break?  Tea
    break: 17 min so far").
- **For the screens (PR 3):** the state view carries `breakOptions`,
  `offerTraining` and `plannedBreakMinutes`. The tray and chips are
  unchanged until then.

### Break types, backend (ADR-0023 PR 1, 2026-09-29)

- **Policy schema:**
  - `break.rest` (Tea break), `break.personal` and `break.other`;
  - every type gains `enabled`, `label`, `pay` (`paid` / `unpaid` /
    `paid_up_to_limit`) and `max_minutes` (5–180);
  - `away.offer_training`, and `training` in `require_note` and
    `payable_reasons`;
  - the old `payable_up_to_cap` / `payable` are accepted but ignored.
- **Events:**
  - a new `user-start-break.schema.json`;
  - ingest now **rejects** an unknown `break_kind` or an off-list
    `planned_minutes` (5/10/15/20/30/45/60/null) instead of filing it
    as "other";
  - `USER_MARK_AWAY` accepts `training`.
- **Day view:**
  - new segment kinds `rest_break`, `personal_break` and
    `away_training`;
  - breaks carry `planned_minutes`;
  - totals gain `paid_break_ms` / `unpaid_break_ms`, from the person's
    current policy.
- **Settings save** refuses to turn every break type off.
- Installed apps (0.1.2) ignore the new settings, and their events stay
  valid.

### ADR-0023: break types, planned breaks, break settings (2026-09-29)

Owner request: break categories set from Settings, plus a way to say
"I'll be away 20 minutes".

- **ADR-0023** (Accepted). A fixed list of break types with permanent
  ids:
  - Bio (paid up to 10 min);
  - Meal (unpaid, 60);
  - **Tea break** (new, paid up to 15);
  - **Personal** (new, unpaid, 30);
  - Other (off by default).
- **Training** becomes a work-time Away reason. No Prayer or Medical
  types.
- **"Back in?"** records `planned_minutes`, with a "Back yet?" reminder.
  Managers see the type and planned vs. actual.
- **Paid and unpaid break totals** are calculated on the server.
- **An HR/Admin Settings section** covers on/off, name, pay rule and
  limit.
- `break_kind` is checked at ingest. Implementation follows in small PRs.
- **Docs fix:** the build is signed with `TAURI_SIGNING_PRIVATE_KEY`
  holding the key file's path; Tauri 2.11 has no `_PATH` variable.

### Desktop auto-update at the first sign-in of the day (ADR-0022, 2026-09-29)

Owner request: the app updates itself without losing the day's data,
ideally when people sign in for the day.

- **ADR-0022** (Accepted). An update installs only when clocked out, with
  nothing tracked yet today, just after a Windows sign-in, unlock or wake
  (or app start). Never while clocked in, because the app always comes
  back clocked out after a restart.
- **API:** `GET /v1/desktop/update/windows/:current` returns the newest
  *signed* release as a Tauri update manifest, or 204.
  `GET /v1/desktop/update/files/windows/:file` serves it. Both need the
  app's token. `releases.json` entries gain an optional `signature`.
- **Desktop:** the timing rules (`app_update.rs`) and their agent wiring,
  tested.
- **Phase 2:** `tauri-plugin-updater` (2.12), checked a minute after start
  and every 4 hours with the app's token. The update downloads straight
  away and installs at the safe moment, re-checked just before the
  restart. `requireSignedVersion` blocks downgrades. The tray tooltip
  says when an update is ready. It's on only in builds whose config
  carries the public key (the pilot config).
- **Desktop 0.1.2, the first version that updates itself:** the pilot
  config carries the updater public key (`plugins.updater`, passive
  install, `requireSignedVersion`) and `createUpdaterArtifacts`. Testers
  install 0.1.2 by hand once; later versions arrive on their own.
- **Publishing:** `publish-installer.sh` requires a fresh `.sig` and
  records it in `releases.json`. `docs/ops/pilot-vm.md` covers signing
  the build and the key.

### Fix: agent tests no longer depend on the time of day (2026-09-29)

- The on-the-clock reminder test failed whenever CI ran during quiet
  hours (22:00–07:00). The agent now takes its minute of day from an
  injected clock, and the tests pin it to noon.

### People: welcome emails from noreply@aptask.com (ADR-0021, 2026-09-28)

Owner request: new users are told what to do, with support in the loop.

- **Giving someone Employee in People** offers *Send a welcome email?*,
  with a preview (From ApTask CloudPunch &lt;noreply@aptask.com&gt;, To,
  Cc, Subject) and an optional personal note. There's also a **Send
  welcome email** button for resends.
- **The email covers:**
  - download from https://cloudpunch.aptask.com and the "unknown
    publisher" step;
  - signing in, clocking in, breaks;
  - idle, calls and the 8 am reminder;
  - what CloudPunch records and never records;
  - **"If you run into any issue, email support@aptask.com and the team
    will help you solve it."**
- **Always copied:** support@aptask.com, abdulla@aptask.com and
  nileshd@aptask.com. This is a server setting (`WELCOME_CC`), not code.
- **Sent by CloudPunch itself**, limited by Exchange to the noreply
  mailbox only. It is audited (`welcome_sent`), and a second email to the
  same person within 10 minutes is refused.
- **Backend:** `GET` / `POST /v1/admin/people/:oid/welcome`, and settings
  `WELCOME_FROM`, `WELCOME_CC`, `SUPPORT_EMAIL`, `PUBLIC_SITE_URL`.
- **One-time Exchange setup** is in `docs/ops/pilot-vm.md`.

### Website: logo, Download for Windows, what's new (ADR-0019 §9, 2026-09-28)

Owner request: the setup file online, ApTask only, with every update
showing on the page.

- **`https://cloudpunch.aptask.com`** now shows:
  - the **CloudPunch logo** (reversed in dark mode) and the brand
    favicon;
  - a **Download for Windows** button for the newest release, with its
    version, date, size, and SHA-256 to check the file;
  - **What's new** in that release, and the **earlier versions** with
    their notes.
- **`/download/windows`** serves the newest installer from
  `DOWNLOADS_DIR`. Cloudflare Access on `/download*` limits it to ApTask
  accounts.
- **`scripts/publish-installer.sh`** publishes a build with its notes. It
  refuses dev builds and refuses to re-publish a version with a
  different file, and keeps the newest 3 installers.
- The page is still static and script-free, with a strict CSP (images
  from the same site only).

### Backend: a friendly page at the service address (2026-09-28)

- Opening `https://cloudpunch.aptask.com` in a browser now shows a short
  CloudPunch page ("this is the service behind the app; install the
  app, sign in with your ApTask account"), not a JSON 404. The page is
  static, with no scripts and no data, served with a strict CSP
  (`default-src 'none'`, `frame-ancestors 'none'`).
- `/favicon.ico` answers 204.
### Ops: pilot reachable from anywhere via Cloudflare Tunnel (ADR-0019 §8, 2026-09-28)

- The testers work from home without a VPN. The VM now runs
  `cloudflared` (tunnel **cloudpunch**), which publishes
  **`https://cloudpunch.aptask.com`** → `http://localhost:8080`. It is
  outbound-only, with Cloudflare's public certificate, and no inbound
  port.
- The pilot installer now points at `https://cloudpunch.aptask.com`
  and no longer carries the private CA.
- Checked from the public internet: `/livez` and `/readyz` 200;
  signed-out API calls 401.

### People: assign CloudPunch roles in the app (ADR-0020, 2026-09-28)

Owner request: no Entra portal for day-to-day role changes.

- **Settings → People.** It lists everyone with a CloudPunch role,
  searches the company directory to add someone, and has role
  checkboxes.
  - Giving **Employee** also creates the person's employee record from
    the directory.
  - Changes take effect at their next sign-in.
- **Roles stay in Entra (invariant 6).** People writes Entra app-role
  assignments **on behalf of the signed-in admin** (OBO). Microsoft
  checks their own rights, and the server holds no standing directory
  power.
  - CloudPunch proves its identity with a certificate whose key never
    left the VM.
- **Limits:**
  - Administrators may change any role; HR may give or remove Employee
    and Manager only.
  - No removing your own Administrator role, and never the last
    Administrator.
  - Every change is audited (`audit_log`, `roles_set`).
- **Backend:** `GET /v1/admin/people`, `GET /v1/admin/people/search`,
  `PUT /v1/admin/people/:oid/roles`, and settings
  `ENTRA_OBO_CERT_KEY_PATH` / `ENTRA_OBO_CERT_THUMBPRINT`.
- **One-time Entra setup** (upload the certificate, add two delegated
  Graph permissions and consent, add owners) is in
  `docs/ops/pilot-vm.md`.

### Ops: pilot on the internal VM (ADR-0019, 2026-09-28)

Owner decisions: live testers on the same VM, network admin opened 443,
unsigned installer accepted.

- **Backend.** New `CLOUDPUNCH_ENV=pilot`: it uses `POSTGRES_APP_URL`
  from a root-owned env file and trusts only the local Caddy as proxy.
- **VM:**
  - `cloudpunch-api` systemd service (user `cloudpunch`, 127.0.0.1:8080,
    hardened);
  - Caddy HTTPS on 443 with its own private CA;
  - `ufw` limits 443 to private and VPN ranges;
  - nightly `pg_dump`, kept 14 days;
  - Node 20 from the SHA-256-verified official tarball, pnpm 9.15.0.
- **Desktop.** `backend_http`: the API address comes from the run-time
  env, else a built-in value. A pilot build pins the VM's CA root
  (`CLOUDPUNCH_BUILD_CA_PEM`) for API calls only, never for Microsoft
  sign-in.
- **Installer.** `tauri.pilot.conf.json` builds an unsigned per-user
  NSIS installer.
- `scripts/deploy-pilot.sh` redeploys HEAD with an automatic rollback;
  the runbook is `docs/ops/pilot-vm.md`.

### Desktop: Settings for HR and Administrators (ADR-0018 §5, 2026-09-28)

Owner request: HR / Admin set the idle and clock-in rules without
editing JSON.

- **A Settings gear in the header**, shown only when `GET /v1/me` lists
  `admin.policy.write` or `hr.policy.write`. The server still checks the
  role on every read and save (invariant 6).
- **Scopes:**
  - an **Administrator** edits **Everyone (company-wide)** or any
    department;
  - **HR** edits a department.
- **Fields, in plain units:**
  - idle popup after (minutes);
  - popup wait before logging idle (seconds);
  - clock out after long idle, on/off plus minutes;
  - the daily clock-in popup, on/off, time and zone;
  - "Trip complete" long day (hours);
  - long-shift check (hours).
- The form shows the values **in force** for the scope, checks the
  schema ranges before saving, and keeps any other settings already in
  that override. An optional reason goes into the audit log, and every
  save is audited as before.
- Changes reach each person's app within 15 minutes and apply from
  their next clock-in (ADR-0015 §6).
- **Backend:** new `GET /v1/admin/departments` for the picker. The global
  and department policy reads now also return `effective`, what that
  scope resolves to.

### Desktop: daily clock-in popup, from the computer sign-in time (ADR-0018 §4, 2026-09-28)

Owner request.

- **At 8:00 New York time on weekdays** (`reminders.clock_in_prompt_at`
  / `_tz`, default `08:00` / `America/New_York`; `null` turns it off),
  the window comes forward with **"Time to clock in"**.
  - It follows US daylight saving: 17:30 IST in summer, 18:30 IST in
    winter.
  - It opens only for someone who is at the computer, signed in, and
    not clocked in yet in the current working day.
  - It opens once a day, and later that day if they arrive after 8:00.
- **Start from the computer sign-in.** The popup reads "You signed in to
  your computer at 17:32. Start your day from then?" with **Clock in
  from 17:32**, **Clock in now** and **Not now**.
  - "Signed in" is the latest Windows logon, unlock or wake from sleep,
    since most people never sign out.
  - It is offered only if that time is 1 minute to 12 hours ago and
    after the last session ended.
  - The home screen also shows "or clock in from 17:32, when you signed
    in" under Clock in.
- **It is never an automatic clock-in.** `USER_CLOCK_IN` keeps the click
  as `client_ts` and adds `start_source: os_sign_in` + `started_at`. The
  backend (PR #52) opens the session at that time, within the same
  12-hour bound, and past days mark it `started_from_sign_in` for the
  manager.
- New dependency: `chrono-tz` 0.10 (IANA zone data, owner-approved).

### Idle is logged instead of clocking out (ADR-0018, 2026-09-28)

Owner request, decided before the pilot. **Needs migration 0004**,
which only widens two CHECK lists.

- **The idle popup comes after 2 minutes** (default
  `idle.threshold_seconds` = 120, was 300). HR / Admin can change it.
- **No more 30-second clock-out.**
  - An unanswered popup logs **idle** time, counted from the last
    input. The person stays clocked in.
  - New payroll state `IDLE` and events `IDLE_STARTED`, `IDLE_ENDED`
    and `IDLE_CAP_REACHED`. `PROMPT_TIMEOUT_30S` is still accepted, so
    old history replays the same.
- **Welcome back.** When input returns, the window asks: "You were idle
  13:02–13:25 (23 min). What were you doing?", with an optional note.
  - The answer is sent as `USER_IDLE_EXPLAINED`, an annotation for the
    manager.
  - **Idle stays idle.** The manager decides at timesheet approval.
- **Idle cap.** After 2 hours of continuous idle (`idle.max_idle_minutes`,
  15–480, or `null` to disable) the session closes with
  `closed_reason = idle_cap`. It is dated exactly when the cap was
  reached, even if the laptop slept past it.
- **Clicking anything while idle** (a break, clock out) ends the idle
  first, so the action is never refused.
- **Idle is shown everywhere:**
  - its own pink segment and "Idle since 13:02";
  - the trip meter (Worked / Idle / Breaks / Calls) and the details;
  - the pinned strip;
  - the end-of-day summary, now "8h 12m worked · 45m breaks · 20m idle
    · 3 calls".
- **Past days** (`GET /v1/me/days`) return `idle` segments with their
  explanation, `idle_ms` in totals, and `started_from_sign_in` per
  session.
- **Backend:** `USER_CLOCK_IN` may carry `start_source: os_sign_in` and
  `started_at`. The session then opens at `started_at`, if that is no
  later than the click and at most 12 hours before it. This is groundwork
  for ADR-0018 §4.
- **The idle-cap close uses the event's time.** Other session closes
  still use the time the batch arrives. That's a known gap for
  clock-outs queued offline, flagged for a follow-up.

### Desktop: a break during a call asks first (2026-09-28)

Owner request.

- **Bio or Meal break while on a detected call** asks: "You're on a
  Teams call. Take a bio break anyway? The Teams call so far stays
  counted as a call. If the call is still going when you end the break,
  it counts as a call again." The answers are **Start bio break: I've
  left the call** and **Stay on the call**.
- It asks the same way from all three places:
  - **the window;**
  - **the pinned strip**, inline;
  - **the tray menu**, which brings the window forward and unpins it.
- The question goes away if the call ends while it's showing.
- **Clock out during a call** says so in the "Clock out now?" dialog:
  "You're on a Teams call. Clocking out ends your shift now; the call
  time so far is kept."

### Desktop: end-of-day summary (ADR-0013 §8, 2026-09-28)

Monday UI plan, PR 3. Assumptions confirmed by the project owner.

- **Trip complete.** Clocking out (or signing out) after a long day
  sweeps the dial's needle back to 12 ("engine off"). An odometer rolls
  the worked total up from 00:00, followed by "8h 12m · 3 calls ·
  2 breaks · See you tomorrow".
- **Shorter days** get a quiet card: "Clocked out · 3h 10m · 1 break
  today".
- **Long day is a policy setting:** `reminders.long_day_hours`, default
  8, range 4–16. It reaches the webview as `StateView.longDayMs`.
- Not shown after the idle auto clock-out, which has its own notice.
- Honours `prefers-reduced-motion`. Web Animations API only.

### Desktop: car-dashboard dial (2026-09-28)

Monday UI plan, PR 2, requested by the project owner.

- **Dark glass gauge.** The dial is an instrument cluster, dark in both
  themes. The status shows as an ambient glow: green while working,
  amber on a break, grey when clocked out.
- **Neon arcs.** Today's segments still sit at their real clock times,
  drawn in glowing colours.
- **Seconds ring (owner request).** 60 green LEDs round the rim. One
  lights for each second of the running session, so the ring sweeps
  once a minute in step with the timer, and the whole ring shows at
  each minute mark. The sweep turns amber past 8h worked and red past
  10h. It is dark when clocked out and on past days.
- **Glowing needle** at now. It points in from the rim and never
  crosses the readout. Past days have no needle.
- **Seven-segment timer**, drawn in SVG (no font file). The text stays
  readable to screen readers.
- **Trip meter.** Worked / Calls / Breaks are now glowing readouts in a
  dark panel.

### Desktop: pinned mini strip; minimise pins it (ADR-0017, 2026-09-28)

Requested by the project owner ("stick the app to the desktop when
they minimise the window").

- **Pin to desktop.** A pin button in the header shrinks the window to
  a small always-on-top strip, top-right by default. The strip shows:
  - the status light (amber pulse while the idle prompt waits or on a
    long shift);
  - the live timer;
  - one action: Clock in, End break, I'm back, or Break → Bio / Meal.
  - Hover adds today's worked and break totals, and **In a meeting**
    while clocked in (not during a detected call, as in the full
    window). Clock out stays in the full window, because it asks first.
- **Minimising pins it** while signed in. A pinned strip that gets
  minimised (Show desktop, Win+M) comes straight back.
- **Unpin** with a double-click or ⤢. Sign-out unpins, and closing while
  pinned unpins so the close dialog can ask.
- **Drag to move.** The spot is remembered in `strip.json` (two
  numbers) and dropped if that screen is gone. New permission:
  `core:window:allow-start-dragging`, for the main window only.
- **Small screens.** The full window now grows to about 70% of the
  screen height (at least 560 px). Status and actions stay fixed, and
  the details scroll.
- macOS: the pin button works. Minimise-to-pin is not verified there
  yet.

### Desktop: day picker, and no clock actions on past days (2026-09-28)

Follow-up to ADR-0016, requested by the project owner.

- **Past days are for looking back.** On a past day, Clock in, Clock
  out and the break and meeting buttons are replaced by one
  **Back to today** button. The button also shows the live status
  underneath, for example "Clocked in · 02:14:05". The long-shift
  banner is hidden there too and comes back on today.
- **Day picker.** Tap the date (‹ Today ▾ ›) to open a heat calendar of
  today and the previous 30 days. It has Monday-first week rows, and
  each cell is shaded by hours worked: under 2h, 2–5h, 5–8h, 8h or
  more.
  - Days with nothing tracked are greyed out.
  - Hover or focus shows a tooltip with the hours worked that day and
    a breakdown, e.g. "Tue 22 Sep · 8h 12m worked · 2 sessions · 45m
    breaks · 1h 10m calls", and "Click for details". Empty days say
    "Nothing tracked".
  - The footer sums the period: days worked, total, and average per
    day.
  - A click opens that day with its sessions and totals already
    expanded. Arrow keys move and skip empty days, Enter
    picks, and Escape closes.
  - The ‹ › arrows still step one day at a time.
- **Offline.** The picker shows the range loaded earlier this run.
  With none loaded, every day stays pickable, without shading.
- New agent command `get_days(from, to)` calls
  `GET /v1/me/days?from&to` (at most 31 days). It shares the signed-in
  fetch and the per-user memory cache with `get_day`. Nothing is
  written to disk, and the cache is still emptied at sign-out.

### Desktop: "Today" is the working day, not the date (2026-09-25)

Follow-up to ADR-0016, approved by the project owner.

- **Night shifts stay whole on Today.** Today now shows the current
  working day: sessions each starting within 6 hours of the previous
  one ending. At 01:00, a shift that started at 6:30 pm shows the whole
  evening instead of starting at midnight. The dial, stats, Details and
  "worked today" all follow the same rule.
- **Restart after midnight keeps the shift.** The day journal is read
  from today or yesterday, so a shift saved before midnight comes back
  after a restart. Only the current working day is restored.
- **A new day starts cleanly.** Clocking in more than 6 hours after the
  last clock-out drops the previous day from the screen. Past days
  remain under ‹ ›.
- **"Ready to clock in?" nudge** now waits 6 hours after the last
  clock-out instead of until midnight. A night-shift worker is no longer
  kept from getting the nudge all day. Quiet hours (22:00–07:00 by
  default) still apply.

### Desktop: past days on the dial, and a status-coloured face (2026-09-25)

The desktop half of past-days history (ADR-0016), plus a request from
the project owner.

- **‹ Today ›** above the dial steps back through the previous 30
  days. A past day shows on the dial with the total worked and its
  first and last times ("09:00 – 17:00"). The stats strip and Details
  show that day's sessions and totals. Tap the day name to go back to
  today. Clocking in and out still works from any day.
- **Times on the recording computer's clock.** A day recorded in IST
  reads in IST on an EST laptop, with a note naming the zone. A night
  shift from 6:30 pm to 3:30 am shows as one day. Days that include time
  from another computer say so.
- **Offline.** A day already loaded this run still shows, marked
  "Offline · showing what was loaded earlier". Otherwise the screen
  explains that past days need a connection. Nothing is stored on disk,
  and the copy is cleared at sign-out.
- **Dial face tint:** soft green while clocked in (calls and meetings
  too), amber on a break or at the idle prompt, grey when clocked out.
- New Tauri command `get_day` (`days.rs`: fetch with the user's access
  token, per-user memory cache). New `Recorder::device_id`. The
  `timelineModel` helpers take an optional day start, so a past day is
  never cut at midnight.

### Backend: day history API (ADR-0016) (2026-09-25)

The backend half of past-days history. The desktop screen comes in a
follow-up PR.

- **`GET /v1/me/days/{date}`**: one working day, with each session's
  clock-in and clock-out and the segments the desktop draws (working,
  calls by type, breaks by kind, away, idle prompt), plus totals.
- **`GET /v1/me/days?from=&to=`**: totals for each working day, at most
  31 days per request.
- **Working day rule.** A run of sessions, each starting within 6 hours
  of the previous one ending, dated by its first clock-in on that
  computer's own clock. It never splits at midnight: an IST shift from
  6:30 pm to 3:30 am is one day. Times come back with the offset they
  were recorded with, so an EST machine and an IST machine each show
  their own local times.
- The caller's own data only (`self.timeline.read`), for today and the
  previous 30 days.
- New repo method `timeSessions.findByEmployeeOpenedBetween`, with a
  Postgres integration test.
- Segments are rebuilt from `time_event` using the shared state machine.
  Nothing is stored and there are no migrations.
### ADR-0016: day history (2026-09-25)

- Accepted; the decisions were set by the project owner.
- **A working day is a run of sessions**, each starting within 6 hours of
  the previous one ending. It is dated by its first clock-in, in that
  computer's own time zone, and never split at midnight. A night shift
  of 18:30–03:30 IST, even with a clock-out around midnight, is one
  day. Computers in US
  Eastern and India time file shifts on the right day, independent of
  server or viewer.
- **Times are shown on the clock where the work happened**
  (`client_ts`), labelled when the zone differs from the viewer's.
  `server_ts` is kept for audit and drift checks.
- **API:** `GET /v1/me/days/{date}` (sessions, segments of the kinds the
  desktop already draws, totals) and `GET /v1/me/days?from&to` (daily
  totals). Self only.
- **Look-back:** 30 days. Today stays on the local journal for now.
- Docs only; implementation follows.
### Desktop: "your day on a clock" home screen (2026-09-25)

- **Requested by the project owner:** the home window had become a
  long, generic list.
- **The dial.** The centrepiece is an analog 12-hour clock face with
  today's time drawn as coloured arcs at their real times (working,
  calls, breaks, meetings), a hand at the current time, and an arc that
  grows live. The last 12 hours fill exactly one turn, so arcs never
  overlap; anything older is clipped. The geometry is in
  `dialModel.ts`, pure and tested.
- **The centre** shows the status in colour ("CLOCKED IN", "ON A TEAMS
  CALL", …), the live timer and "since". When clocked out it shows
  "worked today", with the day-aware hint below.
- **Actions.** One green or red pill, and a single row of Bio break ·
  Meal break · In a meeting. On a break or away, the two actions sit
  side by side.
- **Stats strip.** Worked · Calls · Breaks.
- **Details.** The session list and full totals are behind a collapsed
  "Details" toggle, since the dial is the summary.
- The window is compact: tighter spacing and a smaller header.
- **Error boundary.** A screen error now shows "Something went wrong ·
  your time is still being tracked · Reload" instead of a blank window.
- Tests: dial geometry, dial rendering, stats, Details, and the error
  boundary (desktop 73).
### CI: stop cancelling runs on main (2026-09-25)

- **Found by the project owner.** Since the Rust job arrived (#34),
  runs on `main` kept showing "Canceling since a higher priority
  waiting request exists". Each new merge cancelled the previous run,
  so the slow Windows Rust job never finished on `main`.
- **Effect.** An unfinished run never saves the Rust build cache. Every
  run (PRs included) started cold: about 18 minutes instead of about 4.
- **Fix.** Only pull-request runs are cancelled by a newer push; runs on
  `main` always finish and refresh the cache.

### Desktop: clock-out check, smarter clocked-out text, clock-in nudge (2026-09-25)

Three requests from the project owner (ADR-0013 §7).

- **Clock out asks first.** "Clock out now?"
  - While working, it offers **Take a bio break** and **Take a meal
    break** as well as **Yes, clock out** and **Cancel, keep working**.
  - On a break or away, it simply confirms.
  - It covers the main Clock out buttons and the long-shift banner.
- **The clocked-out text knows about the day.**
  - Before any work: "Not clocked in · Ready to start? Clock in when you
    begin work."
  - After working: "Clocked out · 6h 12m worked today · clocked out at
    5:40 pm. Clock in again to continue." It no longer says "start
    tracking your day" once the day has started.
- **"Ready to clock in?" nudge.** A notification when you're signed in,
  using the computer, and haven't clocked in yet today. The first comes
  about a minute in, then every 30 minutes. It never fires once
  anything is tracked today, in quiet hours, or while the window is
  showing.
  - New policy setting `reminders.clock_in_nudge_minutes` (default 30;
    `null` disables).
  - The rule is a pure function in `reminders.rs` with tests.
- 7 new tests (Rust 301, desktop 67).

### Desktop: green Clock in, red Clock out (2026-09-25)

- **Requested by the project owner.**
  - **Clock in** is a solid green button.
  - **Clock out** is solid red where it's the main action, and a red
    outline where another action leads (on a break or away). The same
    goes for the long-shift banner and "Clock out & quit" in the close
    dialog.
- New theme colours (`go` and `stop`, light and dark) and Button
  variants (`go`, `stop`, `stopOutline`).
- A test pins the colours.
### Doc fixes: ADRs match the code (2026-09-25)

- **ADR-0003 transition diagram.**
  - Added `USER_CLOCK_OUT` from `IDLE_PENDING` (both state machines
    already allowed it) and the silent-call idle trigger from `ON_CALL`
    (ADR-0010).
  - Corrected `INPUT_ACTIVITY`, which never leaves `IDLE_PENDING` or
    `AWAY`: it only resets the prompt countdown (ADR-0008).
- **ADR-0004 §5 enrollment.** It uses the normal Entra access token, not
  a separate "enrollment JWT". The agent generates the device id, and
  the employee id comes from `/v1/me`.
- **ADR-0004 §9 payloads.** The examples are now the shapes the agent
  actually sends; the old media example had fields that never existed.
  The schema path is fixed, and the ADR now says plainly that ingest
  doesn't yet validate payloads against the per-type schemas (a
  follow-up).
- **ADR-0012.** Notes that the call-app lists now come from policy
  (ADR-0015 §8).
- **The desktop app is now version 0.1.0** (was 0.0.0) in `Cargo.toml`,
  `tauri.conf.json` and `package.json`. It is sent as `app_version` on
  every event and enrollment.

### CI: Rust is built, linted and tested (2026-09-25)

- **New `rust` CI job on `windows-latest`** (the desktop agent is
  Windows-specific). It builds the desktop frontend (embedded by
  `generate_context!`), then runs `cargo fmt --all --check`,
  `cargo clippy --all-targets -- -D warnings` and `cargo test`, with a
  build cache. CLAUDE.md's "deny warnings in CI" now holds.
- **`rust-toolchain.toml`** pins Rust 1.98.1 for everyone and for CI, so
  a new stable release can't add lints that fail the build unexpectedly.
- **Workspace `rust-version`** is now 1.77.2; Tauri 2.11 needs it, and
  the old 1.75 was stale.
- **Fixed the six pre-existing Clippy findings:** a `3.14` literal in a
  test (a hard error), `while let Ok(_)`, an overindented doc list, and
  a test-only function.
- **One-time `cargo fmt` of the crate** (whitespace only, its own
  commit). Formatting is enforced from now on.
### CI: backend build and real-Postgres integration tests (2026-09-25)

- **The backend production compile works again.** It
  (`pnpm -F @cloudpunch/backend build`) had been failing on
  `declarationMap` without `declaration`. The compile now runs in CI.
- **New `postgres-integration` CI job** (ubuntu, Testcontainers
  Postgres 16). It runs the backend's `*.integration.test.ts`, which had
  never run anywhere: there is no Docker on the dev machine.
- **First run: all 16 `PostgresDb` tests failed.** Their setup deleted
  from `audit_log`, which the append-only trigger rejects, as it should.
  Setup now uses `TRUNCATE`. All pass, including the jsonb payload
  round trip from #27.
- **Known gap.** The compiled server (`node dist/server.js`) doesn't
  start yet, because the workspace packages ship TypeScript source
  (`main: ./src/index.ts`). Running the compiled backend needs a
  bundling step, which is for the deployment (AWS) phase. Dev runs use
  `tsx`.
### CI invariants: no content capture, append-only ledger (2026-09-25)

- **New package `tests/invariants`,** run by `pnpm test` and therefore
  in CI. It implements CLAUDE.md invariants 1 and 2 and ADR-0004 §10
  checks 1 and 2.
- **No content capture.** The build fails if:
  - any event or signed field name matches ADR-0004's banned pattern
    (keystroke, screenshot, clipboard, window_title, app_name, url, …;
    `app_version` and `hostname_hash` are allowed). Names are taken
    from the event schemas, fixtures, canonical field set, backend
    ingest schema, and the keys the desktop's Rust writes;
  - the desktop calls a content-capturing Windows API. These are matched
    as prefixes, so `GetWindowTextW`, `SetWindowsHookExW` and
    `WH_KEYBOARD_LL` are caught;
  - the desktop depends on a capture crate;
  - the webview uses clipboard, screen or media APIs.
- **Append-only.** No migration or production backend code may
  `UPDATE`, `DELETE` or `TRUNCATE` `time_event` or `audit_log`. The
  database triggers already enforce this at run time.
- Every scanner is unit-tested against planted violations. While
  writing them, a gap was found and fixed: whole-word matching would
  have missed the real Win32 names.
- **Docs.** CLAUDE.md now points to the real checks. ADR-0004 §10 gets
  an implementation note.
- **Follow-ups:** the payability property test (needs the server-side
  pay computation) and a dedicated sequence-integrity property test.

### CloudPunch logo everywhere (2026-09-25)

- **Source.** The project owner's logo is saved in `docs/brand/`, with
  the full logo, the mark alone, the app-icon tile, colours (navy
  `#012456`, blue `#018AFE`, teal `#00BFB5`) and usage rules.
- **App icon** (taskbar, Start menu, Alt-Tab, `.exe`): the mark on a
  white rounded tile, so it reads on dark taskbars. Every size was
  regenerated with `tauri icon`.
- **Tray.** The tiled mark with the status colour as a white-ringed dot,
  replacing the plain disc. The status signal is unchanged
  (ADR-0013 §3 note).
- **Main window.** The full logo replaces the text title. The dark theme
  uses the reversed logo (navy parts in white) (`ui/Logo.tsx`).
- **Sign-in screen, redesigned at the owner's request.**
  - No window header while signed out, so the logo appears once.
  - "WELCOME TO" sits centred above the large logo, followed by a
    tagline, a divider, the explanation and the Microsoft button.
  - Three true trust points: single sign-on, encrypted on this device,
    works offline.
  - A brand-gradient bar across the top, card shadow, a soft branded
    backdrop, and a "Secured by Microsoft Entra ID · ApTask" footer.
- **Every logo format** is in `docs/brand/`: full logo, mark and app
  icon at several sizes; reversed, navy and white variants; JPG on
  white and on navy; WebP; `.ico`; and favicons.
- **Browser page after sign-in.** The logo is embedded as a data URI.

### Desktop: today's history survives a quit or restart (2026-09-25)

- **Found by the project owner.** The day's timeline lived only in
  memory, so quitting and restarting emptied it. Outbox rows are
  deleted once sent, so there was nothing to rebuild it from.
- **Outbox v6 `day_timeline`.** One row per user per local day holding
  the serialised segments: the same state and time data the window
  shows. It is encrypted, never sent, and pruned after a week. The
  agent journals the day on every timeline change.
- **On launch**, once the recorder is armed (from the cached identity
  or a fresh enrollment), today's segments are restored while you're
  clocked out and the screen is empty. A live day is never
  overwritten.
- **After a crash**, a segment that was left open closes at the
  recovered session's last heartbeat, matching the server's close
  (ADR-0003 §10). Without a heartbeat it closes at its own start rather
  than inventing time.
- **Bug fixed along the way.** Sign-out now clears the timeline, so the
  next person to sign in doesn't see the previous user's day.
- Past days and other computers remain the server's job
  (`GET /v1/me/days/{date}`, on the roadmap).

### Sign-out never blocks on unsent time (2026-09-25)

- **Requested by the project owner.** The F3c guard ("Some of your time
  hasn't reached CloudPunch yet… sign out again") forced people to stay
  online. It was hit in testing by signing out seconds after clocking
  out, before the 5 s sync pass.
- **Now:**
  - Sign-out gives the sync loop up to 6 s to send what's left.
  - If anything is still unsent, it removes only the sign-in and
    **keeps** that user's device key, outbox key and outbox. The
    events send automatically the next time the same user signs in on
    this computer.
  - The window says "Signed out. N events will be sent the next time
    you sign in on this computer."
  - With nothing unsent, everything is deleted as before.
- **Code.** `sign_out` is now async (the wait runs off the UI thread).
  `AuthManager::sign_out_keeping_device` is new. `AuthStatus` has an
  optional `unsentKept`.
- **Docs.** ADR-0007 §5 gets an implementation note. This replaces F3c
  decision 2.
- **Known limit.** If someone signs out offline and never signs in on
  that computer again, those events stay on it. A server-side flag for
  sessions with no clock-out is a possible follow-up.

### Desktop: policy fetch, cache and apply (ADR-0015, PR C) (2026-09-25)

- **New `policy.rs`.**
  - Parses the settings the agent uses from `GET /v1/me/policy`;
    anything missing or unreadable takes the schema default.
  - Maps them onto `CoreConfig`, `ReminderConfig` and the call-app
    rules.
  - Fetches with `If-None-Match`, splitting errors into retry-later and
    refused.
  - A test pins that the default policy maps to exactly the old
    compiled-in behaviour.
- **Fetch loop** (one per signed-in user):
  - the cached policy is applied at once;
  - a fetch runs immediately, then every 15 min (60 s after a failure);
  - it starts with the sync loop and ends on sign-out, which reverts
    to the defaults.
- **Offline cache.** Outbox v5 adds `policy_cache`, the last policy
  fetched for each user, stored in the encrypted outbox.
- **When changes apply (ADR-0015 §6).**
  - Reminders and quiet hours change immediately.
  - Idle, grace, prompt and note rules and the call-app list are
    adopted only while clocked out: at once, or as soon as the current
    session ends. Only the newest pending policy is kept.
  - `Core::set_config` refuses while clocked in.
- **`USER_CLOCK_IN` carries `payload.policy_version`** once a fetched
  policy is in force. With the defaults the payload is unchanged, so
  the golden fixture still matches.
- **Call-app rules** are now settable (`call_type::Rules`); the
  compiled-in lists are the fallback.
- ADR-0015 gets implementation notes on the idle watcher and on the
  "other" away tag.
- **Verified by the owner on 2026-09-25 against the dev VM.** The
  defaults version was applied and stamped on clock-in. A temporary
  per-employee override (since removed) produced a new version, which
  was fetched, cached and applied, and appeared on the next
  `USER_CLOCK_IN`. A break whose start and end went in separate
  batches was accepted (confirms #27).

### Policy admin API (ADR-0015, PR B) (2026-09-25)

- **Routes.** `GET`, `PUT` and `DELETE` on:
  - `/v1/admin/policy/global`
  - `/v1/admin/policy/departments/:id`
  - `/v1/admin/policy/employees/:id`

  Also `GET /v1/admin/policy/employees/:id/effective`, which shows an
  employee's policy with every layer applied.
- **Permissions.**
  - Global needs `admin.policy.write` (Administrator).
  - Department and employee scopes also accept the new
    `hr.policy.write` (HR), as approved by the project owner.
  - Reads are open to writers and to Auditors (`audit.read.all`).
- **Rules.**
  - Documents are validated against the schema; errors come back as
    `policy_invalid` with the schema issues.
  - Per-employee changes and removals need a reason.
  - Unknown departments and employees give 404.
  - Removing a missing override gives 404 and writes no audit row.
- **Audit (policy doc §14).** Each change writes an `audit_log` row in
  the same transaction: `policy_set` or `policy_clear`, the actor, the
  scope id, `previous_value` and `new_value` as `{scope, document}`,
  the reason and a per-request correlation id.
- New repos: `policies.put` / `policies.remove` (transactional in
  Postgres) and `departments.exists`.
- There is no web UI yet; the API comes first.
- **Verified on the dev DB as the app role:** set, read and clear of a
  global override, with both audit rows correct. The table is empty
  again; the two audit rows remain, since `audit_log` is append-only.

### Policy storage and read API (ADR-0015, PR A) (2026-09-25)

- **Migration 0003** adds `policy_override`: one partial policy
  document per scope (global, department, employee). A reason is
  required for employee scope. Not yet applied to the dev DB.
- **`src/policy/`.**
  - Schema defaults are read from the `default` keywords in
    `idle-policy.schema.json`.
  - Overrides are deep-merged per leaf (objects merge; arrays, scalars
    and `null` replace) and validated with `ajv` 8 in strict mode.
  - The version is `sha256-<hex>` of the canonical JSON.
  - An invalid stored override is an error (`policy_invalid`), never a
    silent fallback to defaults.
- **`GET /v1/me/policy`** returns `{version, policy}` with
  `ETag`/`If-None-Match` → `304`. It returns 404 `no_employee` for
  accounts without an employee record.
- **Schema.** Adds `idle.call_type_apps` and `idle.call_type_ignored`
  (ADR-0015 §8, ADR-0012 follow-up), both documented in the policy doc.
  `@cloudpunch/policy-schema` now exports the schema file.
- **Data.** `Employee.departmentId` is now read (the team scope).
- **Docs.** `docs/ops/env-vars.md` §2.3 is marked superseded; the SSM
  policy paths were never wired.
- Found along the way: `pnpm -F @cloudpunch/backend build` fails on
  main (`declarationMap` without `declaration` in the tsconfig). This
  is not caused by this PR and is tracked under the CI item.
- **Dependency:** `ajv` ^8.17.1, approved. 8.20.0 was already in the
  lockfile through another package.

### Fix: event payloads read back camelCased from Postgres (2026-09-25)

- **The bug.** The Postgres client used `transform: postgres.camel`,
  which also camelCases keys inside json/jsonb values on read. Stored
  payloads (`break_kind`, `in_use`, ...) came back as `breakKind`,
  `inUse`.
- **The effect.** Ingest rebuilds a session's state from its stored
  events, so it stopped recognising them. For example, a
  `USER_END_BREAK` arriving in a later batch than its
  `USER_START_BREAK` was rejected as `state_transition_invalid` and
  poisoned on the desktop. Calls, away tags and idle prompts that
  spanned batches were affected the same way. The in-memory test DB
  doesn't transform, so unit tests missed it; it was found while
  building the policy repo.
- **The fix.** `POSTGRES_TRANSFORM` maps column names only; JSON values
  round-trip unchanged. Verified against the dev DB.
- **Tests.** A new unit test for the transform, and a Postgres
  integration test that a payload round-trips. The integration test
  needs Docker and was not run locally.

### ADR-0015: policy storage, resolution and desktop fetch (2026-09-25)

- Accepted by the project owner. Policy lives in a new
  `policy_override` table of partial documents per scope.
- Resolution merges schema defaults, then global, then department,
  then employee (most specific wins), validated with `ajv`. The
  version is a hash of the content.
- `GET /v1/me/policy` has ETag/304 support. The admin write API is
  audited. HR may write department and employee scopes through a new
  `hr.policy.write`; global stays Administrator-only.
- The desktop fetches after enrollment, at launch and every 15 min,
  and caches the last good policy offline.
- When a change applies: reminders and quiet hours immediately; idle,
  break and away rules at the next clock-in. `USER_CLOCK_IN` carries
  `policy_version`.
- The call-app allowlist moves to `idle.call_type_apps`.
- Docs only in this entry; implementation follows in three PRs.

### Desktop: one running copy (2026-09-25)

- Found during the crash-recovery test: nothing stopped a second copy
  of the app. Two copies meant two tray icons, two sync loops on one
  outbox, and duplicate reminders.
- `tauri-plugin-single-instance` 2.4 (approved by the project owner) is
  registered first. A second launch exits before `setup()`, so it
  never signs in, arms a recorder, or syncs. The running copy's window
  is unminimized, shown and focused instead.
- Lockfile change: only the plugin crate (2.4.5); its dependencies were
  already in the tree.

### Crash recovery for sessions left open (ADR-0003 §10) (2026-09-25)

- **Bug fixed.** A crash or force-quit while clocked in left the
  server session open. The next clock-in then got
  `multi_device_conflict` on the same computer and retried
  indefinitely, so the whole next shift never synced and sign-out
  stayed blocked.
- **Desktop.**
  - Outbox v4 adds `open_session`: the session in progress, tagged
    with the app run's id, with a local heartbeat every 60 s.
  - When the recorder is armed and finds a session left by an earlier
    run, it signs `SESSION_RECOVERED` (`origin=reconstructed`,
    `last_heartbeat_at`, `recovered_at`) into it.
  - The encoder gains `encode_parts` for events the agent writes
    itself. The golden fixture is unchanged.
- **Backend.**
  - `SESSION_RECOVERED` closes the session as
    `system_shutdown_reconstructed` at the heartbeat (clamped to
    `[opened_at, now]`) with `reconstructed=true`.
  - Same-device safety net: a new clock-in closes a stale open session
    on the same device the same way, at its last event time, instead
    of a conflict. Another device still gets `multi_device_conflict`.
  - `TimeSessionRepo.close` takes a `reconstructed` flag.
- **Tests.**
  - Ingest: recovery closes at the heartbeat; the same-device safety
    net; the idle auto-clock-out closes as `idle_auto_clock_out` (this
    was untested); the conflict and take-over tests now use a real
    second device.
  - Recorder: the open-session record, recovery on arming, no recovery
    of the live session.
  - Outbox: the v4 table.
- ADR-0003 §10 gets an implementation note (approved by the project
  owner).
- **Verified by the owner on 2026-09-25:** after a forced crash while
  clocked in, the next launch recovered the session. The server closed
  it at the last heartbeat (15:44:27, not the 15:45:26 restart) as
  `system_shutdown_reconstructed`, with `reconstructed=true`.
- New log lines for sign-out and for a saved sign-in rejected by
  Microsoft.

### Desktop: live sync (2b.4 F3c, PR 2 of 2) (2026-09-25)

- **Batches follow ADR-0014.** Each envelope now carries the
  `correlation_id`, `device_id` and `employee_id` stored on its rows,
  the same on every retry, instead of a new UUID per batch. Rows are
  grouped by session and identity, so rows signed with different IDs
  are never mixed in one batch.
- **Fresh tokens.** The HTTP client asks for a bearer token on every
  batch; the app supplies the signed-in user's access token and
  refreshes it as needed. If the token fails, that batch counts as
  transient and is retried.
- **New `sync/live.rs`.** `LiveSync` starts one sync loop per user:
  - after the recorder is armed, from a fresh enrollment or from the
    cached identity (so an offline launch catches up once back online);
  - on its own connection to the user's outbox;
  - and stops it on sign-out, before the outbox is deleted.
  - The loop's sleep is sliced, so stopping it is prompt.
- **Verified by the owner on 2026-09-25 against the dev VM:** a clock-in and a clock-out reached `time_event` as seq 1 and 2 of one session with one correlation id; the server opened and closed the session (`user_clock_out`).
- **Env-var bootstrap removed.** `SyncBootstrap::from_env`, the six
  `CLOUDPUNCH_*` sync env vars and `start_sync_loop_if_configured` are
  gone. `CLOUDPUNCH_BACKEND_URL` is the only setting left.

### Desktop: signed events into the outbox (2b.4 F3c, PR 1 of 2) (2026-09-25)

- **New `recorder.rs`.** `OutboxSink` replaces the log-only sink in the
  agent's driver. Each event is:
  - signed with the F3a encoder, using the device key and the local
    time zone;
  - given a monotonic ULID and `monotonic_ns`, with `offline_captured`
    taken from the network watcher;
  - written to the user's encrypted outbox (`outbox-<oid>.db` in the
    app data folder).
- **Sessions.**
  - `USER_CLOCK_IN` starts a session with a new `session_id` and
    `correlation_id` (ADR-0014) at sequence number 1.
  - The session ends when the payroll state reaches `Closed`, whether
    by clock-out or automatic clock-out. It is tracked with the same
    transition table as the core and the backend.
- **Recorder modes.**
  - *Armed*: from a fresh enrollment, or from the identity cached in
    the outbox by an earlier one, so offline launches still record.
  - *Log-only*: when `CLOUDPUNCH_BACKEND_URL` is unset (local
    development).
  - *Unarmed*: before either of the above.
- **Outbox schema v3.**
  - Each row now stores `correlation_id`, `device_id` and
    `employee_id` (ADR-0014 implementation note).
  - A new `identity` table holds the cached identity.
  - `busy_timeout` is set to 5 s so the sync loop's connection can
    share the file.
  - Existing v2 files upgrade in place.
- **Approved decisions.**
  - The first-ever clock-in on a machine waits for enrollment (error
    `not_enrolled`: "Connecting to CloudPunch… try again in a moment").
  - Sign-out is refused while events are unsent (error
    `unsynced_events`). On sign-out the outbox is closed and its file
    deleted along with its key.
- **Not yet:** nothing is sent. The live sync loop comes in PR 2, and
  until then sign-out stays blocked once you have clocked in.

### Device visibility: who signs in from where (2026-09-25)

- Requested by the project owner. Every device a user enrolls is
  already a `device` row, and device IDs are per user and per machine,
  so the row count per user is the number of machines they sign in
  from.
- Enrollment now sets `device.last_seen_at`. The agent enrolls on
  every launch and sign-in, and ingest already updated the field.
- New capability `admin.device.read`, held by **Administrator** and
  **Auditor**. It is read-only; Auditor stays write-free.
- New route `GET /v1/admin/devices`. It returns every device with its
  owner's email and name, OS, app version, hostname hash, enrollment
  time, last-seen time and revocation status, plus a per-user summary
  (active devices, total devices, last seen). Public keys are never
  listed.
- New script `pnpm -F @cloudpunch/backend report:devices`: the same
  data as tables, read-only from the dev DB, for use until the web
  dashboard exists.
- Privacy notice: a new "Who can see your data" bullet says
  administrators and auditors can see which computers each person
  signs in from.
- Known gap: reads by administrators are not yet written to
  `audit_log`.

### Local dev API against the dev VM (2b.4 F4 prep) (2026-09-25)

- `server.ts` now wires `PostgresDb` when `POSTGRES_APP_URL` is set, so
  `/v1/me`, `/v1/devices/enroll` and `/v1/events` are served. Before
  this they were never registered outside tests.
- The URL is honoured only with `CLOUDPUNCH_ENV=dev`. Other
  environments ignore it and log a warning. The pool closes when the
  server shuts down.
- New scripts:
  - `dev:local` runs the API with `--env-file=.env.local`.
  - `seed:dev` (`scripts/seed-dev-user.ts`) creates an active
    `local_admin` employee and links the given Entra user to it. It is
    idempotent, dev-only, and accepts only `@aptask.com` addresses.
- The runbook is in `docs/ops/env-vars.md` §5.1.
- **Verified by the owner on 2026-09-25:** after sign-in, `GET /v1/me` and
  `POST /v1/devices/enroll` both returned 200 against the dev VM, and
  the desktop logged "device enrolled".
- Desktop, found during that run:
  - The browser page after sign-in is now a styled result card. On
    success it tries `window.close()` after 1.5 s. Browsers usually
    ignore that for a tab the OS opened, so the page still says it can
    be closed.
  - New log lines for two cases that used to be silent: the silent
    start-up sign-in finding no usable session, and enrollment blocked
    because the hostname can't be read.

### Desktop device enrollment (2b.4 F3b) (2026-09-25)

- New `enroll.rs`. After sign-in and after the silent start-up
  restore, the agent calls `GET /v1/me` for the employee id, then
  `POST /v1/devices/enroll` with the device id, OS, hostname hash,
  public key and app version. It enrols on every launch. The backend
  treats a repeat as a key refresh, so a key lost at sign-out heals
  itself.
- **Device id:** a UUID v4 per user, stored in the keystore at
  `CloudPunch/device-id/<oid>` (`com.cloudpunch.device-id` on macOS).
  It is kept across sign-out. ADR-0007 §5 is amended to add it.
- **`hostname_hash`:** `sha256-<hex>` of the lower-cased hostname,
  unsalted. The owner accepted that it is guessable, and this is
  recorded under residual risks in the threat model. The hostname
  comes from `GetComputerNameExW` on Windows and `gethostname` on
  macOS.
- **Offline-first:** only a definite answer from the server blocks
  clock-in: no user, no employee, clocking not allowed, a revoked
  device, or a device owned by someone else. `clock_in` returns the
  same code, and the main window shows the reason.
- Network errors, 5xx, 401 and 429 are retried in the background
  (30 s, doubling, capped at 15 min). A newer sign-in or a sign-out
  stops a stale attempt.
- New command `enrollment_status` and new event `cp://enrollment`.
- The backend URL comes from `CLOUDPUNCH_BACKEND_URL`. When it is
  unset, enrollment reports `not_configured` and clock-in still works.
- New dependency: `libc` 0.2, macOS only. It was already in the
  lockfile.
- Not wired in yet: the sync loop still reads its identity from env
  vars. F3c switches it to the enrolled identity.

### Desktop signed-event encoder (2b.4 F3a) (2026-09-24)

- New `event/encode.rs` turns a state-machine event into the signed wire
  event the backend ingests. It signs 16 canonical fields with Ed25519,
  including the four that travel on the batch envelope, and adds the
  base64 `integrity_signature`. Timestamps are RFC 3339 with
  milliseconds and the local offset (`chrono`). The zone name comes from
  the OS (`iana-time-zone`) and falls back to `Etc/UTC`.
- New `event/ulid.rs`: a hand-written monotonic ULID generator. Within a
  millisecond, or if the clock steps back, IDs keep increasing.
- **Shared golden fixture** `packages/event-schema/fixtures/signed-events.json`:
  a whole shift of 11 events signed with a fixed test key. The Rust test
  requires the encoder to reproduce it exactly. A backend test
  (`signed-events.fixture.test.ts`) runs the same events through the
  batch schema, signature verification and ingest, and all of them are
  accepted.
- **ADR-0014 (new, Accepted):** one `correlation_id` per session. Today the
  sync loop creates a new one for each batch, so the backend would
  reject every signed event. The fix comes in F3c.
- Dependencies: `chrono` 0.4 (clock and std only) and `iana-time-zone`
  0.1. Both were already in the lockfile through Tauri.
- Not wired in yet: the agent still logs events. The outbox sink and a
  live sync come in F3c.

### Fix: sign-in stuck after closing the browser tab (2026-09-24)

- Found by the project owner: closing the browser mid-sign-in left the
  app waiting up to 5 minutes, and signing in again failed with
  "already in progress".
- A new sign-in now **cancels** the one in progress and opens a fresh
  browser tab (`AuthManager` keeps one cancel flag per attempt; the
  loopback listener checks it while waiting). The replaced attempt ends
  with `cancelled`, which the webview ignores.
- While waiting, the sign-in screen offers **Open the browser again**
  and **Cancel** (new `cancel_sign_in` command). The "busy" error is
  gone.
- Tests: 3 Rust (cancel stops the listener; a second sign-in replaces a
  stuck one; Cancel stops a waiting one), 2 frontend.

### Tray residency and on-the-clock reminders (ADR-0013) (2026-09-24)

- **ADR-0013 (new, Accepted).**
- **Closing the window asks:** clocked in → "You're still clocked in…"
  **Keep running in tray** / **Clock out & quit**; clocked out → **Keep
  running in tray** / **Quit**; "Don't ask again" remembers keep-running
  only (per PC). The tray's **Quit** while clocked in opens the same
  dialog, so the app never exits mid-session. First hide per run shows
  "CloudPunch is still running".
- **Reminders** (`reminders.rs`, pure, on the 1 Hz tick): every 30 min
  while clocked in and hidden; not during calls, the idle prompt, or
  quiet hours (22:00–07:00 local via `GetLocalTime`). Break-cap nudge
  (bio 10 min, meal 60) once per break. **Long-shift check** after 9 h:
  notification + window forward + "still working?" banner (again 2 h
  after **Still working**), even in quiet hours.
- **Live tray status:** coloured status disc drawn in code (green on the
  clock, amber on a break, grey clocked out) and a tooltip ("CloudPunch
  — Clocked in · 2h 30m") refreshed every minute.
- Commands `hide_to_tray`, `quit_app` (refused while clocked in),
  `clock_out_and_quit`, `ack_long_shift`; `cp://close-requested` event.
- Policy: `reminders.on_clock_minutes` (30), `reminders.long_shift_hours`
  (9), `reminders.long_shift_repeat_hours` (2) in the policy schema and
  `idle-policy-defaults.md`. Compiled-in defaults until policy fetch.
- **New dependency (approved):** `tauri-plugin-notification` 2.4
  (notifications sent from Rust only). Lockfile gains 23 entries, mostly
  Linux / macOS back-ends.
- Found: Tauri 2.11 already requires Rust 1.77.2, so the workspace
  `rust-version = "1.75"` is stale — added to doc fixes.
- Tests: Rust 223 (8 scheduler, tray icon/tooltip, agent reminder and
  long-shift tests), desktop 54 (7 new).

### 2b.4 F2 — Microsoft sign-in on the desktop (2026-09-24)

- `apps/desktop/src-tauri/src/auth/` (new), per ADR-0002 §5:
  - `pkce.rs` — S256 verifier/challenge (RFC 7636 vector tested),
    random `state`, authorize URL (`prompt=select_account`).
  - `loopback.rs` — ephemeral `127.0.0.1` (+ `::1`) listener for the
    `http://localhost:<port>` redirect; checks `state`, answers "you can
    close this window", ignores stray requests, 5-minute timeout.
  - `token.rs` — code exchange and refresh via the existing `reqwest`;
    errors surface only the OAuth error code; tokens are never logged
    (`Debug` redacts). The ID token is decoded to read `oid` / name and
    checked for tenant and audience; its signature is **not** verified
    on the device — the backend validates every access token.
  - `AuthManager` — interactive sign-in through the **system browser**;
    silent restore at start-up from the stored refresh token (rotated
    when Entra returns a new one; cleared if rejected); access token in
    memory only, refreshed within 5 minutes of expiry; sign-out deletes
    the refresh token, the current-user pointer, and the F1 device and
    outbox keys (ADR-0007 §5).
- `keystore.rs`: refresh-token slot `CloudPunch/msal/<tenant>/<client>/<oid>`
  and a current-user pointer; `Arc<store>` is a store.
- **Fix found in the owner's first real sign-in:** Windows Credential
  Manager holds at most 2560 bytes per entry (1280 UTF-16 characters),
  and Entra refresh tokens are longer, so saving it failed
  (`keystore`). Long values are now split across `<target>/part<i>`
  entries behind a `cloudpunch-chunked:v1:<n>` header (`Chunked`);
  short values are stored as before. A missing part is an error, never a
  silently truncated token. Verified with a 3000-character value against
  the real Credential Manager.
- **Sign-in screen:** official-style "Sign in with Microsoft" button
  (four-square logo, Segoe UI Semibold 15px, 41px, light / dark per
  Microsoft's branding guidance) on a "Welcome to CloudPunch" card.
- **Name:** "apTask" corrected to **ApTask** across the app (publisher,
  sign-in text), docs, `LICENSE`, and `package.json`.
- Commands `auth_status`, `sign_in` (async, off the UI thread),
  `sign_out` (refused while clocked in: `clock_out_first`); `clock_in`
  refused while signed out (`not_signed_in`); tray "Clock in" opens
  the window when signed out. `cp://auth` carries status changes.
- Home window: sign-in screen until signed in; name and **Sign out**
  (while clocked out) in the header.
- `docs/ops/env-vars.md`: registered tenant / client IDs (ADR-0002
  step F).
- **New dependencies (approved):** `sha2` 0.10 and `url` 2 (both
  already in the lockfile), `open` 5.4 (+ tiny `is-docker`, `is-wsl`).
- Tests: 18 Rust auth tests (full sign-in against a fake browser and a
  mock token endpoint, restore, rotation, revoke, refresh margin,
  sign-out, denial), keystore slot tests, 5 frontend sign-in tests.

### 2b.4 F1 — device secrets in the OS secure store (2026-09-24)

First slice of 2b.4 (sign-in, device keys, signed events). Not wired
into the app yet: F2's sign-in supplies the Entra `oid`.

- `apps/desktop/src-tauri/src/keystore.rs` (new): `Secrets` loads or
  creates, per `oid`, the Ed25519 **device key** and the 32-byte
  **outbox (SQLCipher) key** from the OS CSPRNG, stored base64url in
  Windows Credential Manager / macOS Keychain under ADR-0007 §5 names
  (`CloudPunch/device-key/<oid>`, `CloudPunch/sqlite-key/<oid>`).
  `forget` deletes both (sign-out). The `oid` must be a UUID, so it
  can't inject separators into the target name. A corrupt stored value
  is reported, never silently replaced (that would orphan the outbox).
- **New dependencies (approved):** `keyring` 3.6.3 (`windows-native`,
  `apple-native`; 3.x keeps the Rust 1.75 MSRV, 4.x needs 1.88),
  `getrandom` 0.3 and `base64` 0.22 (both already in the lockfile).
  Lockfile gains keyring, `windows-sys` 0.60 + target shims, and
  macOS-only `security-framework` / `core-foundation`.
- Tests: 8 unit tests on an in-memory store, plus an opt-in round trip
  against the real Credential Manager (passes; leaves nothing behind).

### Call type detection (ADR-0012) (2026-09-24)

- **ADR-0012 (new, Accepted):** the agent classifies the app holding
  the microphone into a category — `teams`, `zoom`, `other` — and
  records only the category on `MEDIA_DEVICE_STATE` (`call_type`).
  Managers and reports see it (project owner's decision; owner
  declined a legal / HR review). Supersedes parts of ADR-0003 §1 / §7,
  ADR-0009 §1, ADR-0011 §1 / §2. `CLAUDE.md` invariant 1 and the
  employee privacy notice updated.
- **Bug fix:** a softphone that keeps the microphone open while idle
  (`ace dialer.exe`) made anyone with it open show as "On a call"
  since #8. Such apps are now on an ignore list (session check and
  consent-store fallback); their calls aren't tracked.
- **Removed:** the manual "On a phone call" tag (home and tray). "In a
  meeting" stays.
- Desktop: `call_type.rs` (allowlist, ignore list, priority),
  `audio_session::active_call_type` (process → category; the exe name
  is never stored or logged); switching app mid-call records the new
  category. Timeline kinds `call_teams` / `call_zoom` / `call_other`;
  status and tray read "On a Teams / Zoom call" or "On a call".
- Backend: `MEDIA_DEVICE_STATE.call_type` optional, known values only,
  only with `in_use: true`; fixture regenerated (198 cases).
- Found: `test/invariants/no-content-capture.ts` referenced by
  `CLAUDE.md` doesn't exist — tracked under the CI item.
- Tests: Rust 179, backend 444, desktop 42.

### Voluntary away tags: In a meeting / On a phone call (ADR-0011 §2) (2026-09-24)

- Home window and tray: **In a meeting** and **On a phone call** tags
  while clocked in (not during a detected call, ADR-0009 §2). "I'm
  back" returns to working. No check-in cap (ADR-0011 §4).
- `packages/event-schema/schemas/user-mark-away.schema.json` (new):
  `{ away_reason: working_away | phone_call | meeting | other, note? }`.
- Backend `USER_MARK_AWAY` now requires a known `away_reason`; still
  `ACTIVE`-only. Shared fixture regenerated (180 cases).
- Desktop core: `AwayReason::Meeting`, `Input::MarkAway { reason, note }`,
  note rules from `away.require_note` (working_away required); new
  `mark_away` command (meeting / phone_call only).
- Tray shows **On a call** during Teams / Zoom calls, **In a meeting**,
  **On a phone call**, or **Working away**.
- Timeline: new `away_meeting` segment (fuchsia); working away moves to
  violet. Calls, meetings, phone calls and working away count as
  **Working** in the totals (per the project owner) and are shown
  separately while they happen; the totals card breaks Working down
  (at the computer / on a call / in a meeting / on a phone call /
  working away).
- Tests: Rust 168, backend 422, desktop 40.

### Fix: migration 0001 could not be applied (2026-09-24)

- `apps/backend/db/migrations/0001_baseline_identity.sql`:
  `employee_override_active_idx` used `WHERE effective_until > now()`;
  Postgres rejects non-`IMMUTABLE` index predicates, so 0001 failed on
  every real database and 0002 could never run. Now a plain index on
  `(employee_id, field_name, effective_until)`; queries still filter
  by `effective_until` at run time.
- One-time exception to the forward-only rule, documented in the
  migrations README: no database had 0001 recorded.
- Found on the first apply to the internal dev VM (`cloudpunch-abd`,
  Postgres 16.15), where 0001 and 0002 now apply cleanly.
- Follow-up (CI item): run the Postgres integration tests in CI.

### Desktop UI — Timeline view + ADR-0011 §1 (2026-09-24)

Redesigned home window, chosen by the project owner: status card
with a live session timer, one primary action with break chips, and
today's timeline with tracked totals. Light and dark follow the OS.
No new dependencies.

- `src-tauri/src/timeline.rs` (new): builds today's segments
  (working / bio, meal, other break / away phone, working / idle
  prompt) from state changes; active and on-call merge into one
  working segment (ADR-0003 §1). `StateView` gains
  `sessionStartedAt` and `timeline`.
- Frontend: `ui/theme.tsx` (tokens, OS light/dark), `ui/Button.tsx`
  (primary / secondary / chip), `timelineModel.ts` (clip to today,
  totals, formatting), `TimelineView.tsx` (day strip + list),
  `useNow`; `App.tsx` rebuilt; the idle prompt uses the same theme.
- Per-kind colours (working, bio / meal / other break, away phone /
  working, idle prompt) with a legend under the day strip; the status
  dot uses the current segment's colour.
- Durations are exact to the second ("42s", "12m 04s", "1h 05m 12s")
  in the list and in a "Today's totals" card: one row per kind plus
  **On the clock**.
- Today's segments are grouped by clock-in session ("Session 2 ·
  14:02 – now · 1h 10m 05s"); the latest session starts expanded,
  earlier ones collapsed. `Segment` / `SegmentView` gain `session`.
- The main window resizes to fit its content (clock in/out, a session
  expanding, a notice): `useFitWindow` measures the page and calls a
  new `fit_window` command, which clamps height to 360 px … screen
  work area and ignores other windows. The page itself gets no window
  permissions.
- **ADR-0011 (new, Accepted):** calls show as their own **On a call**
  segment (rose) and status on the employee's own screen; reports and
  manager views still count them as active (ADR-0003 §1). Also records
  the voluntary "In a meeting" / "On a phone call" tags, no automatic
  meeting detection, and no check-in cap for voluntary away — those
  tags are implemented in the next PR. ADR-0003 status header notes
  the extension.
- Totals are labelled as **tracked on this device**, not paid hours:
  payroll rules (bio cap, unpaid meal, prompt classification) are
  applied server-side.
- Styles stay inline objects: the CSP (`default-src 'self'`) blocks
  the `<style>` tags Vite injects in dev.
- Tests: Rust 161 (9 new), desktop 38 (11 new).

**Known limitation:** the timeline is in memory until the outbox lands
(2b.4 F3); restarting the app starts an empty day. Viewing past days
(date picker) needs server-side history and follows 2b.4.

### Silent-call cap implementation (ADR-0010) (2026-09-24)

While on a call, the idle prompt now appears after 30 minutes with no
keyboard or pointer input. No new dependencies.

- `packages/policy-schema/idle-policy.schema.json`: new
  `idle.max_silent_call_minutes` (integer 15–480 or `null`, default
  30); documented in `docs/policy/idle-policy-defaults.md` §4.
- `packages/event-schema/schemas/input-idle-5m.schema.json` (new):
  optional `trigger` = `input_idle` | `silent_call`.
- Backend `state-machine.ts`: `INPUT_IDLE_5M` checks its trigger —
  `input_idle` (or absent) only from `ACTIVE`, `silent_call` only from
  `ON_CALL`, anything else rejected. Slightly stricter than ADR-0010's
  table, which lists `ON_CALL → IDLE_PENDING` without a guard; stops
  a mislabelled prompt event being recorded.
- Shared fixture regenerated: 162 cases (was 144).
- Desktop `machine`: `CoreConfig.max_silent_call` (default 30 min);
  `Core` tracks when `ON_CALL` was entered and, while on a call,
  emits `INPUT_IDLE_5M {trigger: silent_call}` once
  max(call start, last input) is 30 min old. The normal prompt now
  carries `trigger: input_idle`. Rust mirror updated.
- `docs/architecture/state-machine.md`: new Scenario H.
- Tests: backend 8 new (trigger rules + a fold) plus 18 new fixture
  rows; desktop 9 new (cap timing, input reset, call not dismissing,
  still-working restart, timeout, disabled cap).

Not wired to a real policy source yet: the desktop uses the default
until policy fetch exists.

Refs: ADR-0010, ADR-0009, ADR-0003.

### ADR-0010 — silent-call cap (2026-09-24)

Docs only; the implementation follows in its own PR.

- **ADR-0010 (new, Accepted)** — while `ON_CALL`, show the normal
  idle prompt after `idle.max_silent_call_minutes` with no keyboard or
  pointer input (default **30**, range 15–480, `null` disables),
  measured from the later of entering the call and the last input.
  Reuses `INPUT_IDLE_5M` with payload `{ "trigger": "silent_call" }`;
  `ON_CALL → IDLE_PENDING` becomes legal. The silent call stays
  payable; a timeout ends the session with `closed_at` = prompt shown.
  Bounds walk-away, left-open-meeting, and mic-holding-app cases that
  PR #8's capture-session detection would otherwise leave unbounded.
- ADR-0003 and ADR-0009 status headers note the extension (content
  unchanged).

Refs: ADR-0003, ADR-0008, ADR-0009, ADR-0010.

### Phase 2b.7.2b PR E — mic detection via audio sessions (2026-09-24)

Fixes the PR D smoke-test failure: a Teams call did not dismiss the
idle prompt, because the consent-store registry check never marked
the mic in use during a live, unmuted call.

- `apps/desktop/src-tauri/src/watchers/audio_session.rs` (new):
  `capture_session_active()` — true iff any non-system-sounds session
  on an active capture endpoint is `AudioSessionStateActive`
  (`IAudioSessionManager2`, the primary source in ADR-0003 §7). One
  boolean; never the owning process, name, or audio. COM failures read
  as "not capturing" (fail safe, ADR-0003 §7). Includes an
  `#[ignore]`d live probe that prints counts only.
- `watchers/mic_cam.rs`: new `WindowsMediaState` source — mic =
  capture session active OR consent store; camera = consent store.
  `lib.rs` uses it instead of `WindowsConsentStore`.
- `Cargo.toml`: enables the `Win32_Media_Audio` feature of the
  existing `windows` crate. No new crate; `Cargo.lock` unchanged.
- Verified on the project owner's machine: during a connected Teams
  call on a webcam mic the probe reported one active capture session;
  the consent store reported none.
- Smoke-tested on top of PR D (Windows): clocking in during a call
  enters `ON_CALL` at once; hang-up is recorded after the 5 s
  debounce; a call started while the prompt is showing closes it; Teams
  stays unmuted.

**Risk:** any app holding a capture stream open (voice assistant,
browser tab with mic access, streaming software) now suppresses the
idle prompt while it runs. `idle.suppress_prompt_when_media_active`
can turn suppression off per policy.

**Doc inconsistency (not changed here):** ADR-0004's example
`MEDIA_DEVICE_STATE` payload shows `device_kind` and `detected_via`;
ADR-0009 fixed the payload to `{ in_use }` only.

Refs: ADR-0003 §7, ADR-0009.

### Phase 2b.7.2b PR D — state machine wired into the app (2026-09-24)

The desktop agent now runs the time-state machine for real. Events
still go to the debug log sink; the signed outbox sink lands with
2b.4. No new dependencies.

- `src-tauri/src/agent.rs` (new): `Agent` holds the `Driver` behind
  one lock, shared by commands, tray, watcher drain, and a 1 Hz tick
  thread (last input from `GetLastInputInfo`; off Windows the tick
  reports "input now" so the prompt never fires until 2b.8). UI work
  happens after the lock is released, through a `Ui` trait
  (`TauriUi` in production, a fake in tests):
  - every state change emits `cp://state` and rebuilds the tray menu;
  - `ShowPrompt` opens the `idle-prompt` window (always on top,
    focused, not closable, not minimisable), created only from the
    tick thread because building a window in a sync command
    deadlocks on Windows; `HidePrompt` destroys it;
  - a grace-timeout clock-out brings the main window forward and sets
    `autoClockedOutAt` until the next clock-in.
- `src-tauri/src/commands.rs` (new): `get_state`, `clock_in`,
  `clock_out`, `start_break`, `end_break`, `mark_back`,
  `respond_to_prompt`. Return the new `StateView` or a rejection code;
  all validation is in the core.
- `src-tauri/src/lib.rs`: watcher drain forwards
  `MediaInUseChanged` as `mic || cam` (ADR-0009); prompt window close
  requests are refused (ADR-0008).
- `src-tauri/src/tray.rs`: menu rebuilt per state (clock in; clock
  out / bio break / meal break; end break; I'm back) and routed to the
  agent. New `Away` status. `Take a break` is replaced by bio and
  meal: `other` breaks need attestation (ADR-0003 §6) and aren't
  offered yet.
- `src-tauri/capabilities/default.json` (new): `main` and
  `idle-prompt` get `core:event:allow-listen` / `allow-unlisten`
  only.
- Frontend: `api.ts` + `useAgentState` (new); `App.tsx` renders the
  agent's state (calls show as "Clocked in", ADR-0003 §1) and explains
  an auto clock-out; `PromptWindow.tsx` (new) hosts `IdlePrompt`;
  `main.tsx` routes on window label.
- Tests: Rust 143 (16 new: view mapping, tray items, agent UI calls
  incl. prompt → timeout → main window), frontend 27 (14 new).

**Not verified automatically:** window behaviour (always-on-top,
focus, close blocked, tray menu refresh) needs a manual smoke test on
Windows.

Refs: ADR-0003, ADR-0008, ADR-0009.

### Phase 2b.7.2b PR C — event sink + driver (2026-09-24)

Connects the desktop state machine to a pluggable event destination.
Still not wired into the app (PR D). No new dependencies.

- `apps/desktop/src-tauri/src/machine/sink.rs` (new): `EventSink`
  trait (`record(event, at) -> Result<(), SinkError>`), plus
  `LogSink` (debug-build stderr; logs event type, time and
  state-driving payload only, never the prompt note) and
  `RecordingSink` (in-memory, shared buffer, optional always-fail
  mode for tests).
- `apps/desktop/src-tauri/src/machine/driver.rs` (new): `Driver`
  wraps `Core` + sink. `handle` records each emitted event in order
  and returns only UI effects, plus any sink error and the backlog
  size. A refused event and everything after it stay in an ordered
  backlog, retried before new events on the next `handle` or
  `flush` — events are never dropped or reordered.
- 10 new unit tests (sink ordering, note never logged, backlog replay
  with original timestamps, rejected input records nothing).

**Open for 2b.4:** the backlog is unbounded and in-memory. The real
outbox sink should make `record` durable enough that failures are
rare; what the user sees on a persistent failure is undecided.

Refs: ADR-0003, ADR-0004 §7.

### Phase 2b.7.2b PR B — desktop state machine core (2026-09-24)

Pure Rust state machine for the desktop agent. Not wired to the
watchers, tray, or webview yet (PR D); emits typed events, not signed
wire events (PR C / 2b.4). No new dependencies.

- `apps/desktop/src-tauri/src/machine/` (new):
  - `transitions.rs` — `next_payroll_state`, a Rust mirror of the
    backend `nextState`. The core checks every event against it
    before emitting, so the client never records a transition the
    server would reject.
  - `mod.rs` — `Core::handle(input, now) -> effects`. States:
    clocked out, active, on call, idle pending, on break, away.
    The core owns the idle threshold and the grace countdown, driven
    by a ~1 Hz tick carrying the last-input time: `IdleWatcher` only
    reports the first input after an idle period and can't re-arm
    when a call ends. Input during the prompt pushes the deadline to
    `last_input + grace` (ADR-0008 §2). Mic/cam off is debounced
    5 s; media edges are recorded only when they change state
    (ADR-0009). Prompt notes are trimmed, required for
    `working_away`, capped at 500 chars. Policy values are the
    defaults from `idle-policy-defaults.md` until policy fetch exists.
  - `tests.rs` — 37 unit tests, including a scripted day replaying
    every emitted event through the server mirror.
- `packages/event-schema/fixtures/state-transitions.json` (new): 144
  from-state × event cases, generated from the backend `nextState`
  and checked against ADR-0003/0008/0009. Run by both
  `apps/backend/src/events/state-machine.fixture.test.ts` (new) and
  the Rust `transitions` tests.
- Deferred: CLOCKING_IN/OUT, LOCKED, SLEEPING, OFFLINE_PENDING_SYNC,
  ERROR states; break-cap nudges; manual `USER_MARK_AWAY` (no payload
  schema yet).

**Known gaps (pre-existing, not addressed here):** CI runs no Rust
(`cargo test` / Clippy only run locally), and `cargo clippy -D
warnings` fails on six lints in `sync/mod.rs`, `mic_cam.rs`,
`canonicalize.rs`, and `supervisor.rs`. `cargo fmt` would also
reformat 12 existing files. None of these are touched by this PR.

Refs: ADR-0003, ADR-0008, ADR-0009.

### Phase 2b.7.2b PR A — backend `ON_CALL` state + ADR-0009 (2026-09-24)

Closes the known gap from the ADR-0008 backend follow-up: a call
starting during the idle prompt now leaves `IDLE_PENDING`
server-side.

- **ADR-0009 (new, Accepted)** — `ON_CALL` state and media events.
  `MEDIA_DEVICE_STATE` payload is exactly `{ in_use: boolean }`
  (mic OR camera); a call dismissing the prompt makes the
  prompt-pending interval payable as `ON_CALL`; `USER_MARK_AWAY` is
  rejected from `ON_CALL`; grace-countdown resets emit no event.
- `apps/backend/src/events/state-machine.ts`: `ON_CALL` added to
  `PayrollState`. `MEDIA_DEVICE_STATE` is no longer ambient:
  `in_use=true` moves `ACTIVE` / `IDLE_PENDING` → `ON_CALL`,
  `in_use=false` moves `ON_CALL` → `ACTIVE`, other combinations
  keep state. A missing or non-boolean `in_use` is rejected.
  `USER_START_BREAK` is now also valid from `ON_CALL`.
- `apps/backend/src/events/derive.ts`: `MEDIA_DEVICE_STATE
  {in_use:true}` closes an open idle period with new resolution
  `media_dismiss`. Not persisted anywhere yet; no schema change.
- `packages/event-schema/schemas/media-device-state.schema.json`
  (new).
- ADR-0008 status header notes §3 extended by ADR-0009 (content
  unchanged). `docs/architecture/state-machine.md` updated.
- Tests: `ON_CALL` transitions (positive + negative), malformed
  payloads, call-during-prompt fold, `media_dismiss` derivation.

Refs: ADR-0003, ADR-0008, ADR-0009.

### ADR-0008 backend follow-up + LF line endings (2026-09-24)

- **Backend now implements ADR-0008.**
  - `apps/backend/src/events/state-machine.ts`: `INPUT_ACTIVITY`
    never changes state; from `IDLE_PENDING` it stays
    `IDLE_PENDING` (was `ACTIVE`). The prompt must be answered or
    time out.
  - `apps/backend/src/events/derive.ts`: `INPUT_ACTIVITY` no longer
    closes an open idle period. `IdleResolution` loses
    `input_dismiss` (never persisted; no DB or schema references).
  - Tests updated: flipped state-machine assertion, new
    "answerable after input" test, derive tests + Alice worked
    example now close the idle with a `still_working` response.
- **`.gitattributes` (new):** `* text=auto eol=lf` plus binary
  markers for images/fonts/PDF. Stops Windows clones with
  `core.autocrlf=true` from checking files out as CRLF, which made
  local `pnpm format:check` fail while CI passed. Index was already
  all-LF, so no files are renormalised.

**Known gap (pre-existing, not addressed here):** the backend treats
`MEDIA_DEVICE_STATE` as ambient and has no `ON_CALL` state, so a call
starting during `IDLE_PENDING` doesn't leave `IDLE_PENDING`
server-side as ADR-0003/0008 require. To be picked up with the
desktop state-machine slice.

Refs: ADR-0003, ADR-0008.

### Phase 2b.7.2a — idle prompt component + ADR-0008 (2026-09-24)

First half of 2b.7.2. Fixes a gap in ADR-0003 and adds the idle
prompt as a presentation-only React component. No window, no Rust,
no Tauri commands yet — 2b.7.2b wires it once the desktop state
machine exists.

- **ADR-0008 (new, Accepted)** — input while the idle prompt is
  visible. ADR-0003 had `INPUT_ACTIVITY` in `IDLE_PENDING` dismiss the
  prompt as `ACTIVE`, which made every non-"still working" option
  unreachable (moving the mouse to click one dismissed it first).
  Now: input keeps the prompt up and resets the grace countdown;
  only an explicit response, a call starting, or the timeout leaves
  `IDLE_PENDING`. The prompt-pending interval is classified by the
  response. The Rust core owns the grace timer.
- `docs/architecture/adr/ADR-0003-time-state-machine.md`: status
  header notes §3 amended by ADR-0008. Content unchanged.
- `docs/architecture/state-machine.md`: `IDLE_PENDING` row and
  worked-example row 8 / payable table updated for ADR-0008.
- `apps/desktop/src/IdlePrompt.tsx` (new): `alertdialog` with the six
  `idle.prompt_options`, a required note for `working_away`
  (`noteRequiredFor` prop, 500-char cap from the event schema), and a
  cosmetic countdown driven by a core-supplied `deadline`. Buttons
  disable at zero; the component never auto-responds.
- `apps/desktop/src/IdlePrompt.test.tsx` (new): 13 tests — option
  order/subset, each response, note validation + trimming, Back,
  countdown, deadline reset, expiry. One test reads
  `packages/event-schema/schemas/user-prompt-response.schema.json` and
  fails if the local `PromptResponse` list or note cap drifts.
- Full CI-mirror pass green locally (desktop 17, backend 197,
  event-schema 34, shared 19, contract-greythr 8).

**Follow-ups (ADR-0008 §Consequences)**
- Backend `state-machine.ts`: `INPUT_ACTIVITY` from `IDLE_PENDING`
  must stay `IDLE_PENDING`. Separate PR — backend currently still
  implements the ADR-0003 rule.
- 2b.7.2b: prompt window, Rust-owned grace timer, Tauri capabilities.

Refs: ADR-0003, ADR-0008.

### Phase 2b.7.3 — desktop TS component testing (2026-09-24)

Stands up Vitest + Testing Library for the desktop React UI so the
upcoming idle-prompt and state-machine slices land with tests. Retires
the `--passWithNoTests` workaround from `c3db698`.

- `apps/desktop/vitest.config.ts` (new): jsdom environment,
  `src/**/*.test.{ts,tsx}`, `restoreMocks: true`. Separate from
  `vite.config.ts` so dev-server settings don't leak into tests.
  `@tauri-apps/api` has no IPC bridge under jsdom — mock per test.
- `apps/desktop/src/test/setup.ts` (new): registers jest-dom matchers
  and runs `cleanup()` after each test.
- `apps/desktop/src/App.test.tsx` (new): 4 tests covering the home UI
  transitions (not clocked in → clocked in → on break → clocked in →
  not clocked in) and which actions are offered in each state.
- `apps/desktop/package.json`: `test` is now plain `vitest run`.
  New devDependencies: `jsdom`, `@testing-library/react`,
  `@testing-library/dom`, `@testing-library/user-event`,
  `@testing-library/jest-dom`.
- `eslint.config.js`: test-file rule overrides now also match
  `**/*.test.tsx`.
- Full CI-mirror pass green locally: format:check + lint + typecheck +
  test (desktop 4, backend 197, event-schema 34, shared 19,
  contract-greythr 8).

Refs: ADR-0003.

### Phase 2b.7.1 — tray icon + minimal home UI (2026-09-23)

First sub-slice of 2b.7. Tray icon in the Windows notification area
with a working menu; close-to-tray on the main window. Home UI
rebuilt from the 2b.1 scaffold into a real (if placeholder) React
surface. No backend wiring yet — 2b.7.2 adds the idle-prompt window,
2b.7.3 adds TS testing, and the state-machine slice will plumb
actions through to the outbox.

- `apps/desktop/src-tauri/src/tray.rs` (new):
  - `TrayStateSnapshot` enum (`NotClockedIn` / `ClockedIn` / `OnBreak`).
  - Pure `render_status_label(&state) -> String` — 3 unit tests.
  - `install(&AppHandle)` builds the menu:
    `Status: … | Clock in | Take a break | Show CloudPunch | Quit`.
    Menu handlers log to stderr in debug builds for now; `Show`
    calls `show()+set_focus()` on the main webview; `Quit` calls
    `app.exit(0)`. Right-click-only menu (matches Windows convention).
- `apps/desktop/src-tauri/src/lib.rs`:
  - Registered `pub mod tray;` and called `tray::install` from
    `setup()`.
  - `on_window_event` intercepts `CloseRequested` on the `"main"`
    window and hides instead of closing, so the agent keeps running
    in the tray. Tray's `Quit` is the intended exit path.
- `apps/desktop/src-tauri/Cargo.toml`: `tauri` features gained
  `"tray-icon"`.
- `apps/desktop/src/App.tsx`: rebuilt from the getVersion scaffold
  into a real home UI. Local `useState<ClockState>` drives the
  status card + action buttons. Clicks log to console. Inline
  styles; real design system is a later concern.
- 78 Rust tests pass (3 new tray label tests). Full CI-mirror pass
  green locally: format:check + lint + typecheck + test.

**Not in scope for this slice**
- Tray ↔ app state sync (tray label doesn't update yet).
- Any Tauri command handlers or backend calls.
- Idle-back prompt window (2b.7.2).
- TS component testing setup (2b.7.3 retires `--passWithNoTests`).

Refs: ADR-0003.

### Phase 2b.6.3 — network-awareness + env-var opt-in SyncLoop wiring (2026-09-23)

Third and final sub-slice of 2b.6. The sync loop now pauses draining
when the network watcher reports offline, and can actually run on
Tauri boot when six env vars are set (dev opt-in until slice 2b.4
wires the OS keystore + MSAL).

- `SyncLoop::start` gained `is_online: Arc<AtomicBool>`. Each tick
  checks it — `false` → skip drain and sleep. Prevents burning
  `retry_count` on offline HTTP calls.
- `apps/desktop/src-tauri/src/lib.rs`:
  - `WatchersGuard` now owns `is_online: Arc<AtomicBool>` exposed via
    `is_online()`. The drain thread updates it whenever an
    `OsSignal::NetworkReachabilityChanged { reachable, .. }` arrives.
  - New `SyncLoopGuard` (RAII wrapper) + `start_sync_loop_if_configured`
    that instantiates the loop when `SyncBootstrap::from_env` returns
    `Ok`. `Err` → silent no-op in release, `eprintln!` in debug
    explaining which env var was missing.
  - `run()` wires it: watchers → is_online → sync loop, dropped in
    reverse order (sync first, watchers last — is_online outlives
    sync's consumption of it).
- `sync::SyncBootstrap::from_env()` reads six env vars:
  * `CLOUDPUNCH_BACKEND_URL`
  * `CLOUDPUNCH_BEARER_TOKEN`
  * `CLOUDPUNCH_DEVICE_ID`
  * `CLOUDPUNCH_EMPLOYEE_ID`
  * `CLOUDPUNCH_OUTBOX_PATH`
  * `CLOUDPUNCH_OUTBOX_KEY_HEX` (64 hex chars → 32 bytes)
  Any missing → `Err` with an actionable message. Prod safe-by-default
  (unset env → nothing runs). Env-var path is explicitly dev-only and
  goes away with slice 2b.4.
- 75 tests pass (1 new: `syncloop_skips_when_offline_and_resumes_when_
  online_flips` — verifies zero HTTP calls while offline and prompt
  resumption on the flip).

Sub-series 2b.6 complete. Follow-ups tracked separately:
- MSAL / OS-keystore integration (2b.4) replaces the env-var opt-in
  with real production wiring.
- Enqueue-side `event_body` JSON validation to eliminate the
  defensive-Transient path from 2b.6.2.

Refs: ADR-0003 §OS signals, ADR-0004 §6.

### Phase 2b.6.2 — reqwest-based BackendClient (2026-09-23)

Concrete implementation of `BackendClient` that actually posts to
`POST /v1/events`. Integration-tested against an in-process httpmock
server covering every documented response variant.

- `apps/desktop/src-tauri/src/sync/reqwest_client.rs`:
  `ReqwestBackendClient` with `blocking::Client`, 30 s request
  timeout, `Bearer` auth header. Builds the batch envelope by parsing
  each outbox row's `event_body` as `serde_json::Value` so canonical
  bytes embed as real JSON.
- Status-code → response mapping:
  - 200 → parse `results[]`, one `PerEventResult` per entry
    (`accepted` / `duplicate_noop` / `rejected{code,message}`).
  - 400 → `ValidationFailed`.
  - 403 → `AuthDenied`.
  - 409 → dispatch on body `code`:
    - `device_*` → `DeviceInvalid`.
    - `session_*` → `SessionInvalid`.
    - `multi_device_conflict` → `MultiDeviceConflict` with
      `existing_session_id`, `existing_device_id` from body.
    - anything else → `Transient(unexpected 409 code)`.
  - 5xx / connect error / timeout / body-parse fail → `Transient`.
- Defensive: an outbox row whose `event_body` isn't valid JSON
  returns `Transient("event_body is not valid JSON at {ulid}: ...")`
  without hitting the network. Real fix is enqueue-side validation
  (future slice).
- `Cargo.toml` deps added:
  - `reqwest = { version = "0.12", default-features = false,
      features = ["blocking", "json", "rustls-tls-native-roots"] }`.
    `rustls-tls-native-roots` avoids OpenSSL tangling with SQLCipher.
  - `httpmock = "0.7"` (dev-dep) — blocking-friendly HTTP fixtures.
- 74 tests pass (11 new reqwest integration tests covering every
  response variant + request-body shape assertion + network-error
  path).

Auth is a placeholder Bearer string; real Entra token acquisition
lands with 2b.4 (MSAL PKCE).

Refs: ADR-0004 §6.

### Phase 2b.6.1 — sync loop core + outbox poison migration (2026-09-23)

First sub-slice of the sync loop. Drains the outbox against a mock
BackendClient. Real reqwest client and network-awareness land in
2b.6.2 and 2b.6.3.

**Outbox schema migration (v1 → v2)**
- Added `poisoned INTEGER NOT NULL DEFAULT 0` and `poison_reason TEXT`
  columns.
- New `Outbox::mark_poisoned(event_ulid, reason)` method.
- `Outbox::drain` now excludes poisoned rows.
- `Outbox::poisoned_count()` for diagnostics; `Outbox::get()` still
  returns poisoned rows so audit / debugging can inspect them.
- Schema versioning via `PRAGMA user_version`. Fresh DBs come up at
  v2 directly; hypothetical v1 DBs would `ALTER TABLE` up. No shipped
  users to migrate yet.

**New `sync/` module tree**
- `sync/backoff.rs`: pure `BackoffPolicy::delay(retry_count)`. Default
  ladder: 5s → 15s → 45s → 135s → 300s (cap). No jitter yet; add if
  fleet growth introduces thundering-herd behaviour.
- `sync/client.rs`: `BackendClient` trait + `SessionEnvelope` +
  `SendBatchResponse` enum (7 variants covering the observed
  `POST /v1/events` outcomes). `MockClient` test helper records calls
  and supports arbitrary closure-based responses.
- `sync/mod.rs`: `SyncLoop` (dedicated thread) + pure
  `run_tick(&Outbox, &dyn BackendClient, &SyncConfig)` for direct
  unit testing. `run_tick` drains, groups by `session_id` (preserves
  first-seen order), wraps in envelope with a fresh v4 UUID
  correlation_id, and posts one HTTP call per session.

**Response → outbox action mapping (`apply_response`)**
- `Accepted` per-event: `Accepted`/`DuplicateNoop` → `mark_sent`;
  `Rejected{code,message}` → `mark_poisoned(...)`.
- `ValidationFailed` → poison every event in the sent batch.
- `AuthDenied` → `mark_failed` with `auth_retry` (default 60s).
- `DeviceInvalid` / `SessionInvalid` → poison batch with prefixed
  reason.
- `MultiDeviceConflict` → `mark_failed` with `multi_device_retry`
  (default 300s); UI prompt in 2b.7 handles `take_over`.
- `Transient` → `mark_failed` with `backoff.delay(retry_count)`.

New dep: `uuid = "1"` (feature `v4`) for correlation_id generation.

Verification: 63 tests pass (18 new — 4 backoff + 3 outbox poison +
11 sync).

**Not in this slice** (deferred to 2b.6.2 / 2b.6.3)
- Real reqwest-based `BackendClient` (currently only the mock).
- Entra token; `SyncConfig` carries placeholder device_id/employee_id.
- Network-awareness (pause when offline).
- `SyncLoop` wiring into `run()` — that lands with 2b.6.3.

Refs: ADR-0004 §6 (event ingest), ADR-0004 §7 (outbox pattern).

### Phase 2b.5.6 — supervisor wired into run(); smoke-test tracing (2026-09-23)

- `apps/desktop/src-tauri/src/lib.rs::run()` now starts all five
  Windows watchers on Tauri boot via a new `start_watchers()` fn
  that returns a `WatchersGuard`. Guard's `Drop` calls
  `Supervisor::shutdown()` (joining every watcher thread) then joins
  the drain thread — correct-by-construction shutdown ordering.
- Drain thread `eprintln!`s every `OsSignal`, gated behind
  `#[cfg(debug_assertions)]` so release builds are silent. Replace
  with `tracing` when the state machine actually needs structured
  logs.
- Non-Windows `start_watchers()` returns an inert guard so callers
  don't need conditional bindings. macOS impl lands in 2b.8.
- `Supervisor::take_receiver(&mut self) -> Option<Receiver<OsSignal>>`
  added so the drain thread can own the receiver end without the
  Supervisor keeping a `Sync`-hostile alias. Non-breaking; existing
  `recv` / `recv_timeout` still work until the receiver is taken (and
  panic clearly afterwards).
- 45 tests pass (2 new: `take_receiver_hands_out_the_channel_once`,
  `taken_receiver_still_gets_signals_after_shutdown_closes_channel`).

Smoke-test recipe documented in the commit message.

Refs: ADR-0003 §OS signals, CLAUDE.md invariant 1.

### Phase 2b.5.5 — Windows network reachability watcher (2026-09-23)

Final watcher in the 2b.5 sub-series. All five OS signals from
ADR-0003 now have Windows implementations.

- `apps/desktop/src-tauri/src/watchers/network.rs` (Windows-only):
  polls `INetworkListManager.GetConnectivity()` every 5 s. Reduces
  the returned bitmask to a single boolean:
  `(mask & (NLM_CONNECTIVITY_IPV4_INTERNET
          | NLM_CONNECTIVITY_IPV6_INTERNET)) != 0`. LAN-only, subnet,
  and traffic-only bits do NOT count as reachable.
- Emits `NetworkReachabilityChanged { reachable, at }` only when the
  boolean flips (or on first poll). No SSID, no adapter, no address
  — just up/down.
- COM lifecycle handled on the watcher thread:
  `CoInitializeEx(COINIT_APARTMENTTHREADED)` at start,
  `CoUninitialize` at exit. `INetworkListManager` objects are created
  per-poll and dropped before uninit — no lifetime hazard, no
  reference cycles, no message pump.
- Poll-vs-event-sink decision: `INetworkEvents` sink would be
  event-driven but requires ~4× the code (hand-rolled COM sink with
  `#[implement]`, connection-point advise/unadvise, STA message
  pump, reference-cycle care). The state machine tolerates
  seconds-level latency; the outbox absorbs the gap.
- `ConnectivityProbe` trait behind the COM call lets the poll loop
  be integration-tested against a mock.
- Cargo features added: `Win32_System_Com`,
  `Win32_Networking_NetworkListManager`.
- 43 tests pass (5 new: 4 pure reducer + 1 mocked watcher
  integration).

Follow-ups tracked separately:
  - Wire the supervisor into `lib.rs::run()` so watchers actually
    start when the Tauri app launches (small integration slice).
  - Evaluate a `MessagePumpWatcher` helper to deduplicate
    `session.rs` + `power.rs` (does not apply to idle/mic_cam/network,
    which are simple threads).

Refs: ADR-0003 §OS signals, CLAUDE.md invariant 1.

### Phase 2b.5.4 — Windows mic/cam in-use boolean watcher (2026-09-23)

- `apps/desktop/src-tauri/src/watchers/mic_cam.rs` (Windows-only):
  polls the Capability Access Manager Consent Store every 2 s and
  emits `OsSignal::MediaInUseChanged { mic, cam, at }` only when
  either boolean flips (or on first poll).
- Walks both `HKCU` and `HKLM` under
  `Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{microphone,webcam}\`.
  Recurses one level into the `NonPackaged` subkey (classic Win32
  exes). `LastUsedTimeStop == 0` on any app = device in use.
- **Never records app identity.** The full output of this module per
  poll is two bits. Invariant 1 (no content capture, no per-app
  usage) is shielded at the boundary — the walk sees app subkeys but
  only reads one `REG_QWORD` field and reduces to a boolean.
- Missing consent-store keys (fresh installs) are treated as
  "not in use" — no error.
- `ConsentSource` trait behind the registry walk lets the poll loop
  be integration-tested against a mock without touching the real
  registry.
- New dep: `winreg = "0.52"` (Windows-only; safe wrappers around
  `Reg*W` FFI). Rationale for choosing a small dep over ~150 lines
  of `unsafe` FFI is captured inline in `Cargo.toml`.
- 38 tests pass (4 new: 3 pure reducer + 1 mocked watcher
  integration that verifies emit-only-on-change).

Refs: ADR-0003 §OS signals, CLAUDE.md invariant 1.

### Phase 2b.5.3 — Windows sleep/wake watcher (2026-09-23)

- `apps/desktop/src-tauri/src/watchers/power.rs` (Windows-only):
  `PowerWatcher` runs the same message-only-window pattern used by
  `session.rs`. Subscribes via
  `RegisterSuspendResumeNotification(hwnd, DEVICE_NOTIFY_WINDOW_HANDLE)`
  and dispatches `WM_POWERBROADCAST` codes:
  - `PBT_APMSUSPEND` → `OsSignal::Suspending`
  - `PBT_APMRESUMEAUTOMATIC` and `PBT_APMRESUMESUSPEND` →
    `OsSignal::Resumed` (ADR-0003 doesn't distinguish resume
    flavours, so we don't either).
- `HPOWERNOTIFY` handle stored in a per-thread `Cell<isize>` so the
  pump can `UnregisterSuspendResumeNotification` before destroying
  the window on shutdown.
- `WndProc` returns `TRUE` for handled power messages per the Win32
  contract (so we don't accidentally veto a suspend request).
- Feature flag added: `Win32_System_Power`.
- 34 tests pass (2 new: pure `decode_wparam` for both directions +
  ignored codes).

Deferred: the message-pump structure now duplicates ~70% between
`session.rs` and `power.rs`. A shared helper is on hold until 2b.5.4
(mic/cam poll) and 2b.5.5 (COM network sink) land — the network
watcher won't fit a message-pump helper, so any abstraction may only
cover 2 of 5 watchers.

Refs: ADR-0003 §OS signals, CLAUDE.md invariant 1.

### Phase 2b.5.2 — Windows session lock/unlock watcher (2026-09-23)

- `apps/desktop/src-tauri/src/watchers/session.rs` (Windows-only):
  `SessionWatcher` runs a dedicated thread with a message-only window
  (`HWND_MESSAGE` parent). Subscribes via
  `WTSRegisterSessionNotification(NOTIFY_FOR_THIS_SESSION)` and emits
  `SessionLocked` / `SessionUnlocked` on `WM_WTSSESSION_CHANGE`.
  Other WTS codes (console connect/disconnect, remote logon, session
  logoff, etc.) decode to `None`.
- Class registration guarded by `OnceLock` so multiple watchers in
  the same process can't collide on the window class name.
- `WndProc` looks up the `mpsc::Sender` via a `thread_local!` — the
  pump thread is the same thread that stored the sender, so no
  synchronisation is needed. `WndProc` body is wrapped in
  `catch_unwind` because unwinding across an FFI boundary is UB.
- Startup uses a ready-signal channel so `start()` blocks until the
  pump is live (thread-id captured), preventing a lost-message race
  with an immediate `shutdown()`. Shutdown posts `WM_QUIT` via
  `PostThreadMessageW` and joins.
- Feature flags added: `Win32_Graphics_Gdi` (transitively required by
  `WNDCLASSEXW`), `Win32_System_LibraryLoader`,
  `Win32_System_RemoteDesktop`, `Win32_System_Threading`,
  `Win32_UI_WindowsAndMessaging`.
- 32 tests pass (2 new: pure `decode_wparam` covering both directions
  + a batch that confirms unrelated WTS codes are ignored).

Follow-up (not this slice): `Watcher::start` will likely become
fallible (`Result<Box<dyn WatcherHandle>, WatcherError>`) once
mic/cam + network watchers reveal whether panic-on-init is tolerable
across all watchers. Currently `SessionWatcher` panics with a
descriptive message if window creation or WTS registration fails.

Refs: ADR-0003 §OS signals, CLAUDE.md invariant 1.

### Phase 2b.5.1 — OS watcher plumbing + Windows idle detection (2026-09-23)

First watcher slice per ADR-0003. Cross-platform seam + Windows idle
detection via `GetLastInputInfo`. Session, power, mic/cam, and network
watchers land in 2b.5.2 – 2b.5.5.

- `apps/desktop/src-tauri/src/watchers/mod.rs`: cross-platform `OsSignal`
  enum (idle, session lock/unlock, sleep/wake, mic/cam boolean, network
  reachability) and `Watcher` / `WatcherHandle` traits. Deliberately
  narrow — no app names, window titles, or device identifiers, per
  invariant 1 (no content capture).
- `apps/desktop/src-tauri/src/watchers/supervisor.rs`: mpsc fan-in that
  owns all watcher handles and blocks on shutdown so no signal is lost
  in flight.
- `apps/desktop/src-tauri/src/watchers/idle.rs`
  (`#[cfg(target_os = "windows")]`): `IdleWatcher` polls
  `GetLastInputInfo` / `GetTickCount` and emits `IdleSince` /
  `IdleEnded` on threshold crossing. Threshold-transition logic is a
  pure function tested against synthetic inputs; a `LastInputSource`
  trait lets the poll loop be integration-tested with a mock.
- `Cargo.toml`: added `windows = "0.58"` (target-gated to Windows) with
  features `Win32_Foundation`, `Win32_System_SystemInformation`,
  `Win32_UI_Input_KeyboardAndMouse`.
- 30 tests pass (7 new: 5 pure idle-transition + 2 mocked watcher
  integration + 2 supervisor fan-in and shutdown).
- Known cosmetic: MSVC linker emits `LNK4099` warnings for vendored
  OpenSSL object files (no PDB shipped upstream). Functional impact
  zero.

Refs: ADR-0003 §OS signals, invariant 1 (no content capture).

### Phase 2b.3 — SQLCipher local outbox (2026-09-23)

Encrypted append/drain queue for offline events. On-disk state is
inert without the OS-keystore key (verified by test).

- `apps/desktop/src-tauri/src/outbox.rs`: `Outbox` with
  `open` / `open_in_memory` / `enqueue` / `drain` / `mark_sent` /
  `mark_failed` / `get` / `pending_count`. Idempotent enqueue via
  `INSERT OR IGNORE` on the ULID primary key; drain ordered by
  `(next_retry_at, sequence_number)` so retry-scheduled rows fall to
  the back naturally.
- Single `outbox` table with retry accounting (`retry_count`,
  `next_retry_at`, `last_error`) and index
  `outbox_ready_idx (next_retry_at, sequence_number)`. `event_body`
  and `integrity_signature` stored as opaque BLOBs — no field-level
  introspection on the client.
- SQLCipher key applied via `PRAGMA key = "x'<hex>'"` with a raw
  32-byte key (`CIPHER_KEY_LEN = 32`) — not a passphrase. Matches the
  KDF'd key the OS keystore will supply in 2b.4.
- `rusqlite = { features = ["bundled-sqlcipher-vendored-openssl"] }`
  bundles both SQLCipher and OpenSSL from source, so no system OpenSSL
  install is required on any dev machine. Cold builds compile OpenSSL
  (~5 minutes on Windows; needs Strawberry Perl); incremental builds
  unaffected.
- 21 tests pass — including `on_disk_persists_across_reopens_with_the_
  same_key` and `wrong_key_cannot_open_existing_db` which specifically
  prove encryption at rest.

Deferred to later slices: OS-keystore key fetch (2b.4), retry backoff
policy (2b.6), and `PRAGMA rekey` rotation path (follow-up ADR before
GA).

Refs: ADR-0004 §7, ADR-0007 §5.

### Phase 2b.2 — Rust canonicalize + Ed25519 signing (2026-09-23)

Desktop core produces canonical event bytes byte-for-byte identical to
the backend TS implementation and can sign/verify them with Ed25519.
Cross-language conformance is pinned by a golden vector on both sides —
drift on either side fails both suites.

- `apps/desktop/src-tauri/src/event/canonicalize.rs`: `canonicalize(&Value)`
  and `canonicalize_signed_fields(&SignedEventFields)` (16-field signed
  subset). Object keys sorted lexicographically; integers only with the
  JS safe-int range check (±(2^53−1)); minimal C0 escapes; non-ASCII
  preserved as raw UTF-8.
- `apps/desktop/src-tauri/src/event/signature.rs`: `sign_bytes` /
  `verify_bytes` on `ed25519-dalek` 2.x with `default-features = false` +
  `std`/`fast`/`zeroize`/`rand_core`.
- 11 unit + conformance tests pass, including
  `cross_language_golden_vector_matches_ts`.

Refs: ADR-0004 §5, `packages/event-schema/canonicalization.md`.

### Phase 2b.1 — desktop scaffold: Tauri 2 + React (2026-09-23)

Empty window opens on Windows; the frontend proves the Rust ↔ JS bridge
via `@tauri-apps/api getVersion`. No OS integrations yet.

- Cargo workspace at repo root (`resolver = "2"`, release profile tuned
  for small binaries: `opt-level = "s"`, `lto = true`, `panic = "abort"`,
  `strip = true`).
- `apps/desktop/`: Vite + React 18 UI on port 1420, CSP restricted to
  `'self' ipc: http://ipc.localhost`, `chrome108` build target.
- `apps/desktop/src-tauri/`: Rust crate `cloudpunch-desktop` (lib crate
  types `staticlib`/`cdylib`/`rlib` to reserve future mobile targets),
  420×640 fixed window, identifier `com.aptask.cloudpunch`,
  `bundle.active = false` (installers land in 2b.9).
- Placeholder icon set generated via `tauri icon` (dark-blue "C") for
  all Windows/macOS/iOS/Android sizes so `tauri-build` compiles
  regardless of target.
- Windows dev toolchain confirmed: `cargo check` clean after installing
  VS 2022 Build Tools with the C++ workload; `pnpm typecheck` clean;
  existing `pnpm test` suite (258 tests) still green.

Refs: ADR-0001 §Desktop stack.

### Phase 0 — planning and design (2026-09-23)

No code, dependencies, or cloud resources yet. Documentation-only baseline.

**Repository scaffolding**
- Monorepo layout under `apps/{backend,web,desktop}`, `packages/{shared,event-schema,policy-schema}`, `infra/{terraform,signing}`, `tests/{e2e-web,e2e-desktop,contract-greythr}`.
- Top-level: `.gitignore`, `.editorconfig`, `.nvmrc`, `LICENSE` (proprietary), `README.md`, `CLAUDE.md`, `CHANGELOG.md`.
- Git remote `origin` pointing at `https://github.com/abdaptask/cloudpunch.git`.

**Architecture Decision Records**
- ADR-0001 Tech stack (Node.js + Fastify + Tauri 2 + Aurora Postgres, AWS `ap-south-1`).
- ADR-0002 Microsoft Entra app registrations, App Roles, and SSO flows.
- ADR-0003 Time-tracking state machine (12 states, intelligent-idle, mic/cam detection, auto-clock-out).
- ADR-0004 Event model, idempotent ingest, and integrity metadata (append-only, ULID, Ed25519 device signing).
- ADR-0005 Source-of-truth matrix (`employee.source = local_admin | greythr`) and promotion rules.
- ADR-0006 greytHR integration strategy (adapter interface, API-first with CSV fallback).
- ADR-0007 Secrets, keys, and cryptographic material management.

**Design references**
- `docs/architecture/state-machine.md` — practitioner-facing state diagram + "Alice's Wednesday" worked example.
- `docs/architecture/threat-model.md` — STRIDE-lite, ranked threats, review cadence.

**Integration and policy drafts**
- `docs/integrations/greythr-mapping-rfc.md` — inbound/outbound field tables, pending greytHR API entitlement confirmation.
- `docs/policy/employee-privacy-notice.md` — DPDPA-aware, plain-language, explicit on mic/cam state check.
- `docs/policy/idle-policy-defaults.md` — every configurable idle/break/system knob with defaults and ranges.

**Ops**
- `docs/ops/env-vars.md` — full mapping across env vars, Parameter Store, and Secrets Manager.
- `docs/ops/runbook-outline.md` — 40+ runbook stubs prioritised by phase gate.
