# ADR-0030 — Time corrections: requested, approved, laid over the record

- **Status:** Proposed (2026-10-01)
- **Date:** 2026-10-01
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0004 (immutable events; "a correction is a new row,
  not a mutation"), ADR-0016 (day history), ADR-0018 (idle: "the
  manager decides"), ADR-0025 (team views, audit), ADR-0005/0006 (the
  approval gate and `timesheet_version`, still deferred).
- **Confidence:** High for the storage model (append-only, separate from
  `time_event`). Medium for the workflow details marked as open
  questions, which are the owner's calls.

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
- `time_correction_decision`: correction, `approved` / `rejected` /
  `withdrawn`, decided by, decided at, note.

Neither is ever updated or deleted: database triggers reject it, as for
`time_event` and `audit_log`, and `tests/invariants/` checks for it. A
correction's status is derived: pending until a decision row exists.
Each request and decision is also written to `audit_log`.

### 3. Who does what

- **An employee** asks for a correction to their own time
  (`self.correction.request`, which every employee already has).
- **Their manager, or HR,** approves or rejects it
  (`team.correction.review`, which Manager and HR already have). A
  Manager only for direct reports, as in ADR-0025.
- **Nobody approves their own.** A manager's own correction goes to
  their manager or to HR.
- **The requester can withdraw** while it's pending.
- **A manager can propose a correction** for a direct report. The
  report sees it on their day, and it then needs a second person to
  approve: HR, or the manager's own manager. *(Open question 1.)*

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
  "manager decides"). It's still recorded as a correction.
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
  - Two people are needed for every correction, which is slower in a
    3-person pilot. *(Open question 1.)*
  - The privacy notice already describes corrections ("Request
    correction"; "the original record is never deleted"); it needs only
    the desktop wording, not new data.

## Alternatives considered

- **Corrections as `time_event` rows** (`origin = reconstructed`,
  `manual_correction`): no device signs them, and they'd mix human
  edits into the device record. Rejected.
- **Editing sessions in place:** breaks invariant 2. Rejected.
- **Manager edits with no approval step:** fastest, but one person could
  change anyone's hours unseen. Rejected; the open question below is
  the compromise.
- **A web dashboard first:** there's no web app yet (apps/web is empty);
  the desktop is where managers already work.

## Open questions for the owner

1. **Can a manager's correction apply at once** (still visible to the
   employee and audited), or must a second person always approve? In a
   3-person pilot, "at once" is far more practical.
2. **Who approves for someone with no manager in CloudPunch?** Proposed:
   HR.
3. **Does HR approve for everyone, or only when there's no manager?**
4. **Should Administrators approve too?** Today they don't have
   `team.correction.review`. Proposed: no, to keep config and payroll
   decisions apart (ADR-0001's separation of duties).
5. **The two Roshni corrections:** once this ships, a manager enters
   them as the first real use: 30 Sept 17:46–20:43 `working`, and
   29 Sept 21:35:53–23:41:15 `working` (same hours, clears the
   long-away flag).
