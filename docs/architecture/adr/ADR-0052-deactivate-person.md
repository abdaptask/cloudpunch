# ADR-0052 — Deactivate a person in one step

- **Status:** Accepted (2026-11-10, owner decision)
- **Deciders:** Abdulla Sheikh (owner)
- **Relates to:** ADR-0020 (people and roles in-app; records follow roles),
  ADR-0025 (reporting lines), ADR-0028 §4 (signing a machine out),
  ADR-0037 (alert recipients follow roles), ADR-0038 §5 (bulk changes)
- **Confidence:** High for the steps, which reuse what ADR-0020 and ADR-0028
  already do. Medium (about 85%) for how it behaves when Microsoft Entra
  fails halfway through a bulk run. Tests cover that case, but it hasn't
  been seen against the real Graph.

## Context

Offboarding someone today takes several separate actions: sign their
machine out (Administrators only, ADR-0028), untick every role (which turns
the record off under ADR-0020 §4), then find and fix the people who reported
to them. Each action writes its own audit rows, and if a step is missed the
person can stay half-active. The owner asked for one **Deactivate** button on
the person panel, with a confirmation and a required reason, plus a
"Deactivate selected" option for bulk offboarding.

## Decision

### 1. One action, five effects

`POST /v1/admin/people/deactivate {oid?, employee_id?, reason}`:

1. **Signs out and closes.** The open session closes at its last event
   (`remote_takeover`, reconstructed), the same as ADR-0028. Every
   unrevoked machine of theirs gets `signout_requested_at`, so the app
   signs out at its next check.
2. **Removes their CloudPunch roles** in Entra as the caller (OBO, as in
   ADR-0020). A role or account that is already gone (Graph 404) is fine,
   and the process continues. Alert recipients update at once (ADR-0037).
3. **Turns the record off** (`employee.status = 'inactive'`). Every email
   job and Team, Reporting lines, Reports and Insights read
   `listActive()`, so they drop the person. Uploads and clock-ins from an
   inactive record are refused (`events/ingest.ts`, `/v1/me`).
4. **Clears them as manager** for everyone who reported to them. The
   answer lists those people, and the console links each one to their
   panel so a new manager can be set.
5. **Writes one audit row** (`employee_deactivated`). It records the
   reason, the roles removed, the Entra outcome, the session closed, the
   machines signed out and the people left without a manager. No
   `time_event` row is touched (invariant 2), and all time history is kept.

Steps 1, 3, 4 and 5 run in one database transaction
(`db.people.deactivate`). Entra can't join that transaction, so step 2
runs first and its result is written into the audit row.

A person is identified by `oid`, `employee_id` or both. A record may have no
Entra link, and someone who holds only roles has no record. If both are given
and they belong to different people, the request is refused.

### 2. Entra failing doesn't block deactivation

If Entra can't be read or a role can't be removed (Graph down, consent
missing, refused), an **Administrator's** deactivation still goes ahead in
CloudPunch. The answer says `entra: "failed"` and the console shows "roles
are still in Microsoft Entra" with a **Retry** button. The person is cut off
either way, because an inactive record can't clock in or upload. A Retry is
the same request again: it removes the roles and writes its own audit row.

### 3. Repeating it is harmless

When there is nothing left to do (already inactive, no open session, no
machine to sign out, no roles), the answer is `outcome: "already"` and no
audit row is written.

### 4. Who may

- **Administrators** may deactivate anyone, except themselves and the last
  Administrator.
- **HR** may deactivate people whose CloudPunch roles are Employee and/or
  Manager only (the ADR-0020 §3 split). HR needs Entra to confirm the
  person's roles, so if Entra can't be read, HR's request is refused (503)
  and nothing changes.
- This is the only way HR can sign someone's machine out. Sign-out on its
  own (ADR-0028) stays Administrator-only.

### 5. Deactivate selected

`POST /v1/admin/people/bulk/deactivate {idempotency_key, people, reason}`
handles up to 200 people. Each person gets their own answer, the same as the
other bulk changes (ADR-0038 §5). People are processed one at a time, so the
last-Administrator check takes earlier people in the batch into account. The
answer is kept by its idempotency key (invariant 4). Migration 0023 adds
`deactivate` to the allowed bulk kinds. All the rows from one bulk request
share a correlation id.

### 6. Reactivating

There is no separate button. Giving someone a role with a record
(Employee, Manager or HR) through the normal role save turns the record back
on (ADR-0020 §4). Their history is still there, and their manager has to be
set again.

## Consequences

- Offboarding takes one step with one audit row, from the desktop console
  or the web dashboard.
- The status used is `inactive`, not `terminated`. Leavers and other
  inactive records look the same. If HR needs to tell them apart, that is
  a later change to this ADR.
- Open corrections the person asked for, or was due to endorse as a
  manager, aren't changed. They stay in the queue for HR or an
  Administrator to decide.
- A deactivated person who opens the app before it signs out can't clock
  in. The app signs out at its next check (ADR-0028).
- The console needs desktop 0.1.48. The web dashboard gets the feature
  when the server deploys.

## Alternatives considered

- **Stop when Entra fails.** The person would stay active in CloudPunch
  until Entra recovered. Rejected: CloudPunch's own records are what cut
  them off, so they should never wait on Entra.
- **Keep one audit row per step** (status, each report's manager,
  sign-out). Rejected because the owner wants one entry for the whole
  action. The row's `new_value` still lists every effect.
- **A Reactivate button.** Not needed: re-adding a role already does it.
- **Disable the Entra account itself.** Out of scope. That is IT's job
  and affects every Microsoft service, not only CloudPunch.
