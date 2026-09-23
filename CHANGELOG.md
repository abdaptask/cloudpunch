# Changelog

All notable changes to CloudPunch are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Phase 2b.5.1 — OS watcher plumbing + Windows idle detection (2026-09-23)

First watcher slice per ADR-0003. Cross-platform seam + Windows idle
detection via `GetLastInputInfo`. Session, power, mic/cam, and network
watchers land in 2b.5.2 – 2b.5.5.

- `apps/desktop/src-tauri/src/watchers/mod.rs`: cross-platform `OsSignal`
  enum (idle, session lock/unlock, sleep/wake, mic/cam boolean, network
  reachability) and `Watcher` / `WatcherHandle` traits. Deliberately
  narrow — no app names, window titles, or device identifiers, per
  invariant 1 (no content capture).
- `apps/desktop/src-tauri/src/watchers/supervisor.rs`: mpsc fan-in that
  owns all watcher handles and blocks on shutdown so no signal is lost
  in flight.
- `apps/desktop/src-tauri/src/watchers/idle.rs`
  (`#[cfg(target_os = "windows")]`): `IdleWatcher` polls
  `GetLastInputInfo` / `GetTickCount` and emits `IdleSince` /
  `IdleEnded` on threshold crossing. Threshold-transition logic is a
  pure function tested against synthetic inputs; a `LastInputSource`
  trait lets the poll loop be integration-tested with a mock.
- `Cargo.toml`: added `windows = "0.58"` (target-gated to Windows) with
  features `Win32_Foundation`, `Win32_System_SystemInformation`,
  `Win32_UI_Input_KeyboardAndMouse`.
- 30 tests pass (7 new: 5 pure idle-transition + 2 mocked watcher
  integration + 2 supervisor fan-in and shutdown).
- Known cosmetic: MSVC linker emits `LNK4099` warnings for vendored
  OpenSSL object files (no PDB shipped upstream). Functional impact
  zero.

Refs: ADR-0003 §OS signals, invariant 1 (no content capture).

### Phase 2b.3 — SQLCipher local outbox (2026-09-23)

Encrypted append/drain queue for offline events. On-disk state is
inert without the OS-keystore key (verified by test).

- `apps/desktop/src-tauri/src/outbox.rs`: `Outbox` with
  `open` / `open_in_memory` / `enqueue` / `drain` / `mark_sent` /
  `mark_failed` / `get` / `pending_count`. Idempotent enqueue via
  `INSERT OR IGNORE` on the ULID primary key; drain ordered by
  `(next_retry_at, sequence_number)` so retry-scheduled rows fall to
  the back naturally.
- Single `outbox` table with retry accounting (`retry_count`,
  `next_retry_at`, `last_error`) and index
  `outbox_ready_idx (next_retry_at, sequence_number)`. `event_body`
  and `integrity_signature` stored as opaque BLOBs — no field-level
  introspection on the client.
- SQLCipher key applied via `PRAGMA key = "x'<hex>'"` with a raw
  32-byte key (`CIPHER_KEY_LEN = 32`) — not a passphrase. Matches the
  KDF'd key the OS keystore will supply in 2b.4.
- `rusqlite = { features = ["bundled-sqlcipher-vendored-openssl"] }`
  bundles both SQLCipher and OpenSSL from source, so no system OpenSSL
  install is required on any dev machine. Cold builds compile OpenSSL
  (~5 minutes on Windows; needs Strawberry Perl); incremental builds
  unaffected.
- 21 tests pass — including `on_disk_persists_across_reopens_with_the_
  same_key` and `wrong_key_cannot_open_existing_db` which specifically
  prove encryption at rest.

Deferred to later slices: OS-keystore key fetch (2b.4), retry backoff
policy (2b.6), and `PRAGMA rekey` rotation path (follow-up ADR before
GA).

Refs: ADR-0004 §7, ADR-0007 §5.

### Phase 2b.2 — Rust canonicalize + Ed25519 signing (2026-09-23)

Desktop core produces canonical event bytes byte-for-byte identical to
the backend TS implementation and can sign/verify them with Ed25519.
Cross-language conformance is pinned by a golden vector on both sides —
drift on either side fails both suites.

