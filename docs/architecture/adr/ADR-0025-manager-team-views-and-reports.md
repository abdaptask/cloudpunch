# ADR-0025 — Manager team views, exceptions and app-version reports

- **Status:** Accepted (2026-09-29, the owner approved the recommendation)
- **Date:** 2026-09-29
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0005 (`employee.reporting_manager_id`), ADR-0016
  (day history; **amended here**: manager views in the desktop app, not
  only a future web dashboard), ADR-0018 (idle explanations for the
  manager), ADR-0020 (People), ADR-0023 (break types, planned vs.
  actual), ADR-0024 (presence checks), CLAUDE.md invariant 5.
- **Confidence:** Medium-high. It reuses the day builder as it is and
  existing columns, with no migration. The new, security-critical part
  is the scope check, which gets its own tests.

## Context

Managers can't see their team's time yet. Everything is self-only
(ADR-0016). The owner asked for a manager day view and for reports, and
chose (2026-09-29):
- Team today, a person's day, Exceptions, and App versions;
- **not** timesheets or a payroll preview for now.

What exists (verified):
- The `team.timeline.read` capability: Manager and HR have it;
  Administrator doesn't.
- `employee.reporting_manager_id`, which nothing sets or reads yet.
- The day builder, which works for any employee id.

What's missing:
- a way to set reporting lines;
- a scope check;
- read auditing;
- any screen.

## Decision

### 1. Reporting lines, set in People

- **Who:** HR and Administrators (`hr.employee.write`) set a person's
  manager in Settings → People. The manager must have an employee
  record.
- **Rules:** not themselves, and no loops (A → B → A).
- **The API:** `PUT /v1/admin/employees/:id/manager`, with
  `{ manager_employee_id | null, reason? }`.
- **Audited** as `reporting_manager_set`.
- **Later:** greytHR takes this over when the integration is connected
  (ADR-0005).

### 2. Who may see whose day (invariant 5)

A server-side check, `canView(caller, subject)`, runs on every team
request:

| Caller | Sees |
|---|---|
| Manager (`team.timeline.read`) | Only **direct reports**: `subject.reporting_manager_id = caller's employee id` |
| HR (`team.timeline.read` + `hr.employee.read`) | Everyone |
| Administrator, Payroll, Auditor, Employee | No one else's day |

A person with both roles gets the wider scope. Anyone outside scope
gets **404** (not 403), so the API doesn't reveal who exists.

### 3. Endpoints

- **`GET /v1/team`:** Team today. The caller's people, each with:
  - their live status (clocked out, working, on a call, on a break with
    type and "back by", away with reason, idle, prompt);
  - since when;
  - worked time today.

  Derived from the open session's events.
- **`GET /v1/team/:employeeId/days/:date`** and **`?from&to`:** the same
  views as `/v1/me/days` (ADR-0016), for someone in scope. That covers
  segments, break type and planned minutes, idle explanations, presence
  checks, and totals including paid/unpaid breaks.
- **`GET /v1/team/exceptions?from&to`** (up to 31 days): for each person
  in scope, a list of:
  - idle of 15 minutes or more (with the person's explanation);
  - breaks over the planned time or over the type's limit;
  - shifts over `long_shift_hours`;
  - automatic clock-outs;
  - reconstructed (crash-recovered) sessions;
  - presence checks (ADR-0024).
- **`GET /v1/admin/versions`** (`admin.device.read`: Administrator,
  Auditor): each device's last seen app version and when, with its
  owner's name. It's operational data, not anyone's hours, so
  Administrators get it (useful for auto-update, ADR-0022).

### 4. Read audit

- **Each opening of someone else's day or exceptions** writes an
  `audit_log` row with:
  - `action: day_viewed` or `exceptions_viewed`;
  - `entity`: the employee;
  - the date(s).
- The Team today list is not audited on each refresh (it's a status
  board). Opening a person is.
- `audit_log` is described as a mutation log, but this is the right
  home: append-only and actor-stamped. No new table.

### 5. In the desktop app

- **A Team tab** for anyone with `team.timeline.read`:
  - Team today;
  - tap a person to see their day;
  - a date picker for the last 30 days;
  - Exceptions.
- **Versions** is under Settings, for `admin.device.read`.
- **This amends ADR-0016's "manager views come with the web
  dashboard".** A web dashboard can reuse the same endpoints later.

## Consequences

- **Positive:**
  - Managers see their people as the ADRs promised: breaks with type and
    planned vs. actual, idle with the person's account, presence checks.
  - The scope check keeps invariant 5, and read auditing protects
    employees.
  - No migration.
- **Negative:**
  - **A person without a reporting manager is visible only to HR.** HR
    has to fill in reporting lines until greytHR is connected.
  - **Direct reports only** (no skip-level). Add it later if asked.
  - **Team today polls** (every 30 s while open). That's fine at pilot
    scale; revisit at hundreds of people.

## Alternatives considered

- **A web dashboard first.** Rejected for now: it doesn't exist, and
  the pilot lives in the desktop app.
- **Managers see their whole department.** Rejected: too broad under
  invariant 5. Reporting lines are the accurate scope.
- **A separate read-access table.** Rejected: `audit_log` already fits.
- **403 for out-of-scope people.** Rejected: 404 doesn't confirm that
  someone exists.
