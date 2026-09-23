# ADR-0001 — Tech stack

- **Status:** Accepted (Phase 0)
- **Date:** 2026-09-23
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Confidence:** High on the shape; medium on service-level AWS choices, which
  are re-checked in ADR-0007 (secrets) and future ADRs on data (0004) and
  deployment.

## Context

CloudPunch is a greenfield, internal, India-only, Entra-authenticated time and
attendance platform for apTask remote workers. It must ship a signed Windows
and macOS desktop agent, a web dashboard, a backend API, a relational data
store, and integrations to greytHR (deferred until API access is confirmed).

Non-negotiable constraints locked before this ADR:

- Microsoft Entra ID SSO only (single tenant `aptask.com`), OAuth 2.0 Auth
  Code with PKCE via the system browser on desktop.
- No content capture — OS-level state metadata only.
- Desktop must reliably detect idle, screen lock/unlock, sleep/wake, and the
  microphone/camera in-use state on Windows 10/11 and current macOS + two
  prior major releases.
- Manager-approved timesheets are the sole source for payable hours before
  payroll export.
- Immutable, append-only event history.

## Decision

Adopt the following stack for CloudPunch. Alternatives considered and reasons
for rejection are listed after the table.

| Layer | Choice | Version pin |
|---|---|---|
| Backend language | TypeScript on Node.js | Node 20 LTS (`.nvmrc` = 20.11.1) |
| Backend framework | Fastify | 4.x |
| Backend runtime deployment | AWS ECS Fargate | Latest platform version |
| Web SPA | React + Vite + TypeScript + Tailwind + shadcn/ui + TanStack Query + MSAL.js v3 | React 18, Vite 5 |
| Desktop framework | Tauri 2 | 2.x |
| Desktop core | Rust (stable) | 1.79+ |
| Desktop UI | React + Vite (same conventions as web) | React 18 |
| Primary database | Amazon Aurora PostgreSQL | 16 |
| Event/queue | Redis Streams on Amazon ElastiCache | Redis 7 |
| Object storage | Amazon S3 | n/a |
| Edge + WAF | Amazon CloudFront + AWS WAF | n/a |
| Secrets | AWS Secrets Manager + AWS KMS (customer-managed key) | n/a |
| Observability | OpenTelemetry SDK → AWS CloudWatch (logs, metrics, traces) + Sentry for error tracking with PII scrubbers | n/a |
| Infrastructure as code | Terraform | 1.7+ |
| CI/CD | GitHub Actions | n/a |
| Package manager (Node) | pnpm | 9.x |
| Auth (backend + web + desktop) | Microsoft Entra ID via MSAL Node / MSAL.js / native OS PKCE loopback | MSAL Node 2.x, MSAL.js 3.x |
| Local desktop store | SQLite via `rusqlite` + `sqlcipher` feature | latest stable |
| Windows code-signing | Azure Trusted Signing (or DigiCert EV cert) | n/a |
| macOS code-signing | Apple Developer ID Application + hardened runtime + notarization + stapling | n/a |
| Region | AWS `ap-south-1` (Mumbai) primary; DR to `ap-southeast-1` if promoted later | n/a |

Repository layout is a **pnpm workspace monorepo** with `apps/*`,
`packages/*`, `infra/`, `docs/`, and `tests/*`.

## Consequences

### Positive

- **One language across backend, web, and desktop UI** (TypeScript) reduces
  context-switching and enables the `packages/shared` type library to
  guarantee compile-time DTO parity between server and clients.
- **Rust core in Tauri** gives clean access to Windows Session/Power/Idle APIs
  (`WTSRegisterSessionNotification`, `GetLastInputInfo`,
  `RegisterPowerSettingNotification`, `IAudioSessionManager2`) and macOS
  equivalents (`NSWorkspace` notifications, `CGEventSourceSecondsSinceLastEvent`,
  `IOKit` power notifications, `AVCaptureDevice`) via
  `windows-rs`, `objc2`, and `core-foundation` crates — no fragile Electron
  native modules, no C++ toolchain lock-in.
- **Tauri auto-updater** with Ed25519 signature verification is built-in and
  meets the signed-update requirement without custom code.
- **Aurora PostgreSQL** gives strong constraints, JSONB for anomaly signals,
  partitioning for the event stream, and managed HA. Read replicas cover
  reports without pressuring the write path.
- **AWS in `ap-south-1`** matches an India-only workforce, minimises DPDPA
  transfer complexity, and matches apTask's existing AWS access.
- **MSAL Node / MSAL.js** provide the vendor-supported Entra integration
  and avoid rolling our own OIDC.