- `apps/desktop/src-tauri/src/event/canonicalize.rs`: `canonicalize(&Value)`
  and `canonicalize_signed_fields(&SignedEventFields)` (16-field signed
  subset). Object keys sorted lexicographically; integers only with the
  JS safe-int range check (±(2^53−1)); minimal C0 escapes; non-ASCII
  preserved as raw UTF-8.
- `apps/desktop/src-tauri/src/event/signature.rs`: `sign_bytes` /
  `verify_bytes` on `ed25519-dalek` 2.x with `default-features = false` +
  `std`/`fast`/`zeroize`/`rand_core`.
- 11 unit + conformance tests pass, including
  `cross_language_golden_vector_matches_ts`.

Refs: ADR-0004 §5, `packages/event-schema/canonicalization.md`.

### Phase 2b.1 — desktop scaffold: Tauri 2 + React (2026-09-23)

Empty window opens on Windows; the frontend proves the Rust ↔ JS bridge
via `@tauri-apps/api getVersion`. No OS integrations yet.

- Cargo workspace at repo root (`resolver = "2"`, release profile tuned
  for small binaries: `opt-level = "s"`, `lto = true`, `panic = "abort"`,
  `strip = true`).
- `apps/desktop/`: Vite + React 18 UI on port 1420, CSP restricted to
  `'self' ipc: http://ipc.localhost`, `chrome108` build target.
- `apps/desktop/src-tauri/`: Rust crate `cloudpunch-desktop` (lib crate
  types `staticlib`/`cdylib`/`rlib` to reserve future mobile targets),
  420×640 fixed window, identifier `com.aptask.cloudpunch`,
  `bundle.active = false` (installers land in 2b.9).
- Placeholder icon set generated via `tauri icon` (dark-blue "C") for
  all Windows/macOS/iOS/Android sizes so `tauri-build` compiles
  regardless of target.
- Windows dev toolchain confirmed: `cargo check` clean after installing
  VS 2022 Build Tools with the C++ workload; `pnpm typecheck` clean;
  existing `pnpm test` suite (258 tests) still green.

Refs: ADR-0001 §Desktop stack.

### Phase 0 — planning and design (2026-09-23)

No code, dependencies, or cloud resources yet. Documentation-only baseline.

**Repository scaffolding**
- Monorepo layout under `apps/{backend,web,desktop}`, `packages/{shared,event-schema,policy-schema}`, `infra/{terraform,signing}`, `tests/{e2e-web,e2e-desktop,contract-greythr}`.
- Top-level: `.gitignore`, `.editorconfig`, `.nvmrc`, `LICENSE` (proprietary), `README.md`, `CLAUDE.md`, `CHANGELOG.md`.
- Git remote `origin` pointing at `https://github.com/abdaptask/cloudpunch.git`.

**Architecture Decision Records**
- ADR-0001 Tech stack (Node.js + Fastify + Tauri 2 + Aurora Postgres, AWS `ap-south-1`).
- ADR-0002 Microsoft Entra app registrations, App Roles, and SSO flows.
- ADR-0003 Time-tracking state machine (12 states, intelligent-idle, mic/cam detection, auto-clock-out).
- ADR-0004 Event model, idempotent ingest, and integrity metadata (append-only, ULID, Ed25519 device signing).
- ADR-0005 Source-of-truth matrix (`employee.source = local_admin | greythr`) and promotion rules.
- ADR-0006 greytHR integration strategy (adapter interface, API-first with CSV fallback).
- ADR-0007 Secrets, keys, and cryptographic material management.

**Design references**
- `docs/architecture/state-machine.md` — practitioner-facing state diagram + "Alice's Wednesday" worked example.
- `docs/architecture/threat-model.md` — STRIDE-lite, ranked threats, review cadence.

**Integration and policy drafts**
- `docs/integrations/greythr-mapping-rfc.md` — inbound/outbound field tables, pending greytHR API entitlement confirmation.
- `docs/policy/employee-privacy-notice.md` — DPDPA-aware, plain-language, explicit on mic/cam state check.
- `docs/policy/idle-policy-defaults.md` — every configurable idle/break/system knob with defaults and ranges.

**Ops**
- `docs/ops/env-vars.md` — full mapping across env vars, Parameter Store, and Secrets Manager.
- `docs/ops/runbook-outline.md` — 40+ runbook stubs prioritised by phase gate.
