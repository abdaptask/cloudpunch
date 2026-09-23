# CloudPunch

Employee time and attendance platform for remote workers at apTask. Provides
dependable clock in / out, break management, timesheet approvals, reporting,
payroll exports, and privacy-conscious integrity controls — without capturing
private employee content.

## Status

**Phase 0 — planning and design.** No production code, no dependencies installed,
no cloud resources provisioned. Architecture Decision Records and design docs
under `docs/architecture/adr/` are the current source of truth.

## Repository layout

```
apps/
  backend/      Fastify + TypeScript API and workers
  web/          React + Vite admin/employee/manager dashboard
  desktop/      Tauri 2 (Rust core + React UI) Windows/macOS agent
packages/
  shared/       TypeScript types shared across apps
  event-schema/ JSON schema for time events (source of truth)
  policy-schema/JSON schema for admin-configurable policies
infra/          Terraform for AWS ap-south-1
docs/
  architecture/ ADRs, C4 diagrams, state machine, threat model
  integrations/ greytHR mapping and integration RFCs
  policy/       Employee privacy notice, idle policy, HR-review docs
  ops/          Runbooks, env vars, DR, backup/restore
  guides/       Admin, manager, employee, incident-response guides
tests/
  e2e-web/           Playwright end-to-end tests
  e2e-desktop/       Windows + macOS agent tests
  contract-greythr/  Contract tests against greytHR mocks
```

## Non-negotiable invariants

- **No content capture.** No keystrokes, no typed content, no screenshots,
  no clipboard, no filenames, no browser history, no per-app usage,
  no mic audio, no webcam. Only OS-level event metadata (idle, lock/unlock,
  sleep/wake, network up/down) plus a boolean "mic or camera currently in
  use" indicator.
- **greytHR as system of record for identity** once its API is enabled;
  admin-managed employee list is the interim source of truth.
- **Manager-approved timesheets** are the sole authoritative source for
  payable hours before payroll export.
- **Immutable event history.** Raw events are append-only; corrections
  create new versions and never overwrite.
- **Microsoft Entra ID SSO only** for all normal users. No local passwords.

## Working rules for contributors

See `CLAUDE.md` for expectations on commits, code review, ADR discipline,
and the "no destructive action without written approval" rule.

## Getting started

Phase 0 is documentation only. Once ADRs 0001–0007 are approved, Phase 1
scaffolds the auth and identity layer. Do not `npm install`, `cargo build`,
or `terraform apply` until Phase 1 explicitly begins.
