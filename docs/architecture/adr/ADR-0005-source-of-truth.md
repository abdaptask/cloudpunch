# ADR-0005 — Employee source-of-truth matrix and `local_admin ↔ greythr` transitions

- **Status:** Accepted (Phase 0)
- **Date:** 2026-09-23
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Confidence:** High on the authority split and transition rules;
  medium on the exact fuzzy-matching thresholds (§4) — will be refined
  once we have a sample of real greytHR + CloudPunch employee data.
- **Related:** ADR-0002 (Entra App Roles), ADR-0006 (greytHR integration
  strategy, drafted next).

## Context

CloudPunch's identity model has three parties:

1. **Microsoft Entra ID** — authenticates the human. `oid` is stable
   forever; `preferred_username` (work email) can change.
2. **greytHR** — HR and payroll system of record. Owns employee number,
   employment status, department, manager, location, shift, holidays,
   and approved leave. **API access is not yet confirmed as of
   2026-09-23**; project owner has an open request with greytHR.
3. **CloudPunch admin UI** — an interim source of truth used to run the
   product before the greytHR integration is enabled, and a permanent
   fallback for employees who exist in CloudPunch but not yet in
   greytHR (edge cases: contractors added ahead of HR onboarding, test
   accounts, break-glass).

We must:

- Ship Phase 1 with **`local_admin` as the sole employee source** so
  CloudPunch is usable while greytHR access is pending.
- Have a clean, auditable path to promote an employee from
  `local_admin` to `greythr` once matched, **without** breaking existing
  sessions, timesheets, or audit history.
- Never delete data when an employee's authority source changes.
- Never lose control of Entra App Role assignments across the transition.

## Decision

### 1. Employee record layout

`employee` table columns (relevant subset — full schema in Phase 1
migration):

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | Internal identifier. Immutable. |
| `source` | `text` enum `local_admin` \| `greythr` | Authority marker. |
| `greythr_employee_id` | `text` NULL, UNIQUE | Filled at match; immutable once set. |
| `employee_number` | `text` NULL | Filled by admin or synced from greytHR. |
| `entra_object_id` | `uuid` NULL, UNIQUE | Populated on first SSO. |
| `work_email` | `citext` NOT NULL | Case-insensitive. May change over time. |
| `given_name` / `middle_name` / `family_name` | `text` | |
| `display_name` | `text` | Preferred display; falls back to given + family. |
| `hire_date` | `date` NULL | |
| `termination_date` | `date` NULL | |
| `status` | `text` enum | `active`, `inactive`, `terminated`, `on_leave`. |
| `department_id` | `uuid` FK NULL | |
| `reporting_manager_id` | `uuid` FK NULL | Points at another `employee.id`. |
| `location_id` / `cost_center_id` | `uuid` FK NULL | |
| `default_shift_id` | `uuid` FK NULL | |
| `authority_transitioned_at` | `timestamptz` NULL | Set when `source` changes from `local_admin` to `greythr`. |
| `created_at` / `updated_at` | `timestamptz` | |

**Soft-delete is not used.** Termination sets `status = terminated` and
`termination_date`. Reactivation on rehire (§7) re-opens the same row.

### 2. Field authority table

Applies **once `source = greythr`**. Until then, all fields are
CloudPunch admin authoritative.

| Field | Authority when `source=greythr` | Authority when `source=local_admin` | Overridable in CloudPunch? |
|---|---|---|---|
| `greythr_employee_id` | greytHR (immutable after match) | n/a | No |
| `employee_number` | greytHR | admin | Only under §5 override rules |
| `work_email` | greytHR (mirrored) | admin | No — must go through greytHR |
| `given_name` / `family_name` | greytHR | admin | Yes, via override with reason |
| `hire_date` | greytHR | admin | No |
| `termination_date` | greytHR | admin | No |
| `status` | greytHR | admin | Suspend to `inactive` is allowed as an override for security reasons only |
| `department_id` | greytHR | admin | Yes, via override with reason |
| `reporting_manager_id` | greytHR | admin | Yes, via override |
| `location_id` / `cost_center_id` | greytHR | admin | Yes, via override |
| `default_shift_id` | greytHR | admin | Yes, via override |
| `entra_object_id` | CloudPunch (set at first SSO) | CloudPunch | No |
| App Role assignments | **CloudPunch admin, always** | CloudPunch admin | Yes |
| Raw `time_event` / sessions / timesheets | **CloudPunch, always** | CloudPunch | No |
| Anomaly signals / ReviewCases | **CloudPunch, always** | CloudPunch | No |

**Key rule:** greytHR **never** governs App Roles. HR data flows in;
authorisation stays local. If HR fires someone in greytHR, that flips
`status` and revokes assignments (§8), but the mapping from "an Entra
user has role Manager" is always a CloudPunch decision.

### 3. Feature flag

Global runtime flag `INTEGRATION_GREYTHR_ENABLED` (default `false` until
API access is confirmed). Behaviours:

- **Off:** greytHR sync worker does not run. Admin UI shows employees
  as fully editable. `source` for all employees is `local_admin`. New
  employees are created via admin action.
