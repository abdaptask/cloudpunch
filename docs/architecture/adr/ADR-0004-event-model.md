# ADR-0004 — Event model, idempotent ingest, and integrity metadata

- **Status:** Accepted (Phase 0)
- **Date:** 2026-09-23
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Confidence:** High on the append-only shape, ULID, and idempotency
  contract. Medium on the partitioning granularity (monthly is the
  starting point; may revisit at Phase 6 if volume warrants).
- **Related:** ADR-0003 (states and transitions consumed here).

## Context

Every observable moment in a CloudPunch employee's day is expressed as one
or more `time_event` rows. These events are the ground truth from which
timesheets, payroll totals, integrity signals, audit logs, and reports
are derived. They must be:

- **Immutable** — no update, no soft-delete masquerading as one. A
  correction is a new row, not a mutation.
- **Idempotent to ingest** — the same event submitted twice from a client
  retry has no additional effect.
- **Ordered per session** — the reconstructed state machine of ADR-0003
  requires strict ordering within a session.
- **Tamper-evident** — an event signed by a revoked device or with a
  bad signature is rejected.
- **Privacy-clean** — no field may carry keystroke content, filenames,
  window titles, or any of the banned surveillance signals.

## Decision

### 1. Storage table `time_event`

PostgreSQL, monthly range-partitioned on `server_ts`. Column list:

| Column | Type | Notes |
|---|---|---|
| `event_ulid` | `char(26)` PRIMARY KEY | Client-generated Crockford ULID; monotonic per session. |
| `event_type` | `text` NOT NULL | One of the enum values in `packages/event-schema/event-types.json`. |
| `session_id` | `uuid` NOT NULL | FK → `time_session(id)`. |
| `employee_id` | `uuid` NOT NULL | Denormalised for partition-pruning and index locality. |
| `sequence_number` | `integer` NOT NULL | Starts at 1, monotonic per `session_id`. Unique with `session_id`. |
| `client_ts` | `timestamptz` NOT NULL | Wall clock on the device at event creation. |
| `server_ts` | `timestamptz` NOT NULL DEFAULT now() | Set by the ingest service. Partition key. |
| `monotonic_ns` | `bigint` NOT NULL | Nanoseconds since session start on the device's monotonic clock. Used to detect wall-clock manipulation independent of `client_ts`. |
| `tz_iana` | `varchar(64)` NOT NULL | e.g. `Asia/Kolkata` at event time. Retained even if the employee changes region later. |
| `utc_offset_minutes` | `smallint` NOT NULL | For display and DST audits. |
| `device_id` | `uuid` NOT NULL | FK → `device(id)`. |
| `app_version` | `varchar(32)` NOT NULL | Semver of the desktop agent. |
| `origin` | `text` NOT NULL | Enum: `user`, `system_watcher`, `server`, `reconstructed`. |
| `offline_captured` | `boolean` NOT NULL | `true` if the device recorded this while offline. |
| `payload` | `jsonb` NOT NULL DEFAULT `'{}'` | Event-specific data. Validated against JSON Schema at ingest. |
| `integrity_signature` | `bytea` NOT NULL | Ed25519 signature of the canonical event bytes with the device's enrolled private key. See §5. |
| `correlation_id` | `uuid` NOT NULL | Trace id across a logical action (a clock-in flow, a batch of retries). Generated client-side, echoed by server. |
| `parent_event_ulid` | `char(26)` NULL | Optional causal link (`PROMPT_TIMEOUT_30S` points at the `INPUT_IDLE_5M` that opened the prompt). |
| `inserted_at` | `timestamptz` NOT NULL DEFAULT now() | Row insertion time (may differ from `server_ts` in rare failover replays). |

**Constraints:**

- `CHECK (client_ts <= server_ts + interval '10 seconds')` — cheap sanity;
  60-s clock skew is handled at the application layer.
- `UNIQUE (session_id, sequence_number)` — enforces per-session ordering.
- `EXCLUDE USING gist (session_id WITH =, tstzrange(client_ts, client_ts) WITH &&)` — deferred; adds only if we see out-of-order duplicates in practice.
- No `UPDATE`, no `DELETE` allowed on `time_event`. Enforced by a
  before-trigger on the table that raises an exception, and by row-level
  security policies denying `UPDATE`/`DELETE` for every role except
  `retention_worker` (which only runs during scheduled partition
  detachment).

**Partitioning:**

