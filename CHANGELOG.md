# Changelog

All notable changes to CloudPunch are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