- **pnpm monorepo** keeps `node_modules` compact and gives per-package
  dependency isolation without a heavyweight build system.

### Negative

- **Two type systems** (TS and Rust) at the desktop boundary. Mitigated by
  code-generating shared types from JSON schema in `packages/event-schema`
  for both sides (Phase 1 will introduce the codegen script).
- **AWS-and-Microsoft hybrid** means we host on AWS but authenticate against
  Entra. This is common and well-supported, but SREs must understand both.
- **Rust learning curve** if the team is TS-only. Mitigated by keeping the
  Rust surface small: only OS integration, storage, and sync loop.
- **Aurora Postgres is priced by cluster capacity.** Dev/staging will use
  smaller Aurora Serverless v2 min-ACU to keep cost down; prod uses
  provisioned instances.
- **Tauri 2 is younger than Electron** (2.x GA in 2024). Ecosystem risk is
  real but acceptable — official Microsoft, Cloudflare, and 1Password
  products use Tauri.

### Neutral

- **Windows signing** requires either Azure Trusted Signing (subscription) or
  an EV cert from DigiCert / Sectigo / Certum. Cost and procurement lead
  time to be surfaced in the Phase 7 hardening ADR.
- **macOS notarization** requires an Apple Developer Program membership
  (US $99/year). No blocker.

## Alternatives considered

### Backend: .NET 8 + ASP.NET Core

Excellent Entra support (Microsoft.Identity.Web is first-party), strong
performance, mature tooling. **Rejected** to keep one language across
server + web + desktop UI and to align with the shared-types monorepo
approach. Not a technical loss — either would work.

### Desktop: Electron

Fast to prototype and huge ecosystem. **Rejected primarily on installer
weight and the fragility of native N-API modules on both platforms**.
Reliable Windows lock/sleep hooks require `@paymoapp/electron-shutdown-handler`,
`windows-native-notifications`, and a WTS wrapper — three moving parts prone
to breakage on major Node upgrades. Electron would ship a ~150 MB installer
per platform; Tauri targets 5–15 MB. If Rust surface proves too large in
Phase 2, Electron remains a defensible fallback.

### Desktop: Qt (C++/QML)

The most powerful OS surface. **Rejected on hiring/maintenance risk** —
Qt/C++ engineers are scarcer than TS/Rust engineers at apTask's scale, and
the previous WorkSight/EmpMonitor Qt agent was proof-of-concept quality.

### Desktop: Native x2 (WinUI 3 + Swift/AppKit) with shared Rust core

The best OS fidelity but doubles the UI surface. **Rejected for MVP**;
revisit only if Tauri gaps show up in Phase 5.

### Database: MySQL / MariaDB / SQL Server

MySQL and MariaDB are viable but lack JSONB and mature partitioning
compared to Postgres. SQL Server is overkill for this scale and less
comfortable on AWS. **Rejected.**

### Database: MongoDB for the event stream

Considered for the append-only `time_event` collection where the JSON shape
varies. **Rejected** because Aurora Postgres with a JSONB column plus
declarative partitioning covers this shape at our scale, and dual-database
operations add complexity we do not need at MVP.

### Cloud: Azure

The natural pairing with Entra. **Rejected** because apTask has AWS access
already; adding a new cloud contract has procurement overhead. Entra works
identically against AWS-hosted apps.

### Queue: Kafka / Amazon MSK

Overkill at MVP volume (fewer than 10K events/day for a workforce of this
size). **Rejected** for MVP in favour of Redis Streams. Revisit at Phase 6
if event throughput materially grows.

### Monorepo tool: Nx / Turborepo

Both are capable. **Deferred** — pnpm workspaces alone are enough for four
apps and three packages. If build times demand it in Phase 2+ we add
Turborepo without changing the layout.

## Follow-up ADRs required

- **ADR-0002** Entra app registration design (in progress).
- **ADR-0003** Time state machine (with intelligent-idle detection).
- **ADR-0004** Event model and idempotent ingest.
- **ADR-0005** Source-of-truth matrix (`employee.source`).
- **ADR-0006** greytHR integration strategy (API-first with CSV fallback).
- **ADR-0007** Secrets and key management (Secrets Manager, KMS,
  DPAPI/Keychain on desktop, SQLCipher local DB).
- Future: ADR on backup/restore + DR posture; ADR on data-retention.

## References

- Node.js LTS calendar — https://nodejs.org/en/about/previous-releases
- Tauri 2 architecture — https://v2.tauri.app/concept/architecture/
- MSAL Node — https://learn.microsoft.com/entra/msal/node/
- Aurora PostgreSQL — https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/
- DPDPA 2023 — https://www.meity.gov.in/data-protection-framework
