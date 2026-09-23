# CloudPunch — Operational runbook outline

- **Status:** Skeleton. Individual runbooks are fleshed out during
  Phase 6 (observability + on-call readiness) and Phase 7 (hardening).
- **Owner:** whoever is on-call. Rotating ownership documented in the
  team roster.
- **Related:** ADR-0007 (secrets), `docs/architecture/threat-model.md`,
  `docs/ops/env-vars.md`.

This file is a table of contents. Each entry below becomes a
standalone runbook file at its listed path. A runbook must exist and
be tested before the corresponding capability goes live in production.

## 1. Incident response

- `docs/ops/runbooks/incident-severity.md` — severity definitions
  (SEV1 – SEV4), paging thresholds, escalation timers, incident
  commander responsibilities.
- `docs/ops/runbooks/on-call-handoff.md` — how the outgoing on-call
  hands off (open incidents, pending investigations, active
  break-glass sessions).
- `docs/ops/runbooks/post-incident-review.md` — template for
  blameless post-mortems.

## 2. Authentication and access

- `docs/ops/runbooks/entra-outage.md` — what to do if Entra sign-in
  fails at scale (queue user notifications, extend session TTLs,
  publish status page).
- `docs/ops/runbooks/app-role-reassignment.md` — steps to correct a
  bad App Role assignment.
- `docs/ops/runbooks/break-glass-activation.md` — how to enable the
  break-glass Entra account (`cloudpunch-breakglass@aptask.com`),
  including who authorises, what gets logged, and mandatory rotation
  within 24 hours after use.
- `docs/ops/runbooks/break-glass-aws.md` — same for the
  `cloudpunch-breakglass-secrets` IAM user.

## 3. Data plane

- `docs/ops/runbooks/aurora-failover.md` — verify replica lag before,
  during, and after a controlled failover; connection-string
  rotation.
- `docs/ops/runbooks/aurora-restore.md` — point-in-time recovery
  from Aurora snapshot into a new cluster; how to validate integrity
  of `time_event` counts before switching traffic.
- `docs/ops/runbooks/redis-outage.md` — impact assessment (ingest
  degradation vs full stop), recovery, replay of stalled jobs.
- `docs/ops/runbooks/s3-archive-restore.md` — pulling a cold
  partition back for query; validating hashes.
