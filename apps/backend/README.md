# @cloudpunch/backend

Fastify + TypeScript backend service for CloudPunch. Runs on Node 20 LTS.

## Layout

```
src/
  server.ts       — process entry point (env load, listen, signal handlers)
  app.ts          — Fastify factory (no listen; used by tests)
  config/         — zod-validated env + Parameter Store fetchers
  logging/        — pino + PII redactors (ADR-0007 §11)
  health/         — /livez, /readyz, /deep-healthz
  auth/           — JWKS caching, Entra token verification, role guard
  observability/  — OpenTelemetry init (stub in Phase 1)
```

## Run locally

Requires the env vars in `docs/ops/env-vars.md`. For local dev an
example `.env.example` will land in Phase 1c; do NOT commit real
secrets.

```
pnpm -F @cloudpunch/backend dev
```

## Auth model

See [ADR-0002](../../docs/architecture/adr/ADR-0002-entra-app-registrations.md).

Every protected route validates the Bearer token server-side against
Entra's JWKS (`iss`, `aud`, `tid`, signature, `exp`, `scp`), extracts
the `roles` claim (filtered against `@cloudpunch/shared`'s registered
AppRole list), and gates by capability via `requireCapability(...)`.

Client-supplied role information is **never** trusted. The `roles`
claim from the token is authoritative.
