# ADR-0006 — greytHR integration strategy

- **Status:** Accepted (Phase 0)
- **Date:** 2026-09-23
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Confidence:** High on the adapter shape, idempotency model, and
  reconciliation approach. **Low** on specific endpoint paths, payload
  shapes, and auth mode — those are unknown until Greytip Software
  confirms API entitlement for ApTask's greytHR plan.
- **Related:** ADR-0005 (source-of-truth), ADR-0004 (event/idempotency
  model), and the pending mapping RFC at
  `docs/integrations/greythr-mapping-rfc.md`.

## Context

greytHR (Greytip Software) is ApTask's HR and payroll system of record.
As of 2026-09-23:

- **API access is not yet confirmed** — the project owner has an open
  request with greytHR.
- Product edition, tenant subdomain, available endpoints, auth mode,
  rate limits, and whether attendance write is supported on the current
  plan are all unknown.
- Browser automation and screen scraping are **prohibited** by the
  project brief.
- If the API is not available for attendance write, the fallback is a
  supported scheduled **CSV/XLSX import/export** — never an unofficial
  substitute.

We therefore design an integration layer that:

1. Ships behind `INTEGRATION_GREYTHR_ENABLED = false` (ADR-0005 §3), so
   Phase 1 launches without greytHR.
2. Presents a **stable internal adapter interface** so the concrete
   implementation (API client vs CSV importer/exporter) is a runtime
   configuration, not a code rewrite.
3. Preserves all raw event history regardless of what leaves the system.
4. Never overwrites payroll-affecting data without an audit trail.
5. Refuses to guess at endpoint names, payload shapes, or rate limits.

## Decision

### 1. Adapter interface

One TypeScript interface defines everything the rest of the codebase
needs from greytHR. Implementations plug in at boot time based on
configuration.

```ts
// packages/shared/src/integrations/greythr.ts
export interface GreythrAdapter {
  // Inbound
  listActiveEmployees(cursor?: string, since?: Date): Promise<Page<GreythrEmployee>>;
  getEmployee(greythrEmployeeId: string): Promise<GreythrEmployee | null>;
  getHolidayCalendar(year: number): Promise<GreythrHoliday[]>;
  getApprovedLeave(cursor?: string, since?: Date): Promise<Page<GreythrLeave>>;
  getShiftAssignments(cursor?: string, since?: Date): Promise<Page<GreythrShiftAssignment>>;

  // Outbound
  postApprovedAttendance(records: AttendanceExportRecord[]): Promise<BulkExportResult>;
  checkAttendanceExists(employeeId: string, date: string): Promise<AttendanceExistsResult>;

  // Health + metadata
  ping(): Promise<HealthProbe>;
  describeCapabilities(): CapabilitySet;
}
```

`CapabilitySet` is discovered at boot (or configured statically for
CSV mode). It advertises which of the following the current adapter
supports:

- `read.employees` / `read.employees.delta` (with `modifiedSince`)
- `read.holidays`
- `read.leave`
- `read.shifts`
- `write.attendance` / `write.attendance.correction`
- `webhooks.termination`

The rest of the system feature-flags on these capabilities. If
`write.attendance` is not supported, the sync worker refuses to enable
outbound export and surfaces a clear message on the reconciliation
dashboard.

Concrete implementations planned:

- **`GreythrApiClient`** — REST/OAuth 2.0 against Greytip's official
  API. Endpoint paths and payload shapes populated from the official
  documentation URL once obtained.
- **`GreythrCsvClient`** — reads inbound files from a designated S3
  prefix that the admin (or greytHR support team) uploads to; writes
  outbound files to a different S3 prefix for the admin to download and
  upload into greytHR's bulk-import UI.
- **`GreythrMockAdapter`** — WireMock-backed adapter used exclusively
  in `tests/contract-greythr/` and local dev.

### 2. Feature-flag lifecycle

Three distinct operational modes, controlled by
`INTEGRATION_GREYTHR_ENABLED` plus `INTEGRATION_GREYTHR_MODE`:

| Mode | Meaning | When we use it |
|---|---|---|
| `off` | Sync worker not running. Admin UI hides greytHR panels. Phase 1 default. |
| `dry_run` | Inbound sync runs. **Outbound export is disabled**. Used for validating field mapping against real greytHR data before writing anything. |
| `active` | Full inbound + outbound. Reconciliation dashboard is live. |
| `csv_only` | Adapter is `GreythrCsvClient`. Everything else works, but exports produce files on S3 and expect admin uploads for inbound. |

