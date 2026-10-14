# ADR-0044 — Data retention: a nightly clean-up, off until HR sets the periods

- **Status:** Accepted (2026-10-14, the owner chose "build it, off
  until HR sets it")
- **Date:** 2026-10-14
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Supersedes in part:** ADR-0004 §11 (retention by monthly partition
  detach) for as long as `time_event` is not partitioned. §11 stays the
  plan for Aurora; this ADR is how retention works until then.
- **Builds on:** ADR-0004 (append-only ledger, invariant 2), ADR-0018
  (idle explanations), ADR-0029 §6 (connection locations kept 30 days),
  ADR-0030 (corrections), ADR-0037/0040/0041 (sent-email records),
  ADR-0038 §5 (bulk idempotency keys), ADR-0040 §3.4 (refused uploads).
- **Confidence:** High on the mechanism (one database function, tested
  against the real triggers). The periods are HR/legal's to set.

## Context

India's DPDPA asks that personal data is kept only as long as it's
needed. CloudPunch keeps everything forever today, except connection
locations (a nightly systemd job deletes rows over 30 days old,
ADR-0029 §6). The privacy notice draft promises periods ("raw time
events 3 years, audit records 7 years") that nothing enforces.

The owner (2026-10-14) chose to **build the clean-up with settings,
switched off until HR/legal confirm the periods**, with connection
locations staying at 30 days as now.

The hard part: `time_event`, `audit_log`, the correction tables and the
other ledgers are **append-only** (invariant 2). Database triggers
reject every UPDATE and DELETE, for every role, and CI fails any code
that issues them. ADR-0004 §11 planned retention as "detach a monthly
partition, archive it, drop it", never as `DELETE FROM time_event`; but
nothing is partitioned on the pilot, and there is no archive yet.

## Decision

### 1. What is kept, and for how long

| Kind (setting) | What it removes | Proposed default | Floor (can't go lower) |
|---|---|---|---|
| **Time records** (`time_records_years`) | Whole sessions closed before the cutoff: their events (`time_event`), the session, and corrections (with their decisions) that ended before the cutoff. Sessions on legal hold (`legal_hold_until`) are kept. | **5 years** | 3 years |
| **Idle explanations** (`idle_notes_days`) | The "what were you doing?" answers and notes (`USER_IDLE_EXPLAINED` events), except "On a break" answers, which decide pay (ADR-0042). The idle time itself stays. | **365 days** | 90 days |
| **Audit log** (`audit_log_years`) | `audit_log` rows older than the cutoff (who changed what, who viewed whom). | **7 years** | 3 years |
| **Sent-email records** (`notifications_days`) | `shift_alert`, `weekly_report_sent`, `report_sent`, `location_alert`. They only stop an email going twice and feed "missed starts in the last N days" (at most 90). | **365 days** | 120 days |
| **Operational logs** (`operational_days`) | `upload_refusal` counts and `admin_bulk_request` idempotency answers. | **90 days** | 30 days |
| Connection locations | Unchanged: 30 days, by the existing nightly systemd job (ADR-0029 §6). Not in this setting. | 30 days | — |

The defaults are proposals for HR/legal. Points for them to settle:
- The privacy notice says raw time events are kept **3 years**; India's
  wage-code rules ask employers to keep wage and attendance records for
  **5 years**. The default follows the longer one; the floor is 3.
- Audit records: the notice says 7 years; the default matches.
- Nothing is archived before deletion (there's no archive yet): what
  goes is gone, apart from the nightly database backups (ADR-0035),
  which age out on their own schedule.

### 2. The one way to delete from an append-only table

A database function, **`cloudpunch_retention_purge(kind, days,
dry_run)`**, created by migration 0019, is the only path that can
delete from the append-only tables:

- It is `SECURITY DEFINER`, owned by the migrating role (the tables'
  owner), with a fixed `search_path`. The app role may only `EXECUTE`
  it; it has no DELETE on those tables, before or after.
- **Floors are in the function**, not only in the app: a `days` below
  the floor for that kind is refused, so a bad setting (or a bad
  caller) can't remove recent payroll data.
- **The triggers stay.** `deny_mutation_on_append_only()` keeps
  refusing every UPDATE, and every DELETE **unless** the current
  transaction holds a purge lock: a row in `retention_purge_lock` (this
  transaction's id and a random token) that only the purge function
  writes, matched against a transaction-local setting it also sets.
  The app role has no privilege on that table, so it can't forge one;
  setting the flag alone does nothing. The lock row is removed before
  the function returns; on any error the whole statement rolls back.
- **Dry run** (`dry_run = true`) only counts what would go and changes
  nothing. A real run deletes and writes **one `audit_log` row** per
  kind (`actor_type 'system'`, `entity_type 'retention'`, action
  `retention_purged`, with the kind, days, cutoff and row count).
- **CI:** the invariant scan still fails any UPDATE/DELETE/TRUNCATE on
  an append-only table anywhere in migrations and backend code, except
  inside the one marked block in migration 0019 that defines this
  function. The scan checks that the block exists exactly once and
  defines a `SECURITY DEFINER` function named
  `cloudpunch_retention_purge`.

### 3. When it runs

- A job in the API checks hourly and runs once a day after **02:00
  India time**, each kind in turn, **only if `retention.enabled` is on**
  (company-wide policy, off by default).
- The settings live in the global policy (`retention.*`) and in
  **Rules → Data retention** (company-wide, Administrators): the switch
  and the five periods, each refused below its floor.
- **Before switching on**, Rules shows a dry run for the periods on
  screen ("would delete N rows now"), from
  `GET /v1/admin/retention/preview` (Administrators).
- A failed run is logged and tried again the next day; the job never
  touches requests.

## Consequences

- Retention can be switched on the day HR/legal sign off, with no new
  code, and its effect is visible beforehand.
- Invariant 2 changes from "never deleted" to "never changed, and
  deleted only by the audited, floored purge". The CI scan and the
  triggers still catch everything else.
- Deleting idle explanations leaves the idle time and its totals as
  they were; only the person's words go. Deleting time records removes
  whole closed sessions, so totals for those old days drop to nothing
  (they're past the retention period by definition).
- When `time_event` moves to Aurora with monthly partitions, ADR-0004
  §11's detach-and-archive replaces this function for time records.

## Alternatives considered

- **Disable the triggers during the purge** (`ALTER TABLE … DISABLE
  TRIGGER`): needs the owner, takes an exclusive table lock, and leaves
  the table unprotected if the job dies halfway.
- **A setting alone as the bypass** (`SET cloudpunch.purge = on`): any
  role that can delete could set it.
- **Partition now:** the right end state, but a large migration of the
  live ledger for a 60-person pilot; ADR-0004 §11 keeps it for Aurora.
- **Delete from the app with a privileged connection:** spreads delete
  rights into application code; the function keeps them in one place
  the database enforces.
