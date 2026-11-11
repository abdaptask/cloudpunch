# ADR-0055 — Tell the manager: a note about one person, with a 14-day follow-up

- **Status:** Accepted (2026-11-11, owner decision: "go ahead with your
  defaults")
- **Deciders:** Abdulla Sheikh (owner)
- **Relates to:** ADR-0047 (insights and nudges), ADR-0040 (day rows),
  ADR-0038 (admin console, change history), ADR-0054 (People table)
- **Confidence:** High for the parts that reuse what's there: the day rows,
  CloudPunch's mailbox, the audit log and the person panel. Medium for the
  follow-up verdict. "Improved", "No change" and "Worse" come from a
  simple comparison, which the owner may want to tune once it's in use.

## Context

A nudge (ADR-0047) goes to the **employee**, with their manager copied,
and only from a finding. The owner wants something else: to tell a
**manager** that one of their people needs attention, for example "keep an
eye on Zuhaib Mir's activity level and timings", without writing to the
person. Today that happens outside CloudPunch, with no record and no
follow-up.

## Decision

1. **Tell manager.** Administrators and HR (`hr.employee.write`) can send
   a note about an active person who has a manager. The button is on:
   - the person's panel in Settings → People, also reachable from a new
     action icon in the table;
   - the person's page in Team;
   - each finding in Insights.

   If the person has no manager, the button is disabled with "Set a
   manager first". Nobody can send a note about themselves, or to
   themselves as the manager.
2. **What is sent.** A message (10–2,000 characters) and one or more
   topics: **Activity level**, **Start and finish times**, **Breaks**
   and **Missed days**. The topics start the draft and choose which
   numbers the follow-up compares.
3. **What the manager gets.** An email from cloudpunch@aptask.com to the
   manager only, with the sender copied. It contains:
   - the message;
   - the person's last 14 days, built from the same day rows as Reports:
     on-time days out of shift days, hours against the shift, idle,
     breaks over their limit, missed days, and one line per day;
   - a link to Team.

   In Team, a banner lists the notes waiting for that manager until they
   click **Seen, I'll follow up**. Only the manager the note was
   addressed to can mark it seen.
4. **The person does not see it.** It is not in My week, the app or any
   `/v1/me` answer. It shows only in the person's change history, which
   HR, Administrators and Auditors already see. The privacy notice
   gains one line: "HR or an Administrator may ask your manager to look
   at your attendance; you can ask HR what was sent."
5. **Follow-up after 14 days.** Each morning from 08:15 India time, after
   the day rows are complete, CloudPunch looks at notes that are 14 days
   old. For each one it compares the person's 14 days before the note
   with the 14 days after, on the chosen topics:
   - Start and finish times: the share of shift days started on time.
   - Activity level: the share of worked time spent idle.
   - Breaks: the number of breaks over their limit.
   - Missed days: shift days without a clock-in.

   A topic counts as better or worse only when it moves by a set margin
   (5 points of a share, or one whole break or missed day). The verdict
   is **Improved** if more topics got better than worse, **Worse** if
   the reverse, and **No change** otherwise. It is emailed to whoever
   sent the note, with the manager copied, and is shown on the note.
   Each follow-up goes once (invariant 4): it is claimed in the same
   transaction as the send, and a failed send undoes the claim.
6. **Storage.** Migration 0024 adds `manager_note`: the note, its topics,
   the 14-day summary when sent, when it was seen and by whom, the
   follow-up date, the verdict and when that was sent. The note itself
   never changes; only seen and follow-up are filled in later. Every step
   writes an `audit_log` row (`manager_note_sent`, `manager_note_seen`,
   `manager_note_followed_up`) about the person, so it shows in their
   Changes.
7. **Endpoints.**
   - `GET /v1/admin/people/:employeeId/manager-notes`: the manager, the
     current 14-day summary and past notes. HR and Administrators.
   - `POST /v1/admin/people/:employeeId/manager-notes {topics, message}`.
   - `GET /v1/team/manager-notes`: the notes addressed to the caller,
     waiting or from the last 30 days.
   - `POST /v1/team/manager-notes/:id/seen`.

## Consequences

- The desktop console needs a new version (0.1.51) for the button and the
  banner. The web dashboard gets both when the server is deployed.
- A manager whose person moves to another manager keeps the note they
  were sent. The new manager doesn't get it.
- Nothing new is collected: the summary uses times CloudPunch already
  records (invariant 1).

## Alternatives considered

- **Reuse the nudge with only the manager as recipient.** A nudge belongs
  to a finding and is meant for the person. This note is about a person,
  with or without a finding.
- **Show the note to the person.** That's more open, but it changes the
  note from a request between managers into a warning. The owner chose
  not to.
- **A Teams post as well.** This needs a Teams bot that can message
  people one-to-one. Left out for now; email and the banner cover it.