Transitioning from `off` → `dry_run` → `active` requires an admin
action recorded in `audit_log`. Downgrading (e.g. temporary
degradation) is also recorded.

### 3. Sync worker architecture

Node.js worker process on ECS Fargate, independent from the API
service. Redis Streams coordinates jobs so the worker can scale
horizontally without duplicating work.

Jobs:

| Job | Cadence | Idempotency key |
|---|---|---|
| `employee.full_sync` | Weekly Sunday 02:00 IST | `full-sync-<year-week>` |
| `employee.delta_sync` | Every 15 min | `delta-<since-ts>` |
| `holiday.sync` | Nightly 03:00 IST | `holiday-<year>` |
| `leave.sync` | Every 30 min | `leave-<since-ts>` |
| `shift.sync` | Every 30 min | `shift-<since-ts>` |
| `attendance.export` | Daily 05:30 IST prior day, and on manager approval | Per record — see §4 |
| `payroll_period.export` | On period close + on-demand | `period-<id>` |
| `health.probe` | Every minute | — |

Each job:

- Runs inside a distributed lock keyed on the job name + interval, to
  prevent duplicate concurrent runs across workers.
- Emits structured logs with `correlation_id` per invocation.
- Writes a `sync_import` or `sync_export` row for every meaningful
  action, so the reconciliation dashboard reflects reality.
- Uses the adapter's capability set to skip steps the current adapter
  cannot perform.

### 4. Idempotent outbound export

Every attendance export row carries:

```
idempotency_key = sha256(
  timesheet_id || '|' ||
  timesheet_version || '|' ||
  payroll_period_id
)
```

The `sync_export` table (per ADR-0005 states) tracks lifecycle:

```
NOT_READY → PENDING_APPROVAL → READY_TO_EXPORT →
EXPORTING → EXPORTED
                │
                ├─ EXPORT_FAILED  → (retry) → EXPORTING
                └─ REQUIRES_REVIEW (after max retries or on hard error)

Late corrections → SUPERSEDED
```

Rules:

1. A record leaves `PENDING_APPROVAL` only when a matching `approval`
   row exists (ADR-0003 invariant).
2. Before POST-ing to greytHR, the worker calls
   `checkAttendanceExists(employeeId, date)`:
   - **Not present** → POST. On success, `EXPORTED` with
     `external_reference_id`.
   - **Present with same `idempotency_key`** → treat as already-exported
     (idempotent no-op).
   - **Present with different `idempotency_key`** → **do not overwrite**.
     Flip to `EXPORT_FAILED_CONFLICT`; create a `ReconciliationCase`
     for admin decision (§7).
