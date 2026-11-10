# ADR-0053 — Deactivated people: history, past reports and Reactivate

- **Status:** Accepted (2026-11-10, owner decision)
- **Deciders:** Abdulla Sheikh (owner)
- **Relates to:** ADR-0052 (Deactivate), ADR-0020 §4 (records follow roles),
  ADR-0025 (who sees whom; read audit), ADR-0040 §3 (Reports, Trends),
  ADR-0044 (retention)
- **Confidence:** High for the list, Reactivate and history, which reuse
  the existing day views and audit rows. Medium (about 85%) for past
  reports: the cut-off is the India date of the last deactivation, so
  someone deactivated and reactivated in the same range shows "not clocked
  in" for the days in between.

## Context

Deactivating someone (ADR-0052) keeps their record and all of their time,
but every screen read only active people. Once someone left:

- nobody could see their past days, because Team checks status and its
  day views go back only 30 days;
- they disappeared from past weeks' Reports and Trends, so old totals
  changed after they left;
- reactivating them meant finding them through Add person and ticking a
  role.

The owner asked to keep a record that can be looked at, to include them in
past reports, and to reactivate them from the same screen.

## Decision

### 1. Settings → People → Deactivated

A second view next to People lists every inactive record with when, by whom
and why. This comes from the latest `employee_deactivated` audit row, or a
`status_set` to inactive for records turned off by removing their roles.
`GET /v1/admin/people/deactivated` is available to HR and Administrators.
Opening a person shows a read-only panel with: the deactivation details,
**Reactivate**, **Time history** and **Changes** (the existing person
history, which now describes `employee_deactivated` and
`employee_reactivated` in words).

### 2. Reactivate

`POST /v1/admin/people/reactivate {employee_id, roles, reason}` works like
Deactivate:

- A reason is required.
- The roles they had are offered first (`roles_before`). At least one of
  them must be Employee, Manager or HR, otherwise the record would turn off
  again (ADR-0020 §4).
- HR may give only Employee and Manager. Administrators may give any role.

Entra goes first: the roles are assigned as the caller (OBO). If Entra
fails, nothing changes in CloudPunch, and Retry is the same request. If
their Microsoft account has been deleted, the answer is `account_gone`. On
success, the record turns active with **one** audit row
(`employee_reactivated`), and alert recipients update at once. Their manager
and shift aren't restored: the console asks for them to be set again.

### 3. Past reports keep the people who worked them

Reports (Day summary, Trends and its CSV) cover the active people plus every
deactivated person whose last active day falls within or after the report's
first date. The last active day is the India date of their latest
deactivation. Their days after that date are left out, so they don't appear
as "not clocked in" after leaving. Trends' health counts still use only
active people, because those counts describe now. A Manager's scope is
unchanged: a deactivated person's reporting line was cleared, so they aren't
anyone's report any more.

### 4. A person's history, back a year

`GET /v1/admin/employees/:id/days?from&to` (up to 31 days per request) and
`GET /v1/admin/employees/:id/days/:date` let HR and Administrators see anyone,
active or not, back 366 days. That is the same limit as Trends. Each view is
audited as `day_viewed`, like Team's (ADR-0025 §4). Team's own views keep
their 30-day look-back and their active-only scope, and Managers don't get
these routes.

## Consequences

- No data was ever removed, so nothing needs a migration. This is about
  showing what is already stored.
- Retention (ADR-0044) still applies: time past its retention period goes
  for deactivated people as it does for everyone else.
- Reactivating someone whose Microsoft account was deleted isn't possible
  until IT restores the account or a new one is linked.

## Alternatives considered

- **Show deactivated people in the main People table.** Rejected: it would
  mix people you can edit with people you can't, and every filter and
  bulk action would need special cases.
- **Lift Team's 30-day look-back for everyone.** Not needed: managers see
  current work. A year of history is for HR and Administrators.
- **Restore the old manager on Reactivate.** That manager may have changed
  or left too. Asking is safer.
