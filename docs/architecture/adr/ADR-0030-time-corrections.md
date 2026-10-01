# ADR-0030 — Time corrections: requested, approved, laid over the record

- **Status:** Accepted (2026-10-01, the owner approved; §3 per the owner's answers)
- **Date:** 2026-10-01
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0004 (immutable events; "a correction is a new row,
  not a mutation"), ADR-0016 (day history), ADR-0018 (idle: "the
  manager decides"), ADR-0025 (team views, audit), ADR-0005/0006 (the
  approval gate and `timesheet_version`, still deferred).
- **Confidence:** High for the storage model (append-only, separate from
  `time_event`). High for the workflow, which the owner set (§3).

## Context

There is no way to fix a wrong day. Two real cases from the pilot:

1. **Roshni, 30 Sept, 17:46–20:43 IST.** Real work, but nothing was
   recorded: there is no session in that window. Time is **missing**.
2. **Roshni, 29 Sept, 21:35–23:41 IST.** She answered "On a phone call"
   at an idle prompt and the away stayed on for 2 h 05 m. The owner says
   this was our bug (before ADR-0027's "Welcome back?" check). Away on a
   phone call counts as worked, so her hours are right, but the day says
   "phone call" and her manager sees a long-away exception. Time is
   **mislabelled**.

The opposite also happens: someone forgets to clock out, and time that
wasn't work is counted. ADR-0018 promised that for idle "the manager
decides", but there is no button for it.

`time_event` can't hold corrections: each row is signed by the device
that recorded it (ADR-0004 §5), and invariant 2 forbids changing it.

## Decision

### 1. A correction is one interval with a new meaning

A correction says: **for this person, from `from` to `to`, the time was
`kind`**, with a reason. The kinds are a fixed list:

| Kind | Counts as | Typical use |
|---|---|---|
| `working` | worked | missing time (case 1); relabel (case 2); accept an idle explanation |
| `away_working` | worked | worked away from the computer |
| a break type (`bio_break`, `meal_break`, …) | per that break's pay rule | forgot to start a break |
| `not_worked` | nothing | forgot to clock out |

One shape covers adding time (outside any session), relabelling time
(inside a session) and removing time (`not_worked`). Calls stay what
was detected; a correction can't invent a Teams or Zoom call.

### 2. Stored apart from the events, append-only

Two new tables (one migration):

- `time_correction`: id, employee, `from`, `to`, kind, reason (required,
  up to 500 characters), requested by, requested at.
- `time_correction_decision`: correction, `endorsed` / `approved` /
  `rejected` / `withdrawn`, decided by, decided at, note.

Neither is ever updated or deleted: database triggers reject it, as for
`time_event` and `audit_log`, and `tests/invariants/` checks for it. A
correction's status is derived: pending until a decision row exists.
Each request and decision is also written to `audit_log`.

### 3. Who does what (the owner's answers, 2026-10-01)

Every correction needs **an Administrator's approval** before it counts.

```
employee asks ──► their manager ──endorse──► an Administrator ──approve──► counts
                       │                            │
                       └──reject                    └──reject
manager corrects a report ──(endorsed already)──► an Administrator ──► …
no manager in CloudPunch:  employee asks ──────────► an Administrator ──► …
```

- **An employee** asks for a correction to their own time
  (`self.correction.request`, which every employee already has).
- **Their manager** endorses or rejects it (`team.correction.review`,
  direct reports only, as in ADR-0025). A manager can also **correct a
  report's time directly**; that counts as endorsed.
- **An Administrator approves or rejects** every endorsed correction,
  with a new capability `admin.correction.approve` (Administrator only).
- **No manager in CloudPunch:** the request goes straight to an
  Administrator.
- **HR has no part for now.** HR keeps `team.correction.review` in the
  role table, but corrections don't use it for HR (the owner may change
  this later).
- **Nobody decides on their own correction.** An Administrator can't
  approve one they asked for or endorsed, so with a single
  Administrator, that person's own corrections need a second one.
- **The requester can withdraw** while it isn't yet approved.

### 4. What it changes

- **Day view and totals** (ADR-0016, ADR-0025) apply approved
  corrections over the derived segments: inside the interval, the
  correction's kind replaces whatever was there; outside a session it
  adds a segment. The totals follow.
- **Nothing is hidden.** A corrected stretch is marked "Corrected", with
  who approved it and why. The original is one tap away. Pending ones
  show as "Correction requested".
- **Exceptions** (ADR-0025) gain "correction pending". An idle or
  long-away exception gets **Accept explanation**, which is a
  one-tap manager correction to `working` for that stretch (ADR-0018's
  "manager decides"). It's a normal correction, so an Administrator
  still approves it (§3). Administrators see a count of corrections
  waiting for them.
- **Overlaps:** a new request may not overlap a pending one for the same
  person. If two approved corrections overlap, the later-approved one
  wins in the overlap, so a mistake is fixed with another correction,
  never by editing.

### 5. Limits

- Within the last **30 days** (the day-history window), never in the
  future, at most **16 hours** per correction.
- `from` and `to` are times on the person's working day (ADR-0016 §1),
  shown in their own time zone.
- Corrections change CloudPunch's view only. Nothing goes to greytHR yet
  (still deferred). When timesheets and export land, approved corrections
  feed `timesheet_version`; a correction after a week is locked or
  exported creates version n+1, as ADR-0006 already plans.

### 6. Screens and cost

- **Desktop:** on your own day, **Fix this time** on a stretch, or
  **Add missing time** for a gap; Team → person → day for managers
  (approve, reject, propose); Exceptions shows pending ones.
- **Notifications:** in the app only (a count on Team; the employee sees
  the decision on their day). No email, so nothing to pay for; the
  welcome-email path (ADR-0021) could carry it later.

## Consequences

- **Positive:**
  - Wrong days can be fixed without touching the signed event record.
  - Every correction is visible to the employee and their manager,
    approved by someone else, and audited.
  - It closes ADR-0018's promise that the manager decides on idle.
- **Negative:**
  - Totals are no longer a pure function of events: they need the
    approved corrections too. Every place that totals time must use the
    same overlay (one shared function, tested against both cases above).
  - An Administrator must approve every correction, so the pilot has
    one approver; a second Administrator is needed for that person's own
    corrections.
  - The privacy notice already describes corrections ("Request
    correction"; "the original record is never deleted"); it needs only
    the desktop wording, not new data.

## Alternatives considered

- **Corrections as `time_event` rows** (`origin = reconstructed`,
  `manual_correction`): no device signs them, and they'd mix human
  edits into the device record. Rejected.
- **Editing sessions in place:** breaks invariant 2. Rejected.
- **Manager edits with no approval step:** fastest, but one person could
  change anyone's hours unseen. Rejected: an Administrator approves.
- **HR as approver:** proposed; the owner chose Administrators for now.
- **A web dashboard first:** there's no web app yet (apps/web is empty);
  the desktop is where managers already work.

## Decided (2026-10-01)

1. A manager can correct a report's time; **an Administrator must
   approve** it.
2. No manager in CloudPunch: **an Administrator approves**.
3. HR approves nothing for now; may change later (a new ADR or an
   amendment).
4. Administrators approve (`admin.correction.approve`), never their own.
5. Roshni's two days are the first real use once this ships:
   30 Sept 17:46–20:43 `working`, and 29 Sept 21:35:53–23:41:15
   `working` (same hours; clears the long-away flag).