- Range partition on `server_ts`, one partition per calendar month
  (`time_event_2026_09`, `time_event_2026_10`, …).
- Partitions are created 3 months ahead by a nightly maintenance job.
- Hot partitions (last 90 days) stay on the primary Aurora writer.
- Cold partitions (older than 90 days) are detached and archived to S3
  via `aws_s3.export_query` (or equivalent COPY pipeline) as **encrypted
  Parquet**, and remain queryable through Athena for the retention
  window.

### 2. Indexes

Only the indexes we actually query on. Every new index requires an ADR
addendum or a follow-up ADR.

| Index | Purpose |
|---|---|
| `time_event_pkey` on `event_ulid` | Primary key + idempotency check. |
| `time_event_session_seq_uniq` on `(session_id, sequence_number)` | Per-session ordering, unique. |
| `time_event_employee_server_ts_idx` on `(employee_id, server_ts DESC)` | Employee timeline queries. |
| `time_event_correlation_idx` on `(correlation_id)` | Trace views + debugging. |
| `time_event_parent_idx` on `(parent_event_ulid)` WHERE `parent_event_ulid IS NOT NULL` | Rare, small. |

BRIN index on `server_ts` inside each partition is created automatically
by the partition maintenance job for cheap range scans.

### 3. Event ULID and monotonicity

- ULIDs (Crockford base32, 26 chars) — 48-bit millisecond timestamp +
  80-bit randomness. Sortable, offline-generable, no coordination.
- **Monotonic ULIDs per session:** the desktop agent uses a per-session
  ULID generator that, when two ULIDs are generated in the same
  millisecond, increments the random portion instead of re-randomising.
  This guarantees `event_ulid` sort order matches event order within a
  session.
- The generator uses the **monotonic clock** for the timestamp portion
  when possible, then reconciles to wall-clock at emission. This prevents
  ULID regression during NTP adjustments.
- Rationale for ULID over UUIDv7: better Rust and TypeScript tooling
  today; identical properties otherwise. If the ecosystem shifts, moving
  to UUIDv7 is a one-time migration since both are 128-bit sortable
  identifiers.

### 4. Sequence numbers

Every `time_event` in a session has a `sequence_number` starting at 1
for the session's first event (typically the `USER_CLOCK_IN` request or
its `SESSION_OPENED` server response, depending on which the client
records first).

Rules:

- Monotonic within a session; each new event increments by 1.
- Server rejects duplicate `(session_id, sequence_number)` with
  `409 { code: "duplicate_sequence" }`.
- Server rejects gaps beyond a **10-event tolerance window** (small gaps
  from batched retries are recoverable; a jump from 12 → 98 indicates
  loss and demands attention). On out-of-tolerance gap, server returns
  `409 { code: "sequence_gap_too_large" }` and the desktop agent
  transitions the session to `ERROR_REQUIRING_ATTENTION`.
- Rationale: ULID gives ordering globally, but sequence numbers give a
  cheap integrity check that survives lossy transports.

### 5. Device enrollment and Ed25519 signing

Every device enrolled to a user has a keypair:

- **Private key** — Ed25519, generated on-device at first launch after
  successful SSO. Stored in **Windows Credential Manager (DPAPI)** or
  **macOS Keychain** (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`).
  Never leaves the device.
- **Public key** — registered server-side during enrollment, stored on
  `device.public_key_ed25519`. Revocable by admin.

Signing:

- The desktop agent computes a canonical byte representation of the event
  — a deterministic JSON serialisation (RFC 8785 JSON Canonicalization
  Scheme, or a strict Rust `serde_json` sorted keys form; we choose the
  latter for simplicity, documented in
  `packages/event-schema/canonicalisation.md`).
- The signature covers the tuple:
  `(event_ulid, event_type, session_id, employee_id, sequence_number,
   client_ts, monotonic_ns, tz_iana, device_id, app_version, payload,
   correlation_id, parent_event_ulid)`.
- Server verifies signature against the device's registered public key
  before writing to `time_event`. Signature-invalid events are rejected
  with `401 { code: "signature_invalid" }` and logged as security events.

Enrollment flow:

1. First launch after SSO. Agent generates keypair.
2. Agent submits a `POST /v1/devices/enroll` request signed with a
   short-lived enrollment JWT derived from the SSO token.
3. Server records `(device_id, employee_id, public_key, os, hostname_hash,
   enrolled_at)`.
4. Server issues a device identity that the agent includes in every
   subsequent request.

*As implemented (2b.4 F3b, 2026-09-25):*
- **Authentication.** The request authenticates with the user's normal
  **Entra access token** (bearer). There is no separate enrollment JWT;
  the server re-validates the token and its `roles` per request
  (CLAUDE.md invariant 6).
- **Device id.** The **agent** generates the `device_id`: a UUID v4
  per user per machine, kept in the OS keystore (ADR-0007 §5). The body
  is `{device_id, os, hostname_hash, public_key_ed25519, app_version}`,
  and the server answers `{device_id, enrolled_at, revoked}`.
- **Re-enrollment.** The agent enrolls on every launch and sign-in. The
  same device and user refreshes the key; a different user returns 409.
- **Identity.** The employee id comes from `GET /v1/me`, not from
  enrollment.

Revocation:

- Admin can revoke a device via the CloudPunch admin UI.
- Revocation sets `device.revoked_at`. Any event whose `device_id` has a
  non-null `revoked_at` and whose `server_ts > revoked_at` is rejected.
- Revocation does not delete historic events; it prevents new ones.

### 6. Ingest API contract

**Endpoint:** `POST /v1/events`
**Auth:** Entra access token, App Role membership required, plus device
signature per event.
**Body:**

```jsonc
{
  "device_id": "…",
  "session_id": "…",
  "correlation_id": "…",
  "events": [
    {
      "event_ulid": "01J8Q…",
      "event_type": "USER_CLOCK_IN",
      "sequence_number": 1,
      "client_ts": "2026-09-23T09:15:03.412+05:30",
      "monotonic_ns": 0,
      "tz_iana": "Asia/Kolkata",
      "utc_offset_minutes": 330,
      "app_version": "0.1.0",
      "origin": "user",
      "offline_captured": false,
      "payload": {},
      "integrity_signature": "base64url(…)",
      "parent_event_ulid": null
    }
    // up to 100 events per request
  ]
}
```

**Response 200:**

```jsonc
{
  "correlation_id": "…",
  "server_ts": "2026-09-23T03:45:03.719Z",
  "results": [
    { "event_ulid": "01J8Q…", "status": "accepted" },
    { "event_ulid": "01J8R…", "status": "duplicate_noop" },
    { "event_ulid": "01J8S…", "status": "rejected",
      "code": "signature_invalid", "message": "…" }
  ]
}
```

**Status codes:**

- `200` — batch processed; individual items may be accepted, duplicated,
  or rejected. Client must inspect `results` per event.
- `401` — token invalid or missing.
- `403` — role/assignment missing.
- `409` — session-level conflict (session closed elsewhere,
  device revoked, etc.). Batch is not applied.
- `429` — rate-limited. Client backs off per `Retry-After`.
- `503` — service unavailable; client keeps events in outbox.

**Idempotency:** duplicate `event_ulid` is not an error. Server does
`INSERT … ON CONFLICT (event_ulid) DO NOTHING RETURNING *`. If nothing is
returned, the existing row's timestamps are re-fetched and returned. This
gives a retrying client the same view without side effects.

**Result codes per event:**

- `accepted` — new row created.
- `duplicate_noop` — same `event_ulid` already exists with identical
  payload; no-op.
- `rejected: signature_invalid` — signature does not verify.
- `rejected: session_not_open` — event belongs to a `session_id` whose
  `closed_at` is set.
- `rejected: sequence_gap_too_large` — sequence number too far ahead.
- `rejected: duplicate_ulid_different_payload` — replay attack.
  Security event logged, session frozen.
- `rejected: state_transition_invalid` — the event would trigger a
  transition disallowed by ADR-0003 from the current state.
- `rejected: device_revoked` — device is revoked.

### 7. Desktop outbox and sync loop

Local SQLite (encrypted with SQLCipher) has:

```
outbox(
  event_ulid PRIMARY KEY,
  session_id, event_type, sequence_number,
  event_body BLOB NOT NULL,           -- canonical bytes
  integrity_signature BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  last_error TEXT NULL
)
```

Rules:

- Event is written to `outbox` **before** any UI acknowledgement or state
  transition. UI never claims success before the event is durable
  locally.
- A background task drains up to 100 events per batch, ordered by
  `sequence_number`.
- Retry: exponential backoff with full jitter. Base 1 s, cap 5 min, max
  50 attempts. After the cap, escalate to a `ReviewCase` and continue at
  the cap.
- On `accepted` or `duplicate_noop` response, event moves to `sent`
  (retained locally for 7 days for troubleshooting, then purged).
- On `rejected`, event is quarantined; user sees a health notification.
- Outbox drains in strict `sequence_number` order per session to preserve
  the invariant.

### 8. Reconstructed events

Sometimes exact timestamps cannot be observed (crash, forced shutdown).
Rather than inventing values, we mark reconstructed events explicitly:

- `origin = 'reconstructed'`
- `payload.reconstruction_reason` — one of
  `system_shutdown`, `app_crash`, `session_recovered`, `manual_correction`.
- `payload.reconstruction_evidence` — the best-known timestamps and their
  source (last heartbeat, OS event log, agent restart time).
- Reconstructed events are excluded from anomaly detection heuristics for
  false-positive avoidance.
- Manager review UI shows reconstructed events with a warning icon and a
  "please confirm or correct" prompt.

### 9. Payload shape per event type

Per-event JSON Schemas live in
`packages/event-schema/schemas/<event-type>.schema.json` (with
`schemas/common/`). Unknown event types are rejected.

*Status (2026-09-25):* ingest does **not** yet validate each payload
against its JSON Schema. It accepts any JSON object as `payload`, and
the state machine checks the fields it depends on (`break_kind`,
`in_use`, `call_type`, `away_reason`, `trigger`, `response`). Full
per-type payload validation is a follow-up. Until then the CI invariant
(§10) keeps banned field names out of everything the agent writes.

Payloads as the desktop agent sends them today:

```jsonc
// USER_CLOCK_IN: empty under the default policy; otherwise the
// version of the policy the session runs under (ADR-0015 §6)
{ "policy_version": "sha256-…" }

// USER_PROMPT_RESPONSE
{ "response": "bio_break", "note": null, "prompt_shown_at": "…" }

// USER_START_BREAK
{ "break_kind": "meal" }

// USER_MARK_AWAY: note only when given
{ "away_reason": "meeting", "note": "Client sync" }

// MEDIA_DEVICE_STATE: call_type only while in use (ADR-0012)
{ "in_use": true, "call_type": "teams" }
{ "in_use": false }

// INPUT_IDLE_5M: input_idle while ACTIVE, silent_call while ON_CALL (ADR-0010)
{ "trigger": "input_idle" }

// PROMPT_TIMEOUT_30S
{}

// SESSION_RECOVERED: origin = "reconstructed" (ADR-0003 §10)
{ "reconstruction_reason": "session_recovered",
  "last_heartbeat_at": "…",
  "recovered_at": "…" }
```

Not emitted yet; shape illustrative:

```jsonc
// CLOCK_DRIFT_DETECTED
{ "wall_delta_ms": 63000, "monotonic_delta_ms": 3000, "sample_window_ms": 30000 }
```

No payload field may match the banned surveillance regex (§10).

### 10. Enforcement — CI invariants

The following automated checks live in `tests/invariants/` and run on
every PR:

1. `no-content-capture.ts` — scans every JSON Schema in
   `packages/event-schema/` for field names matching
   `/(keystroke|screenshot|screen_capture|clipboard|filename|window_title|app_name|url|browser_history|mic_audio|audio_frame|camera_frame|webcam|geolocation)/i`
   (with an allowlist for legitimate uses like `app_version` and
   `hostname_hash`). Match → build fails.
2. `append-only.ts` — parses SQL migrations and Prisma/Drizzle schema
   diffs; any statement containing `UPDATE time_event` or `DELETE FROM
   time_event` fails the build unless the migration is inside the
   `retention_worker` folder.
3. `payability-property.ts` — property test that generates random valid
   event sequences and asserts payable-minute totals are deterministic
   given a fixed policy.
4. `sequence-integrity.ts` — property test that verifies the ingest API
   rejects out-of-order and duplicate sequence numbers.

*Implementation note (2026-09-25):* checks 1 and 2 live in the
`@cloudpunch/tests-invariants` package (`tests/invariants/src/`) and run
with `pnpm test` in CI.
- **no-content-capture** applies the regex above to field names from
  the event JSON Schemas, the shared fixtures, the canonical signed-field
  set, the backend ingest schema, and the keys the desktop's Rust
  actually writes into payloads.
- It also fails on content-capturing Windows APIs (window text,
  foreground window, clipboard, keyboard hooks, screen and audio or
  camera capture), on capture crates, and on webview clipboard, screen
  or media APIs.
- **append-only** covers `time_event` and `audit_log` in migrations and
  production backend code. Tests are excluded: they prove the triggers
  reject those statements.
- Every scanner is unit-tested against planted violations.
- Checks 3 (payability) and 4 (sequence integrity) are follow-ups.
  Payability needs the server-side pay computation, which doesn't exist
  yet. Sequence rules are covered today by the ingest tests.

### 11. Retention and archival

| Table | Hot (Aurora) | Warm (Aurora archived partition) | Cold (S3 Parquet, KMS-encrypted) |
|---|---|---|---|
| `time_event` | 90 days | 90 d – 1 y | 1 y – 3 y default |
| `idle_period` (derived) | 90 days | 90 d – 1 y | 1 y – 3 y |
| `break_period` (derived) | Same | | |
| `activity_summary` (aggregated) | 2 years | | 5 y — small, keeps online |
| `audit_log` | 1 y | 1 y – 2 y | 2 y – 7 y |
| `time_session` | 1 y | 1 y – 3 y | 3 y – 7 y |

**Legal hold:** setting `time_session.legal_hold_until` prevents any
retention detachment for that session's events until the date passes.

**Deletion path:** events past retention have the sequence
`detach partition → export to S3 → attach S3-backed foreign table for
Athena queries → drop the detached partition`. Deletion is not
implemented as `DELETE FROM time_event`.

**Data-subject requests (DPDPA):** an admin export from the admin UI
produces a per-employee bundle containing every event, session, break,
idle period, review case, and audit log for that employee. Format:
zipped NDJSON with a manifest.

## Consequences

### Positive

- One immutable ledger; state, timesheets, reports, and audit all
  reconstruct from the same source of truth.
- Idempotent, signed, ordered ingest resists the specific attack surface
  we care about: replay from a stolen agent, forged events from a
  parallel process, retries from a laggy network.
- Partitioning gives O(1) archival with no full-table scans and keeps
  the hot query path snappy.
- CI invariants make it structurally hard to accidentally introduce
  content capture or event mutation.

### Negative

- Extra local storage on the desktop for signed outbox rows. At ~2 KB per
  signed event and 100 events per session peak, that is 200 KB per day
  — trivial.
- Ed25519 signing per event has a cost: ~0.05 ms per signature on modern
  hardware. Negligible at our rate.
- Partition maintenance is a job that must not be forgotten. We add a
  CloudWatch alarm on the maintenance job's success and a health metric
  on the number of future partitions available (< 1 ⇒ page).

### Neutral

- Moving to UUIDv7 later is a mechanical migration if the ecosystem
  converges. Not blocking.

## Alternatives considered

### Mutable current-state column on `time_session`

Cheaper reads. **Rejected** — mutable state is the source of every
"who changed it?" dispute. The derived cache is fine for reads without
being the ledger.

### Client-generated UUIDv4 as primary key

Not sortable, no time metadata. Idempotency still works, but reasoning
about "did we lose events between T1 and T2?" is harder. **Rejected**
in favour of ULID.

### Server-generated sequence numbers assigned on ingest

Simpler, no client tracking. **Rejected** — during offline capture we
still need per-session ordering. Client-side sequencing is necessary; we
verify it server-side.

### Merkle-hash-chain over events (each event references the hash of the
prior event) for tamper evidence

Elegant. **Deferred** to Phase 6 hardening — Ed25519 signatures per
event plus append-only enforcement give us most of the property today.
If we introduce hash-chaining, it lives on top of what's above without
schema breakage.

### Event bus (Kafka / MSK) as the write path

Rejected already in ADR-0001 for MVP. Redis Streams is enough; adding
Kafka is a future upgrade if throughput demands it.

## Follow-up

- Phase 1: create `packages/event-schema` with the canonicalisation
  spec, per-event JSON Schemas, TS + Rust codegen from the schemas.
- Phase 1: seed migration `0001_time_events.sql` implementing the table,
  partitions, indexes, and triggers.
- Phase 2: implement the outbox and sync loop on the desktop; write the
  ingest endpoint; property tests for sequence and idempotency.

## References

- ULID spec — https://github.com/ulid/spec
- RFC 8785, JSON Canonicalization Scheme —
  https://www.rfc-editor.org/rfc/rfc8785
- PostgreSQL declarative partitioning —
  https://www.postgresql.org/docs/16/ddl-partitioning.html
- Ed25519 signature — https://ed25519.cr.yp.to/
- ADR-0003 — state transitions consumed by this event model.
