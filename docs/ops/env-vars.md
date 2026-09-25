# CloudPunch — Environment variables and runtime configuration

- **Status:** Accepted (Phase 0). Populated during Phase 1 with real
  ARNs and paths.
- **Related:** ADR-0007 (secrets and key management).

CloudPunch's runtime configuration is divided into three tiers per
ADR-0007. This file is the master reference for what lives where.

- **Env vars** are read from the process environment at boot. They
  are non-secret bootstrap only.
- **Parameter Store paths** are read at boot and refreshed
  periodically. They are non-secret configuration.
- **Secrets Manager paths** are read at boot and cached in-process;
  secrets never enter environment variables.

If a value belongs in one tier and someone puts it in another, that is
a bug — file it against `apps/backend/src/config/`.

## 1. Bootstrap environment variables (non-secret)

Read at process start. These tell the process how to find everything
else.

| Variable | Example | Required in | Owner | Description |
|---|---|---|---|---|
| `AWS_REGION` | `ap-south-1` | backend, sync worker | Platform | Region for Secrets Manager, Parameter Store, KMS, RDS, S3. |
| `NODE_ENV` | `production` \| `staging` \| `development` \| `test` | all Node processes | Platform | Standard Node convention. |
| `CLOUDPUNCH_ENV` | `prod` \| `staging` \| `dev` | all Node processes | Platform | CloudPunch-specific environment marker. Used for path prefixes and metric labels. |
| `LOG_LEVEL` | `info` (prod), `debug` (dev) | all Node processes | Platform | Log verbosity. |
| `CLOUDPUNCH_SECRETS_PREFIX` | `cloudpunch` | backend, sync worker | Platform | Root of Secrets Manager paths. |
| `CLOUDPUNCH_CONFIG_PREFIX` | `cloudpunch/config` | backend, sync worker | Platform | Root of Parameter Store paths. |
| `PORT` | `8080` | backend | Platform | HTTP port. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4318` | all Node processes | Observability | OpenTelemetry collector. |
| `OTEL_SERVICE_NAME` | `cloudpunch-api` \| `cloudpunch-sync-worker` | per process | Observability | Metric/trace labelling. |
| `SENTRY_ENABLED` | `true` \| `false` | all Node processes | Observability | Emergency kill switch. |

**Rule:** every value here is safe to see in `docker inspect` and
CloudTrail. If a variable would leak a credential when logged, it
belongs in Secrets Manager instead.

## 2. Parameter Store (non-secret configuration)

Path prefix `cloudpunch/config/`. Refreshed every 5 minutes (or on
demand via an admin action). Values below use `<CLOUDPUNCH_ENV>` to
mean per-environment scoping — e.g., `cloudpunch/config/prod/entra/...`.

### 2.1 Entra ID configuration

| Path | Type | Example | Description |
|---|---|---|---|
| `cloudpunch/config/<env>/entra/tenant-id` | String | `12345678-…` GUID | ApTask Entra tenant ID. |
| `cloudpunch/config/<env>/entra/tenant-domain` | String | `aptask.com` | Verified domain. |
| `cloudpunch/config/<env>/entra/api-client-id` | String | GUID | `CloudPunch API` app client ID. |
| `cloudpunch/config/<env>/entra/api-application-id-uri` | String | `api://<GUID>` | Resource URI. |
| `cloudpunch/config/<env>/entra/desktop-client-id` | String | GUID | `CloudPunch Desktop` app client ID. |
| `cloudpunch/config/<env>/entra/web-client-id` | String | GUID | `CloudPunch Web` app client ID. |
| `cloudpunch/config/<env>/entra/authority` | String | `https://login.microsoftonline.com/<tenantId>/v2.0` | OIDC authority. |
| `cloudpunch/config/<env>/entra/jwks-uri` | String | `https://login.microsoftonline.com/<tenantId>/discovery/v2.0/keys` | JWKS endpoint. |
| `cloudpunch/config/<env>/entra/scope` | String | `api://<GUID>/api.access` | Required delegated scope. |

#### Registered values (`aptask.com` tenant, created 2026-09-24)

Non-secret identifiers (ADR-0002 step F). The desktop agent compiles
these in (`auth::EntraConfig::APTASK`) until policy / config fetch
exists.

