# ADR-0043 — Faster alerts, and posts in a Teams channel

- **Status:** Accepted (2026-10-14, the owner chose: email to
  Administrators plus a Teams channel; Teams notices as channel posts)
- **Date:** 2026-10-14
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0035 (server health check every 5 minutes, alert
  emails, GitHub uptime check every 15 minutes), ADR-0037 (shift-start
  emails), ADR-0030 (corrections), ADR-0040 §3.4 (refused uploads).
- **Confidence:** High for the checks and the email. Medium for Teams:
  Microsoft is moving channel webhooks from Office 365 connectors to
  Workflows; both accept the Adaptive Card message used here.

## Context

The owner asked (2026-10-13) for uptime and error alerts, and for
notices in team chat alongside email. Today:

- The server checks itself every **5 minutes** (API, database, disk)
  and emails `ALERT_TO`; GitHub checks from outside every **15
  minutes** and emails whoever owns the schedule.
- Nobody hears when uploads start failing (a computer with a wrong
  clock, ADR-0040 §3.4) or when a background job (shift-start emails,
  day-end summary) keeps failing; both only reach the server log.
- Missed starts and corrections waiting go by email only.

Owner's answers (2026-10-14): alerts by **email to Administrators and a
post in a Teams channel**; notices as **channel posts** (incoming
webhooks, no new Entra permissions).

## Decision

### 1. Uptime: every minute, two failures before anyone hears

- The server's health check runs **every minute** (was 5). It checks
  the API on the server, the site **from the internet side** too
  (`https://cloudpunch.aptask.com/readyz`, through the Cloudflare
  Tunnel), the database and the disk.
- A problem must fail **two checks in a row** before an alert; one
  message when it starts and one when it's fixed, nothing in between.
- The alert goes by **email** (`ALERT_TO`, sent with CloudPunch's own
  Graph credentials, so it works while the API is down) and to the
  **Teams channel** (`TEAMS_ALERT_WEBHOOK_URL`). Either one reaching
  you is enough; a failure of one doesn't stop the other.
- The **whole server** being down can't be seen from inside it: the
  GitHub check (every 15 minutes, from outside) also posts to the Teams
  channel, from a repository secret.

### 2. Errors inside the API

The API watches itself and alerts Administrators (the roles they were
last seen with, ADR-0037) by email and the Teams channel:

- **Uploads refused**: 50 or more events refused in 15 minutes.
- **Server errors**: 20 or more `5xx` answers in 15 minutes.
- **A background job failing**: the shift-start emails or the day-end
  summary failing **3 times in a row**, and once when it works again.

Each kind alerts **at most once an hour**. The counts live in memory
(they restart with the server); nothing about them is stored.

### 3. Notices in a Teams channel

When `TEAMS_NOTICE_WEBHOOK_URL` is set and **`alerts.teams_posts`** is
on (company-wide, off by default, Rules → Shift-start emails):

- Each **shift-start email** (missed clock-in, late clock-in, "not
  working today", ADR-0037 §3) is also posted to the channel, after the
  email is claimed (so once, invariant 4).
- Once a day at **10:00 India time**, **corrections waiting** are
  posted, grouped by who has to act: each manager for the ones they
  must endorse, Administrators for the ones to approve. Claimed in
  `report_sent` (`report = 'teams_corrections'`), so once a day even
  with retries or two servers. Migration 0020 adds that report kind.
- Posts carry names, times and counts only, as the emails do; never
  idle explanations, notes or locations (invariant 1).
- A post that fails is logged and doesn't stop the email.

### 4. Settings

| Where | Name | What |
|---|---|---|
| `/etc/cloudpunch/alert.env` | `TEAMS_ALERT_WEBHOOK_URL` | uptime alerts from the server's check |
| `/etc/cloudpunch/api.env` | `TEAMS_ALERT_WEBHOOK_URL` | the API's error alerts (same URL) |
| `/etc/cloudpunch/api.env` | `TEAMS_NOTICE_WEBHOOK_URL` | missed starts, corrections waiting |
| GitHub secret | `TEAMS_ALERT_WEBHOOK_URL` | the outside uptime check |

The two URLs may be the same channel. Unset means off.

## Consequences

- Downtime is noticed in about 2 minutes instead of 5–15.
- Wrong clocks and failing jobs reach the owner the same hour.
- Managers who live in Teams see missed starts without opening email.
- A webhook URL lets anyone who has it post to that channel; it's kept
  in the server's settings files and a GitHub secret, never in the code.
- The alert counters forget on restart; a restart mid-incident can
  delay an API alert by up to 15 minutes.

## Alternatives considered

- **An external uptime service** (Better Uptime, UptimeRobot): another
  account and vendor; GitHub plus the server's own check covers it.
- **Personal Teams messages** from a bot: needs a Teams app and Graph
  permissions; not chosen.
- **Storing alert counters in the database:** more writes for a pilot
  of 60 people; in memory is enough.

## Plan

One PR: this ADR, the health check (every minute, two failures, the
public URL, Teams), the GitHub check posting to Teams, the API monitor,
the channel notices, the setting, migration 0020. Then the owner
creates the webhook(s) and the install steps in
`docs/ops/pilot-vm.md` are run.