- **On:** greytHR sync worker runs on the schedule from ADR-0006.
  Admin UI shows greytHR-authoritative fields as read-only with a small
  "greytHR" badge and, where applicable, an "Override…" action gated by
  §5.

Toggling the flag on for the first time triggers the initial
reconciliation pass described in §4.

### 4. `local_admin → greythr` promotion (matching)

When `INTEGRATION_GREYTHR_ENABLED` becomes true, and on every scheduled
sync afterwards, the reconciler attempts to match each greytHR employee
to at most one `local_admin` CloudPunch employee.

Matching rules, in order (first strong match wins):

1. **Strong match** — `greythr_employee_id` already stored on a
   CloudPunch row (idempotent re-sync). No transition happens; just
   refresh mirrored fields.
2. **Strong match** — `employee_number` on a `local_admin` row equals
   greytHR `EmployeeNumber` and both are non-empty. Promote.
3. **Strong match** — `work_email` on a `local_admin` row equals
   greytHR `OfficialEmailID` (case-insensitive). Promote.
4. **Weak match — requires admin approval** —
   fuzzy name match (Levenshtein ≤ 2 on `family_name` + exact
   `given_name`) combined with matching department. Creates an
   `AdminReviewCase(kind=EMPLOYEE_MATCH_AMBIGUOUS)`. Never auto-promotes.

**No match:**

- If a greytHR employee has no candidate: create a new CloudPunch row
  with `source=greythr`, JIT-provision on their first SSO (per ADR-0002),
  do not automatically assign App Roles beyond `Employee`.
- If a `local_admin` employee has no greytHR counterpart: leave as
  `local_admin`. Show in the reconciliation dashboard under
  "CloudPunch-only employees" for admin decision.

**Multiple candidate matches:**

- Never auto-promote. `AdminReviewCase(kind=EMPLOYEE_MATCH_AMBIGUOUS)`
  with all candidates listed. Admin picks the correct one; the case
  records the decision + reason for audit.

**Promotion is one-way.** Once `source = greythr` and
`greythr_employee_id` is set, they are immutable. Demotion back to
`local_admin` would require deleting the greytHR link, which is
disallowed — the record can only become **inactive** if greytHR removes
it, and even then history is preserved.

### 5. Overrides after promotion

Rare but real: greytHR has stale data and payroll needs a corrected
department; or the reporting manager changes hours before greytHR
catches up.

Override row:

```
employee_override(
  id, employee_id, field_name, greythr_value, override_value,
  reason, actor_user_id, correlation_id,
  effective_from, effective_until,
  created_at
)
```

Rules:

- `effective_until` is mandatory and capped at **90 days** from
  `effective_from` by default (policy-configurable).
- Overrides expire silently at `effective_until`; the field reverts to
  greytHR's current value at that moment. A notification goes to the
  actor and to HR.
- Only Administrators and HR can create overrides.
- An override on `employee_number`, `hire_date`, `termination_date`, or
  `status` is disallowed — those must be corrected in greytHR itself.
  `status → inactive` for a security suspension is the only exception
  and requires an explicit `reason ∈ { security_review, credential_leak,
  under_investigation }`.
- Every override generates an `audit_log` row.
- The reconciliation dashboard lists all active overrides.

### 6. First-SSO / just-in-time provisioning

At the first successful Entra sign-in, if the authenticated user's
`oid` is not yet linked to any `employee` row:

