# ADR-0049 — An Administrator corrects someone's time, and it counts at once

- **Status:** Accepted (2026-10-15, the owner decided: "the admin should
  be able to do it on behalf of the user", and chose "counts straight
  away")
- **Date:** 2026-10-15
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Amends:** ADR-0030 §3 (who does what). ADR-0030's content stands;
  this adds one path.
- **Confidence:** High. It reuses ADR-0030's storage, limits and audit;
  only who may enter it, and that it is approved in the same step,
  are new.

## Context

ADR-0030 lets an employee ask, their manager endorse, and an
Administrator approve. A manager can correct a direct report. An
Administrator can only approve what others entered, and nobody decides
on their own correction.

In the pilot, the owner (the only Administrator) found that when
someone forgot to end a break (Eela, a bio break left running for
about seven hours on 2026-10-14), nobody could fix it directly. The
person had to ask, their manager had to endorse, and only then could
the Administrator approve. For people with no manager in CloudPunch,
or whose manager is away, that waits on others for a fix the
Administrator can already see is right.

## Decision

1. **Who:** a holder of `admin.correction.approve` (Administrator).
2. **For whom:** any active employee, not only direct reports.
   **Never their own time:** that still takes a second Administrator,
   through ADR-0030's normal path (the server refuses with `own_time`).
3. **Which time:** the same limits as ADR-0030 §5. That means any day
   in the last 30 days, **today included**, never in the future, at
   most 16 hours, and not over a pending request for the same person.
4. **It counts at once.** The server stores the request and an
   `approved` decision by the same Administrator, one after the other.
   Both carry one correlation id. Each writes its own audit_log row
   (`correction_requested`, `correction_approved`), as every
   correction action does. There is no extra table and no migration.
   ADR-0030's "nobody decides on their own correction" check applies
   to the decision endpoint only. This path is the one deliberate
   exception, limited to Administrators and to other people's time.
5. **A reason is required**, as for every correction.
6. **Visible to everyone with a part.** The person, their manager and
   HR see it on the day like any approved correction. It reads
   **"Corrected by <Administrator>"** and gives the reason. The
   original record is untouched and one tap away (ADR-0030 §4).
7. **Endpoint:** `POST /v1/admin/employees/:employeeId/corrections`
   (same body as `/v1/me/corrections`). **Screen:** Console → Reports
   → Day summary → click a person → **Correct time**. The form says
   "Counts straight away, recorded as corrected by you."

## Consequences

- A forgotten break end, missed clock-out or wrong break type can be
  fixed the same day by the Administrator, without a request and an
  endorsement first.
- This weakens ADR-0030's two-person rule for this path: one
  Administrator alone can change anyone else's hours. That is
  mitigated by the reason, the audit rows, the "Corrected by" label the
  person sees, and the original staying visible. It is acceptable for
  a single-Administrator pilot. A later setting could require a second
  Administrator again.
- When timesheets and the greytHR export land (invariant 3), these
  corrections feed `timesheet_version` exactly like approved ones.

## Alternatives considered

- **A second Administrator approves (ADR-0030 unchanged):** the owner
  is the only Administrator, so fixes would wait indefinitely.
- **Let managers' corrections count at once instead:** it spreads the
  power wider than needed; managers keep endorsing.
- **Edit the recorded events:** forbidden (invariant 2); corrections
  are laid over the record, never written into it.
