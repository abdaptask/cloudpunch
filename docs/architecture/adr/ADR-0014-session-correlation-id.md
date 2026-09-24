# ADR-0014 — One correlation ID per session

- **Status:** Accepted (2026-09-24)
- **Date:** 2026-09-24
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Clarifies:** ADR-0004 (`correlation_id` column and the signed field
  set, §5–§6).
- **Confidence:** High that the current desktop sync loop cannot work
  as written; medium-high that per-session is the right granularity.

## Context

ADR-0004 puts `correlation_id` in the set of 16 fields each event's
Ed25519 signature covers. It travels on the batch envelope, not in the
event body. The backend rebuilds the signed bytes from the event plus
the envelope's `correlation_id`, `device_id`, `employee_id` and
`session_id` (`apps/backend/src/events/ingest.ts`).

The desktop signs each event once, when it happens, and stores the
signed body in the local outbox. The sync loop (`sync/mod.rs`,
`run_tick`) later drains the outbox and sends batches, and it currently
creates a **fresh** `correlation_id` for each batch. So the envelope's
ID never matches the one the event was signed with, and the backend
would reject every event as `signature_invalid`.

Re-signing at send time is not an option: an event must be signed when
it is captured, so an offline event cannot be changed later without
detection (ADR-0004, ADR-0007).

ADR-0004 describes `correlation_id` as a trace ID "across a logical
action (a clock-in flow, a batch of retries)". It does not have to be
unique per request.

## Decision

1. **The desktop creates one `correlation_id` (UUID v4) when a session
   starts** (on clock-in), next to the `session_id`. Every event in the
   session is signed with it.
2. **The local outbox stores it per row**, in a new `correlation_id`
   column alongside `session_id`. The desktop's local SQLite migration
   adds this column; the server database does not change.
3. **The sync loop reuses it.** The envelope for a session's batch
   carries that session's stored `correlation_id`. If one drained group
   somehow holds rows with different IDs, they are split into separate
   batches rather than mixed.
4. **The backend needs no change.** It already verifies against the
   envelope's `correlation_id` and stores it on each `time_event` row.
   Querying by `correlation_id` now returns a whole session: that is
   the trace view.
5. **Per-request tracing** (one retry vs. another) belongs in an HTTP
   request-ID header and server logs, not in `correlation_id`.

## Consequences

- Retries, offline replay and batch splitting all keep valid signatures,
  because the signed context no longer depends on how events are
  batched.
- `time_event_correlation_idx` groups a session's events instead of a
  single request's. That fits ADR-0004's "logical action" wording.
- The desktop needs a local outbox migration (one nullable-then-filled
  column). Outbox rows written before it have no stored ID. Nothing has
  shipped yet, so none exist outside development machines; any such
  rows are dropped on migration.
- The shared fixture `packages/event-schema/fixtures/signed-events.json`
  pins the wire format. The desktop encoder must reproduce it exactly,
  and the backend must ingest it (`signed-events.fixture.test.ts`).

## Alternatives considered

- **Take `correlation_id` out of the signed set.** Rejected: it changes
  ADR-0004's canonical format on both sides, and loosens what the
  signature binds for no real gain.
- **Re-sign each event at send time.** Rejected: an event would then be
  signed long after it was captured, which defeats the tamper evidence.
- **One `correlation_id` per event.** Rejected: the envelope carries only
  one, so every event would need its own batch.
- **One `correlation_id` per device, for its lifetime.** Workable, but
  it makes the trace index useless.