3. Correction after export: create `timesheet_version = n+1` with new
   `idempotency_key` and status `READY_TO_EXPORT`. The prior version's
   `sync_export` moves to `SUPERSEDED`. The new version exports as a
   correction record (or, if greytHR doesn't support versioned
   attendance, as a delete-then-insert flow at admin's approval).
4. **Never** silently mutate historic records. Every state transition
   writes to `audit_log`.

### 5. Retry, backoff, and rate limits

- **Retry policy:** exponential backoff with full jitter. Base 1 s,
  cap 5 min, max 10 attempts. After the 10th failed attempt the export
  row moves to `REQUIRES_REVIEW`; the worker does not silently discard.
- **`Retry-After` header** is honoured verbatim when present (429 or
  503 responses).
- **Client-side rate limiter** per endpoint: token bucket sized from
  the greytHR-published rate limits at boot. If limits are unknown,
  start conservative — 1 request/second/endpoint — and instrument.
- **Circuit breaker** per endpoint: if the error rate over a 5-min
  sliding window exceeds 50 %, the breaker opens for 2 min, then
  half-opens with a single probe.
- **Alerting:** CloudWatch alarm on `greythr.export.failed_rate > 5 %`
  over 15 min, and on `greythr.circuit_breaker.open` for any endpoint.

### 6. Webhooks (if greytHR supports)

- Endpoint: `POST /v1/integrations/greythr/webhook`.
- Auth: HMAC-SHA256 signature over the raw body using
  `GREYTHR_WEBHOOK_SIGNING_KEY` from Secrets Manager. Header:
  `X-Greythr-Signature: <hex>`. Reject unsigned requests.
- Idempotency: dedupe on greytHR's event ID via a
  `webhook_delivery(event_id UNIQUE, received_at, payload_hash,
  processed_at)` table. Repeated deliveries are treated as no-ops.
- Payload validation against a JSON Schema per event type.
- All processing is asynchronous: the endpoint returns 200 as soon as
  the delivery is persisted and enqueued.

If greytHR does not support webhooks, termination is discovered via the
`employee.delta_sync` job's 15-min cadence. Acceptable for MVP.

### 7. Reconciliation dashboard (integration slice)

Extends the reconciliation dashboard in ADR-0005 §9 with:

- **Export status board** — counts per `sync_export.status`; drill-down
  to individual records.
- **`EXPORT_FAILED_CONFLICT` queue** — records where greytHR already had
  attendance for the same employee+date under a different idempotency
  key. Admin picks: overwrite (only if greytHR API supports safe
  versioning), abandon (mark as `SUPERSEDED` in our system), or open a
  ticket in greytHR itself.
- **Late-correction lineage view** — for any exported record, show
  every version and the associated `sync_export` chain.
- **Rate-limit and circuit-breaker health** — visible so admins know
  when to pause exports voluntarily (e.g., ahead of a greytHR
  maintenance window).

Every action on the dashboard writes to `audit_log` and never mutates
`time_event`, `time_session`, or original `timesheet` rows.

### 8. Secrets and configuration

Secrets in AWS Secrets Manager (path prefix `cloudpunch/greythr/`):

- `client_id`, `client_secret` (if OAuth 2.0 client-credentials)
- `api_key` (if API-key auth)
- `webhook_signing_key`
- `sftp_private_key` (only if CSV mode requires SFTP)

Runtime configuration (non-secret, in SSM Parameter Store):

- `GREYTHR_BASE_URL`
- `GREYTHR_TENANT_CODE`
- `GREYTHR_AUTH_MODE` — `oauth_cc | api_key | csv`
- `GREYTHR_MODE` — `off | dry_run | active | csv_only`
- Rate-limit overrides
- Feature toggles per capability

Rotation policy: 90 days for OAuth secrets and API keys unless
greytHR's policy is stricter. Webhook signing key rotated every 6
months with a graceful overlap window.

Redaction: every log line from the greytHR client passes through a
redaction layer that scrubs `client_secret`, `api_key`, and any header
matching `/authorization/i`. Redaction rules live in
`apps/backend/src/observability/redactors.ts` and are unit-tested.

### 9. CSV fallback specifics (`csv_only` mode)

If greytHR's plan lacks the write API entirely:

**Outbound flow:**

1. `attendance.export` job runs on schedule.
2. For every `READY_TO_EXPORT` row, generate a spreadsheet-safe row
   (per §11 formula-injection protection).
3. Write two files to
   `s3://<cloudpunch-bucket>/greythr-outbound/<batch-id>/`:
   - `attendance_YYYY-MM-DD.xlsx` — the actual payroll batch.
   - `manifest.json` — batch metadata, idempotency keys, record hashes.
4. Admin downloads the batch via the reconciliation dashboard, uploads
   to greytHR's bulk-import UI, then marks the batch as *Imported* in
   CloudPunch. `sync_export` rows flip to `EXPORTED` with the batch
   reference.

**Inbound flow:**

1. Admin uploads greytHR-produced files (employee master, holidays,
   leave) via the dashboard.
2. Server validates against the CSV schemas in
   `packages/shared/src/integrations/greythr-csv-schemas/`.
3. The same reconciliation, matching, and audit rules from ADR-0005
   apply.

CSV mode is not a permanent shape — the code is identical because it
lives behind the adapter interface.

### 10. Employee-mapping expectations

Per ADR-0005, matching is by `greythr_employee_id`, `employee_number`,
or exact `work_email` (case-insensitive). We restate the rule here so
the integration engineer does not accidentally use email as a join key:

- **Primary key on greytHR side:** the `greythr_employee_id` returned
  by the employee endpoint.
- **CloudPunch mirror column:** `employee.greythr_employee_id`.
- **Never** join on email in scheduled queries. Email is display-only.

### 11. Formula-injection protection on exports

Every string cell in an XLSX or CSV export that starts with `=`, `+`,
`-`, or `@` is prefixed with a leading `'` (single quote) before write.
This is enforced by a helper in
`apps/backend/src/exporters/xlsx-safe.ts` and unit-tested. Same rule
for CSV.

### 12. Testing

- **Contract tests** live in `tests/contract-greythr/`. Every capability
  in `CapabilitySet` has a positive test and at least one negative
  (timeout, 429, malformed response).
- **Property tests** on the idempotency key: for a set of random
  `(timesheet_id, version, period_id)` triples, the key is stable,
  collision-free, and re-derivable from stored fields.
- **Mock harness:** `GreythrMockAdapter` backed by WireMock. Test scenarios:
  - Full and incremental import success
  - Pagination
  - Rate limit → back off → recover
  - Duplicate export retry (idempotent no-op)
  - Existing greytHR attendance with different key → conflict path
  - Partial batch failure (some records accepted, some 4xx)
  - Reopened timesheet → new version export
  - Webhook signature invalid → 401
  - Webhook duplicate delivery → 200 no-op
  - Termination via webhook and via delta sync
- **Manual runbook items:** the greytHR-required test list from the
  project brief (26 items) is mapped 1:1 to either an automated test
  or a manual runbook step. Every item is tracked in `tests/` or in
  `docs/ops/greythr-release-checklist.md`.

### 13. Rollout plan

Only after ADR-0007 (secrets) and Phase 4 work are complete:

1. Confirm API entitlement in writing from greytHR.
2. Provision test credentials for a **sandbox tenant** if available;
   otherwise, isolate a small pilot group in the production tenant.
3. Populate `docs/integrations/greythr-mapping-rfc.md` with confirmed
   field paths; obtain project-owner sign-off on the mapping table.
4. Deploy in `dry_run` mode in staging. Run all inbound jobs for 2
   weeks. Reconcile daily.
5. Move staging to `active`. Run outbound exports against sandbox (or
   pilot). Reconcile daily.
6. **Bake for at least 2 payroll cycles** in staging before enabling in
   production.
7. Enable in production in `dry_run` first (still inbound only); a
   week later flip to `active`.
8. Never enable outbound in production without a signed-off runbook,
   named owner for the on-call rotation during the transition, and a
   rollback plan that reverts to `csv_only` cleanly.

## Consequences

### Positive

- The system runs in Phase 1 without greytHR at all — no external
  dependency blocks initial adoption.
- The adapter interface means the concrete client (API, CSV, mock) is
  swappable at runtime; contract tests protect against silent
  behaviour drift.
- Idempotent, versioned outbound with `checkAttendanceExists` before
  writing avoids the "wrote payroll twice" failure mode entirely.
- Failure modes are explicit states, not silent drops. Nothing goes
  into the void.

### Negative

- More moving parts than a single hard-coded HTTP client would need.
  Justified by the unknowns and the operational safety this buys.
- The circuit breaker + rate limiter mean transient greytHR
  degradations can push exports into `REQUIRES_REVIEW` even when the
  underlying data is correct. Mitigation: circuit-breaker health is a
  first-class dashboard metric, and admin can force-retry.

### Neutral

- If greytHR later publishes webhooks that supersede the delta-sync
  cadence, we swap the job schedule; the rest of the pipeline is
  unchanged.

## Alternatives considered

### Point-to-point HTTP calls from the API service to greytHR

Simpler surface. **Rejected** — puts synchronous external latency on
user-facing request paths and complicates retry semantics.

### One monolithic sync worker per environment, no distributed lock

Simpler ops. **Rejected** — makes horizontal scaling unsafe. Redis
locks are cheap.

### Skip the adapter interface; write the API client directly

Faster initial delivery. **Rejected** — greytHR API is unconfirmed, and
CSV mode is a real possibility. The interface is a hedge worth its
weight.

### Screen-scrape greytHR

Explicitly forbidden by the project brief. **Rejected**.

## Follow-up

- `docs/integrations/greythr-mapping-rfc.md` — the definitive current
  mapping table, updated once greytHR docs are in hand. Placeholder
  version created next.
- Phase 4 implements `GreythrApiClient` against the confirmed docs.
- Phase 4 also implements `GreythrCsvClient` unconditionally so we have
  a working fallback regardless of API scope.
- Phase 5 wires webhook handling if greytHR supports it.

## References

- ADR-0004 (event/idempotency model) — foundation for the export
  idempotency key.
- ADR-0005 (source-of-truth) — where employee matching lives.
- OWASP guidance on CSV formula injection —
  https://owasp.org/www-community/attacks/CSV_Injection
- Greytip Software API documentation URL — **to be added** once
  provided by greytHR.