| Setting | Value |
|---|---|
| Tenant ID | `a6300e5c-dae4-413c-a6d2-646fbc2aa587` |
| `CloudPunch API` client ID | `63bca00e-a546-4f0c-a076-e2450e52406e` |
| API Application ID URI | `api://63bca00e-a546-4f0c-a076-e2450e52406e` |
| Required scope | `api://63bca00e-a546-4f0c-a076-e2450e52406e/api.access` |
| `CloudPunch Desktop` client ID | `13646e0e-abc6-4779-b8fb-fc10bdfdf4b9` |
| `CloudPunch Web` client ID | not created yet (ADR-0002 step C deferred) |
| Authority | `https://login.microsoftonline.com/a6300e5c-dae4-413c-a6d2-646fbc2aa587/v2.0` |

### 2.2 greytHR configuration

| Path | Type | Example | Description |
|---|---|---|---|
| `cloudpunch/config/<env>/greythr/enabled` | String | `false` (default) | Global feature flag. |
| `cloudpunch/config/<env>/greythr/mode` | String | `off` \| `dry_run` \| `active` \| `csv_only` | Operational mode. |
| `cloudpunch/config/<env>/greythr/base-url` | String | `https://api.greythr.com/…` | To be confirmed. |
| `cloudpunch/config/<env>/greythr/tenant-code` | String | ApTask's tenant identifier at greytHR | |
| `cloudpunch/config/<env>/greythr/auth-mode` | String | `oauth_cc` \| `api_key` \| `csv` | |
| `cloudpunch/config/<env>/greythr/rate-limit-rps` | String | `1` | Requests per second per endpoint. |
| `cloudpunch/config/<env>/greythr/webhook-enabled` | String | `false` | |
| `cloudpunch/config/<env>/greythr/csv-outbound-bucket` | String | `s3://…/greythr-outbound` | Only when `mode = csv_only`. |
| `cloudpunch/config/<env>/greythr/csv-inbound-bucket` | String | `s3://…/greythr-inbound` | Only when `mode = csv_only`. |

### 2.3 Idle and policy defaults (fallback if no per-tenant DB row exists)

| Path | Type | Example |
|---|---|---|
| `cloudpunch/config/<env>/idle/threshold-seconds` | String | `300` |
| `cloudpunch/config/<env>/idle/grace-seconds` | String | `30` |
| `cloudpunch/config/<env>/idle/suppress-prompt-when-media-active` | String | `true` |
| `cloudpunch/config/<env>/break/bio/max-minutes` | String | `10` |
| `cloudpunch/config/<env>/break/meal/max-minutes` | String | `60` |
| `cloudpunch/config/<env>/system/max-lock-duration-minutes` | String | `120` |
| `cloudpunch/config/<env>/system/max-sleep-duration-minutes` | String | `120` |
| `cloudpunch/config/<env>/autostart/enabled` | String | `false` |
| `cloudpunch/config/<env>/integrity/clock-drift-threshold-seconds` | String | `60` |
| `cloudpunch/config/<env>/notifications/quiet-hours-start` | String | `22:00` |
| `cloudpunch/config/<env>/notifications/quiet-hours-end` | String | `07:00` |

Policy overrides at team or per-employee scope live in the database,
not here.

### 2.4 Aurora / Redis / S3 endpoints (non-secret)

| Path | Type | Example |
|---|---|---|
| `cloudpunch/config/<env>/aurora/host` | String | `cloudpunch-prod.cluster-...ap-south-1.rds.amazonaws.com` |
| `cloudpunch/config/<env>/aurora/port` | String | `5432` |
| `cloudpunch/config/<env>/aurora/database` | String | `cloudpunch` |
| `cloudpunch/config/<env>/redis/host` | String | ElastiCache cluster endpoint |
| `cloudpunch/config/<env>/redis/port` | String | `6379` |
| `cloudpunch/config/<env>/redis/tls` | String | `true` |
| `cloudpunch/config/<env>/s3/archive-bucket` | String | `cloudpunch-<env>-event-archive` |
| `cloudpunch/config/<env>/s3/exports-bucket` | String | `cloudpunch-<env>-exports` |

### 2.5 Feature flags

| Path | Type | Description |
|---|---|---|
| `cloudpunch/config/<env>/flags/anomaly-signals-enabled` | String | Phase 5 kill switch. Default `false` until Phase 5 ships. |
| `cloudpunch/config/<env>/flags/webhooks-outbound-enabled` | String | Default `false` until Phase 4. |
| `cloudpunch/config/<env>/flags/reports-heavy-enabled` | String | Guard around expensive report queries. |

## 3. Secrets Manager (secret material)

Path prefix `cloudpunch/`. Rotation cadences per ADR-0007 §13.

