# ADR-0015 — Policy storage, resolution, and desktop fetch

- **Status:** Accepted (2026-09-25)
- **Date:** 2026-09-25
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** `docs/policy/idle-policy-defaults.md` (the settings and
  their scopes), `packages/policy-schema/idle-policy.schema.json`,
  ADR-0003 (payability must be reproducible from the event stream and
  the policy in force), ADR-0012 (call-app allowlist moves to policy).
- **Confidence:** High on scopes, resolution and validation (already
  specified by the policy doc). Medium-high on the fetch cadence and
  the "core settings change at the next clock-in" rule.

## Context

The policy doc defines about 28 settings in three scopes and the JSON
schema defines their defaults and ranges. Nothing else exists:

- no table, loader, API, or admin screen;
- the desktop runs on compiled-in `CoreConfig` / `ReminderConfig`
  defaults;
- no document says how the desktop gets policy, what it does offline,
  how a policy is versioned, or what happens when policy changes while
  someone is clocked in.

ADR-0003 requires that pay be reproducible "given the event stream and
the active policy at the time", so each session must be traceable to
the policy it ran under.

## Decision

### 1. Storage

A new table `policy_override` (migration 0003):

| Column | Notes |
|---|---|
| `scope` | `global` \| `department` \| `employee` |
| `scope_id` | NULL for global; `department.id` or `employee.id` otherwise |
| `document` | jsonb, a **partial** policy document valid against the schema |
| `reason` | text; required for `employee` scope, optional otherwise |
| `updated_by_user_id`, `updated_at` | who and when |

One row per (`scope`, `scope_id`). Defaults are not stored: they live in
the schema's `default` keywords (the schema stays the single source of
truth). SSM parameters in `docs/ops/env-vars.md` §2.3 are superseded
for policy; they were never wired.

### 2. Resolution

Effective policy for an employee = schema defaults, then the global
override, then their department's, then their own, **deep-merged per
leaf setting** (most specific wins). The merged document is validated
against the schema; an invalid stored override is a server error, not a
silent fallback. Validation uses `ajv` 8 against
`idle-policy.schema.json` directly (approved dependency).

**Version:** `sha256` of the canonical JSON of the effective document
(the same canonicalisation as events, ADR-0004 §5), shown as
`sha256-<hex>`. The version changes only when the content does, so it
is stable across servers and restarts.

### 3. Read API

`GET /v1/me/policy` (any signed-in user with an employee record):

```json
{ "version": "sha256-…", "policy": { …full effective document… } }
```

The response has an `ETag` of the version. `If-None-Match` with the
current version gets `304 Not Modified`.

### 4. Write API

`PUT` / `DELETE` `/v1/admin/policy/global`,
`/v1/admin/policy/departments/{id}`, `/v1/admin/policy/employees/{id}`,
plus `GET` of each override and of any employee's effective policy.

- **Global:** `admin.policy.write` (Administrator).
- **Department and employee:** `admin.policy.write` **or** a new
  `hr.policy.write` (HR), as the policy doc allows.
- Each write validates the partial document, and writes an `audit_log`
  row with `actor_user_id`, the scope, `previous_value`, `new_value`,
  the reason and a correlation id (policy doc §14).
- There is no web UI yet; the API comes first.

### 5. Desktop fetch and cache

- Fetch after enrollment, at each launch, and every **15 minutes**
  while signed in, sending `If-None-Match`.
- The last good policy (document + version) is cached in the user's
  encrypted outbox. Offline, or when the server is unreachable, the
  cache applies; with no cache, the compiled-in defaults apply
  (identical to the schema defaults).

### 6. When a change applies

- **Immediately:** reminder cadence, long-shift thresholds and quiet
  hours (`reminders.*`, `notifications.quiet_hours_*`). They only
  affect nudges, never recorded time.
- **At the next clock-in:** everything the state machine uses (`idle.*`,
  `break.*`, `away.*`). A session runs under one policy from start to
  finish, so its events can be replayed against that policy.
- `USER_CLOCK_IN` carries `payload.policy_version`, so every session
  names the policy it ran under. Absent (older agents, or no policy
  fetched yet) means the schema defaults.

### 7. Scope of the first implementation

The desktop applies the settings it already has code for: idle
threshold and grace, media debounce, prompt suppression during media,
the silent-call cap, prompt options, note rules for prompts and away
tags, break caps (reminders), reminder cadence, long-shift thresholds,
quiet hours, and the call-app allowlist (§8). The idle watcher's
placeholder 120 s threshold is replaced by the policy value.

Stored and served but not yet acted on: `system.*` (lock/sleep limits),
`integrity.*`, `notifications.rate_limit_per_hour`,
`multi_device.on_second_signin`, `autostart.*`,
`break.meal.min_minutes_before_prompt`, and the payability flags
(payability is computed on the server in a later phase).

*Implementation note (2026-09-25):*
- The idle watcher's 120 s threshold only drives a diagnostic OS
  signal that nothing consumes. Payroll idle is decided by the core's
  1 Hz tick, which uses `idle.threshold_seconds` from the policy, so
  the watcher was left as it is.
- The desktop has no "other" away tag (only phone call, working away
  and meeting). `away.require_note.other` is served but has nothing to
  apply to yet.

### 8. Call-app allowlist in policy (ADR-0012 follow-up)

New schema fields:

- `idle.call_type_apps`: array of `{ "process": "<exe name>",
  "call_type": "teams" | "zoom" | "other" }`, default the compiled-in
  list (`ms-teams.exe`, `teams.exe` → teams; `zoom.exe` → zoom);
- `idle.call_type_ignored`: array of process names never treated as a
  call (default `["ace dialer.exe"]`).

These are configuration, not captured data. ADR-0012's limit is
unchanged: only the call **category** is ever recorded, never the
process name.

### 9. Doc fixes this ADR makes

- The desktop's away-note rule follows the policy doc:
  `away.require_note` defaults `working_away: true, other: true`
  (the desktop only required `working_away`).
- `docs/ops/env-vars.md` §2.3 points here.

## Consequences

- One source of truth for defaults (the schema), one merge rule, one
  version string that means the same thing everywhere.
- Offline launches behave predictably: last known policy, else
  defaults.
- A policy change never alters a session in progress, at the cost that
  a stricter idle setting waits for the next clock-in.
- `policy_version` makes every session auditable against its policy;
  the server can later store old versions by hash for replay.
- HR gains a policy-write capability limited to team and employee
  scopes.
- New dependency `ajv` on the backend.

## Alternatives considered

- **Policy in SSM (env-vars §2.3).** Rejected: overrides already had to
  live in the database, and SSM gives no per-employee scope or audit.
- **Monotonic version counter.** Rejected: a content hash needs no
  coordination and is identical for identical documents.
- **Apply every change immediately, mid-session.** Rejected: a session
  would mix two idle thresholds, breaking ADR-0003's replay rule.
- **Push (WebSocket/SSE) instead of polling.** Deferred: 15-minute
  polling with `304` is cheap and policies change rarely.
- **Hand-written validation instead of `ajv`.** Rejected: it would
  duplicate the schema and drift from it.