- **`INTEGRATION_GREYTHR_ENABLED = false`:** deny sign-in with a neutral
  message ("Access has not been provisioned for your account. Please
  contact your CloudPunch administrator."). Do **not** JIT-create — the
  admin explicitly manages the employee list in this mode.
- **`INTEGRATION_GREYTHR_ENABLED = true`:** attempt match by
  `work_email` on active greytHR employees:
  - **Exactly one** active match: link `entra_object_id` to that
    employee. If the employee did not already exist in CloudPunch
    (unusual — implies sync lagging), create it now with `source=greythr`.
    Assign default `Employee` App Role. Allow sign-in.
  - **Zero matches or multiple matches:** deny sign-in, create an
    `AdminReviewCase`, present neutral "Access not yet provisioned"
    message with a support code the user can share with the admin.

### 7. Rehire

- Same `greythr_employee_id` reappearing with an active status flips the
  existing row from `terminated` back to `active`, clears
  `termination_date`, and creates an audit_log row noting the rehire.
- The former Entra `oid` may or may not be the same person; on next SSO
  we verify `oid` against the stored value and, if different, treat as
  a new person (create a new employee row and rename the old row's
  `entra_object_id` history for audit).
- Historical time data on the rehired row is preserved and available to
  auditors but is not visible in the manager's default timesheet views
  (only via a "Historic" filter).

### 8. Termination synced from greytHR

When greytHR status flips to `terminated` (or `date_of_leaving` <= today
and status ≠ `active`):

1. Set `employee.status = terminated`, `termination_date` from greytHR.
2. Revoke every CloudPunch App Role assignment for the user's `oid` via
   Microsoft Graph. Assignments are removed, not soft-deleted; the
   audit trail lives in Entra sign-in logs and the CloudPunch
   `audit_log`.
3. Any open `time_session` is closed at the next heartbeat with
   `reason=greythr_termination_forced`. The session's `closed_at` is
   the last known heartbeat time. A `ReviewCase` is created so HR can
   verify.
4. Revoke enrolled device(s): set `device.revoked_at = now()`. Future
   events from those devices are rejected (per ADR-0004 §5).
5. Historic timesheets, corrections, approvals, audit logs are
   **untouched**. Retention rules from ADR-0004 apply.

### 9. Reconciliation dashboard

Admin UI page `/admin/reconciliation` shows six sections:

- **Sync health** — last successful full sync, last successful
  incremental sync, next scheduled run, error counter, rate-limit
  headroom.
- **Match queue** — ambiguous or unmatched employees; each row shows
  candidates and lets the admin resolve.
- **CloudPunch-only employees** (`source=local_admin` after greytHR is
  enabled) — for admin decision (leave as local, or ask greytHR to add
  them).
- **greytHR-only employees** — imported from greytHR but never signed
  into CloudPunch (haven't hit first SSO yet). Not an error; useful
  visibility.
- **Active overrides** — the list per §5, with time to expiry.
- **Field mismatches** — for `source=greythr` rows where a mirrored
  field differs from the latest greytHR pull, showing both values.
  Usually caused by an in-flight override; useful to spot data-quality
  drift.

Nothing here is destructive — the dashboard surfaces state and offers
resolution actions, but the actual mutation goes through the same
audited APIs the admin UI uses elsewhere.

### 10. Cross-system identifier mapping (summary)

The primary link identifiers per employee:

| Identifier | Origin | Stability | CloudPunch column |
|---|---|---|---|
| Internal ID | CloudPunch | Immutable | `employee.id` |
| Entra Object ID | Entra | Immutable (per user) | `employee.entra_object_id` |
| Work email | Entra / greytHR | May change | `employee.work_email` |
| Employee number | greytHR / admin | Stable, but can be re-issued | `employee.employee_number` |
| greytHR employee ID | greytHR | Immutable once assigned | `employee.greythr_employee_id` |

**Rule:** any code linking CloudPunch data across greytHR must key on
`greythr_employee_id`. Any code linking across Entra must key on
`entra_object_id`. Work email is display-only — never a join key.

## Consequences

### Positive

- Phase 1 ships without greytHR. `INTEGRATION_GREYTHR_ENABLED = false`
  keeps the code paths inert but present, so enabling greytHR later is
  a flag flip plus a reconciliation pass, not a rewrite.
- Overrides are auditable, time-boxed, and cannot silently corrupt
  greytHR authority.
- Termination in greytHR closes sessions, revokes App Roles, and
  revokes devices — a coherent teardown.
- Historic data is preserved without exception; the only "destructive"
  operations happen inside retention policy (ADR-0004).

### Negative

- Two authority modes complicate the admin UI: the same field is
  editable in one mode and read-only in the other. Mitigation: a clear
  visual badge per field, unit-tested UI states.
- Field mismatches during override windows can confuse a naive report
  writer. Mitigation: the reporting layer always uses CloudPunch's
  mirrored values (which honour overrides), not raw greytHR values.
- Multi-candidate matches must be resolved by a human. Mitigation: no
  auto-guess; every ambiguity produces a `ReviewCase` and a dashboard
  row.

### Neutral

- The 90-day override cap is a policy choice; if HR needs longer
  overrides in practice, extend the config, not the code.

## Alternatives considered

### Only `greythr` — refuse to run without greytHR

Cleanest identity model. **Rejected** — blocks Phase 1 shipping while
greytHR API access is unconfirmed. Also removes a permanent, useful
fallback for contractors and break-glass admins.

### Only `local_admin` — never rely on greytHR

Simple but violates the source-of-truth mandate from the project brief.
**Rejected**.

### A join table `employee_greythr_link` instead of a `source` column

Two-way mirroring, no authority marker. **Rejected** — the "who wins on
a conflict" question is precisely what the `source` column answers.

### Auto-transition on any strong match, including fuzzy

Fewer human decisions. **Rejected** — a wrong auto-match here means one
employee's clock-in data merges into another employee's payroll. Human
approval for anything below `employee_number` or `email` exact match is
worth the friction.

## Follow-up

- ADR-0006 defines the greytHR sync worker and endpoint contract.
- Phase 1 migration `0002_employees.sql` implements the schema in §1.
- Phase 3 admin UI implements the reconciliation dashboard in §9.
- Phase 4 turns the flag on in staging first, runs the reconciliation
  pass, and only after clean results does it turn on in production.

## References

- ADR-0002 — App Role assignment strategy (unchanged by employee
  source).
- ADR-0004 — event and session data ownership (always CloudPunch,
  regardless of `source`).
- greytHR Attendance & Employee master API — links to be added in
  ADR-0006 once documentation URL is confirmed.