- `docs/ops/runbooks/partition-maintenance-failed.md` — what to do
  when the nightly partition-creation job fails (immediate: create
  next month's partition manually; follow-up: fix the job).

## 4. Desktop agent

- `docs/ops/runbooks/agent-fleet-health.md` — reading the
  Agent-Health dashboard, understanding "silent agents" (installed
  but not syncing), and outreach to affected users.
- `docs/ops/runbooks/agent-bad-release.md` — rolling back a bad
  Tauri auto-update: pause updater, publish rollback release,
  communicate to affected users, root-cause after.
- `docs/ops/runbooks/mac-notarisation-rejection.md` — process for
  handling Apple notarisation rejections during release.
- `docs/ops/runbooks/win-signing-failure.md` — Azure Trusted
  Signing failure recovery.

## 5. greytHR integration

- `docs/ops/runbooks/greythr-connectivity-lost.md` — what to do when
  the greytHR API is unreachable (circuit breaker open, queue
  behaviour, admin communication).
- `docs/ops/runbooks/greythr-conflict-queue.md` — how to work through
  `EXPORT_FAILED_CONFLICT` entries in the reconciliation dashboard.
- `docs/ops/runbooks/greythr-rate-limited.md` — cadence adjustment
  and back-pressure when we consistently hit greytHR's rate limit.
- `docs/ops/runbooks/greythr-credentials-rotation.md` — rotating
  greytHR credentials without a service outage.
- `docs/ops/runbooks/greythr-mode-switch.md` — moving between
  `off / dry_run / active / csv_only`, including required admin
  approvals and audit-log entries.

## 6. Secrets and keys

- `docs/ops/runbooks/secret-leaked.md` — process when a secret
  appears in a commit, log line, or third-party report. Includes
  immediate rotation, audit-log review, and required
  post-mortem.
- `docs/ops/runbooks/kms-key-suspicious-access.md` — response to
  CloudTrail alarms on unusual KMS decrypt patterns.
- `docs/ops/runbooks/tauri-updater-key-compromise.md` — the "this is
  bad" runbook: revoking the updater key, publishing a new signed
  build with a new embedded public key, forcing all agents through a
  clean re-install.
- `docs/ops/runbooks/code-signing-cert-expiry.md` — cert renewal
  procedure and 60-day alarm response.

## 7. Timesheet and payroll

- `docs/ops/runbooks/timesheet-locked-period-reopen.md` — steps to
  reopen a locked payroll period (elevated approvers required,
  audit-trail requirements, coordination with greytHR export).
- `docs/ops/runbooks/duplicate-attendance-in-greythr.md` — when
  greytHR already has attendance for the same employee + date with a
  different idempotency key.
- `docs/ops/runbooks/manager-out-of-office.md` — how HR/admin can
  delegate approvals when a manager is unavailable at close of a
  payroll period.

## 8. Notifications

- `docs/ops/runbooks/notification-storm.md` — response to a bug that
  fires a lot of notifications quickly (rate limit, kill switch,
  user apology template).
- `docs/ops/runbooks/quiet-hours-misconfigured.md` — global default
  is wrong for a region; how to correct without wiping legitimate
  per-user preferences.

## 9. Compliance

- `docs/ops/runbooks/dpdpa-data-subject-request.md` — receiving,
  logging, and fulfilling employee data-access and correction
  requests within DPDPA timelines.
- `docs/ops/runbooks/employee-termination.md` — end-to-end steps
  when greytHR marks an employee terminated (session close,
  App-Role revoke, device revoke, historical data preservation,
  final timesheet handling).
- `docs/ops/runbooks/legal-hold.md` — placing and lifting legal
  holds on `time_session` rows so retention does not detach.
- `docs/ops/runbooks/audit-export.md` — generating a full audit
  export for internal or external auditors.

## 10. Backup and disaster recovery

- `docs/ops/runbooks/backup-verification.md` — monthly restore drill
  to validate backups; documented pass/fail criteria.
- `docs/ops/runbooks/dr-region-failover.md` — DR to
  `ap-southeast-1` if that region is ever promoted. Not applicable
  at MVP.
- `docs/ops/runbooks/data-loss-scenarios.md` — decision tree for
  responding to detected data loss (raw event, timesheet, audit).

## 11. Deployment

- `docs/ops/runbooks/production-release.md` — release-day
  checklist: pre-flight, canary, monitor, promote, monitor,
  post-mortem window.
- `docs/ops/runbooks/rollback.md` — code and schema rollback
  strategies. What we can roll back automatically vs what needs
  manual coordination (migrations, feature flags, secrets).
- `docs/ops/runbooks/feature-flag-flip.md` — how to flip a
  production feature flag safely, including who approves and how
  the audit trail is captured.

## 12. Observability

- `docs/ops/runbooks/dashboards-overview.md` — the four dashboards
  every on-call knows: API health, ingest, greytHR sync, agent
  fleet.
- `docs/ops/runbooks/high-cardinality-metric.md` — response when a
  metric explodes cardinality (usual cause: unbounded label).
- `docs/ops/runbooks/sentry-noisy-error.md` — quieting a noisy
  error while root cause is fixed.

## 13. Prioritisation for Phase 6 / 7

Runbooks must exist and be tested before their capability goes live.
Ordered by production dependency:

1. **Before Phase 1 ships:** `entra-outage`, `break-glass-activation`,
   `break-glass-aws`, `secret-leaked`, `production-release`,
   `rollback`.
2. **Before Phase 2 ships:** `agent-fleet-health`, `agent-bad-release`,
   `aurora-failover`, `redis-outage`, `partition-maintenance-failed`,
   `mac-notarisation-rejection`, `win-signing-failure`.
3. **Before Phase 3 ships:** `timesheet-locked-period-reopen`,
   `manager-out-of-office`, `dpdpa-data-subject-request`,
   `employee-termination`.
4. **Before Phase 4 ships:** `greythr-connectivity-lost`,
   `greythr-conflict-queue`, `greythr-rate-limited`,
   `greythr-credentials-rotation`, `greythr-mode-switch`,
   `duplicate-attendance-in-greythr`.
5. **Before Phase 5 ships:** `agent-fleet-health` refresh,
   `tauri-updater-key-compromise`, anomaly-signal review runbook.
6. **Before Phase 7 sign-off:** every remaining item, plus
   `dr-region-failover` if the DR posture is elevated.

Each runbook lives as its own Markdown file at the path listed. This
file is only the outline.