| Path | Type | Rotation | Rotation method | Notes |
|---|---|---|---|---|
| `cloudpunch/db/aurora/master` | JSON (`{username, password}`) | 30 d | AWS managed | Aurora master. |
| `cloudpunch/db/aurora/app-rw` | JSON | 90 d | Lambda | Read-write app role. |
| `cloudpunch/db/aurora/app-ro` | JSON | 90 d | Lambda | Read-only reporting role. |
| `cloudpunch/redis/streams` | String | 90 d | ElastiCache managed | Redis AUTH token. |
| `cloudpunch/greythr/oauth-client` | JSON (`{client_id, client_secret}`) | 90 d | Manual | Only if `auth-mode = oauth_cc`. |
| `cloudpunch/greythr/api-key` | String | 90 d | Manual | Only if `auth-mode = api_key`. |
| `cloudpunch/greythr/webhook-signing-key` | String | 180 d | Rolling | Overlap window 7 d. |
| `cloudpunch/entra/graph-app-secret` | String | 180 d | Manual portal | For `AppRoleAssignment.ReadWrite.All`. |
| `cloudpunch/session/cookie-signing-key` | String (base64) | 90 d | Rolling | 24-hour overlap. |
| `cloudpunch/session/csrf-signing-key` | String (base64) | 180 d | Rolling | |
| `cloudpunch/sentry/dsn` | String | Rare | Manual | With PII-scrubber tag baked in. |
| `cloudpunch/signing/tauri-updater-private-key` | String (base64) | Per major release | Manual | Never touches runner disk. |
| `cloudpunch/signing/apple-developer-id-p12` | Binary (base64 `.p12`) | Per cert validity | Manual | 60-day expiry alarm. |
| `cloudpunch/signing/apple-app-specific-password` | String | Per Apple cadence | Manual | Notarisation. |
| `cloudpunch/webhooks/outbound-signing-key` | String (base64) | 180 d | Rolling | |

## 4. Environment scoping

Path templates above use `<env>`. Concrete environments:

- `cloudpunch/config/dev/…` — developer local + shared dev
- `cloudpunch/config/staging/…` — staging
- `cloudpunch/config/prod/…` — production

Secrets are similarly scoped (`cloudpunch/db/aurora/master` exists
independently per environment via separate AWS accounts or via
sub-paths — decision recorded in the Phase 1 infra ADR).

## 5. Local development

Developers running the backend locally need:

- AWS credentials able to read `cloudpunch/config/dev/*` and
  `cloudpunch/dev-secrets/*` (via IAM Identity Center / SSO).
- `AWS_REGION=ap-south-1`
- `CLOUDPUNCH_ENV=dev`
- `NODE_ENV=development`

### 5.1 Until AWS exists: the dev VM (2b.4)

The dev database is Postgres on the internal VM (`cloudpunch-abd`),
reached through an SSH tunnel. A git-ignored `apps/backend/.env.local`
holds:

| Variable | Secret? | Notes |
|---|---|---|
| `POSTGRES_URL` | yes | Migrator role: `pnpm migrate`, `pnpm seed:dev`. |
| `POSTGRES_APP_URL` | yes | App role, used by the API. **Honoured only when `CLOUDPUNCH_ENV=dev`** (the one exception to "no secrets in env"; `server.ts` ignores it elsewhere). |
| `CLOUDPUNCH_ENV` | no | `dev` |
| `HOST` / `PORT` | no | `127.0.0.1` / `8080`. Loopback only. |
| `ENTRA_TENANT_ID`, `ENTRA_API_CLIENT_ID`, `ENTRA_API_APPLICATION_ID_URI` | no | Registered values in §2.1. Without them every data route returns 401. |

To run the desktop app against it:

1. Open the tunnel: `ssh -N -L 55432:localhost:5432 aptask@172.16.46.54`.
2. Seed your identity once:
   `pnpm -F @cloudpunch/backend seed:dev -- --oid <your Entra object id> --email <you>@aptask.com --given <first> --family <last>`.
   This creates an active `local_admin` employee and links your
   `app_user` to it. It is idempotent.
3. Start the API: `pnpm -F @cloudpunch/backend dev:local`.
4. Start the desktop app with
   `$env:CLOUDPUNCH_BACKEND_URL = "http://127.0.0.1:8080"`, then
   `pnpm -F @cloudpunch/desktop dev`. The desktop log prints
   "device enrolled" after sign-in.

No real production secret should ever be pulled to a developer
machine. If a developer needs a value that only exists in prod (e.g.,
to reproduce an issue), the on-call engineer produces a redacted
reproduction case rather than sharing credentials.

## 6. Change process

- Adding a new env var, Parameter Store path, or secret path requires
  a PR that updates this file **and** the relevant Terraform module.
- Renaming a path is a breaking change: introduce the new path,
  update all readers, delete the old path in a follow-up PR.
- Removing a path requires confirming no service still reads it.
