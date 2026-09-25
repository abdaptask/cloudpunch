# ADR-0007 — Secrets, keys, and cryptographic material management

- **Status:** Accepted (Phase 0)
- **Date:** 2026-09-23
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Confidence:** High. This ADR is the reference for every "where do I
  put a key/secret?" question during Phase 1+.

## Context

CloudPunch handles several categories of cryptographic material:

- **Backend service secrets:** database passwords, Redis auth tokens,
  greytHR credentials, webhook signing keys, session-cookie signing keys.
- **Data-at-rest encryption:** Aurora, S3 archives, backups.
- **Desktop client credentials:** Entra refresh/id tokens, the
  per-device Ed25519 keypair from ADR-0004 §5, the SQLCipher key for
  the local encrypted database.
- **Signing certificates:** Windows code-signing (Azure Trusted Signing
  or DigiCert EV), Apple Developer ID for macOS notarisation, Tauri
  updater Ed25519 keypair.

These must:

- Never be embedded in source code, container images, desktop
  installers, or public logs (working-rule constraint).
- Have a documented rotation cadence and owner.
- Support emergency revocation without destroying historical audit
  data.
- Fail closed if the store is unreachable — the system should refuse
  to start, not to fall back to unsafe defaults.

## Decision

### 1. Storage tiering

| Tier | Where | Contents |
|---|---|---|
| **A. AWS Secrets Manager** | `cloudpunch/*` prefix, encrypted with a customer-managed KMS key (`alias/cloudpunch-secrets`) | Every backend service secret. Fetched by SecretId, never by injected env var. |
| **B. AWS KMS customer-managed keys** | Region `ap-south-1` | Encryption-at-rest keys for Aurora, S3, backups, Secrets Manager, and signing-artefact wrapping. |
| **C. AWS Systems Manager Parameter Store** | `cloudpunch/config/*` | Non-secret runtime configuration (feature flags, base URLs, rate-limit knobs). |
| **D. Windows Credential Manager (DPAPI)** | Per-Windows-user vault | Desktop Entra tokens, device Ed25519 private key, SQLCipher master key. |
| **E. macOS Keychain** | Per-macOS-user login keychain, `com.cloudpunch.*` service names, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` | Same categories as (D). |
| **F. GitHub Actions encrypted secrets** | Repository / environment scoped | CI-only credentials: OIDC role assumption ARNs, signing bootstrap tokens. **No** long-lived AWS keys — CI authenticates to AWS via GitHub OIDC. |

### 2. Backend secrets — Secrets Manager layout

Path convention: `cloudpunch/<category>/<name>[/<component>]`.

| Path | Purpose | Rotation | Rotation method |
|---|---|---|---|
| `cloudpunch/db/aurora/master` | Aurora master password | 30 days | AWS-managed rotation |
| `cloudpunch/db/aurora/app-rw` | App read-write role | 90 days | Custom Lambda rotator |
| `cloudpunch/db/aurora/app-ro` | Reporting read-only role | 90 days | Custom Lambda rotator |
| `cloudpunch/redis/streams` | ElastiCache Redis AUTH token | 90 days | ElastiCache-managed |
| `cloudpunch/greythr/oauth-client` | greytHR OAuth 2.0 client_id + client_secret (if applicable) | 90 days | Manual (until greytHR supports rotation) |
| `cloudpunch/greythr/api-key` | greytHR API key (if applicable) | 90 days | Manual |
| `cloudpunch/greythr/webhook-signing-key` | Inbound webhook HMAC verification key | 180 days | Rolling with 7-day overlap |
| `cloudpunch/entra/graph-app-secret` | Client secret for the Graph app permission (`AppRoleAssignment.ReadWrite.All`) | 180 days | Manual portal update |
| `cloudpunch/session/cookie-signing-key` | HMAC key for backend session cookies | 90 days | Rolling with 24-hour overlap |
| `cloudpunch/session/csrf-signing-key` | HMAC key for CSRF token binding | 180 days | Rolling |
| `cloudpunch/sentry/dsn` | Sentry DSN with PII scrubber tag | Rare | Manual |
| `cloudpunch/signing/tauri-updater-private-key` | Ed25519 private key for the desktop auto-updater signatures | Per major-version cadence (see §6) | Manual + coordinated release |
| `cloudpunch/signing/apple-developer-id-p12` | Apple Developer ID Application `.p12` + password | Per cert validity (1 year default) | Manual with 60-day expiry alarm |
| `cloudpunch/signing/apple-app-specific-password` | Notarisation credential | Per Apple ID cadence | Manual |
| `cloudpunch/signing/windows-trusted-signing-account` | Azure Trusted Signing account reference (no private key) | n/a | Managed |
| `cloudpunch/webhooks/outbound-signing-key` | HMAC key for CloudPunch → external webhooks | 180 days | Rolling |

**Fetch pattern:**

- Application reads the SecretId at boot, caches in-process for the
  process lifetime (short — ECS Fargate tasks recycle regularly).
- On rotation, tasks pick up new values on the next task-cycle
  (typical: within an hour). For zero-downtime rotation, the rotator
  writes the new value to `AWSCURRENT` and keeps the previous value at
  `AWSPREVIOUS` for the overlap window; the app validates both during
  overlap.
- No secret is ever read into a shell environment variable that could
  leak via a debugger dump. Values live in process memory only.

### 3. KMS customer-managed keys

| Alias | Purpose | Rotation | Key policy |
|---|---|---|---|
| `alias/cloudpunch-secrets` | Encrypts Secrets Manager entries | Yearly (AWS automatic) | Grants access only to the ECS task role, admins via SSO, and the audit reader role |
| `alias/cloudpunch-data-at-rest` | Aurora, S3 archive bucket, Backups | Yearly | ECS task role for RDS/S3, admin break-glass for restore |
| `alias/cloudpunch-artifacts` | Signing-material wrapping (macOS `.p12`, Tauri key) | Yearly | Release-runner OIDC principal + admin break-glass |
| `alias/cloudpunch-logs` | CloudWatch Logs encryption for sensitive log groups | Yearly | CloudWatch Logs service + admin read |

**Rules:**

- Every key policy is version-controlled in
  `infra/terraform/kms.tf`.
- Every decrypt event is logged by CloudTrail; anomalous patterns
  (unusual principals, out-of-region decrypts) alert to a private
  Slack/email channel.
- Cross-region replication for KMS keys is not enabled at MVP (no
  cross-region DR yet); revisit if DR to `ap-southeast-1` is later
  promoted.

### 4. Non-secret runtime configuration

Everything the app needs that is **not** a credential lives in SSM
Parameter Store at `cloudpunch/config/*`. Examples:

- `cloudpunch/config/greythr/base-url`
- `cloudpunch/config/greythr/tenant-code`
- `cloudpunch/config/greythr/mode` (`off | dry_run | active | csv_only`)
- `cloudpunch/config/idle/threshold-seconds` (default 300)
- `cloudpunch/config/idle/grace-seconds` (default 30)
- `cloudpunch/config/entra/tenant-id`
- `cloudpunch/config/entra/api-client-id`
- `cloudpunch/config/entra/desktop-client-id`
- `cloudpunch/config/entra/web-client-id`

Parameter Store rate limits are more generous than Secrets Manager and
this data is safe to log at debug level.

### 5. Desktop client — token and device-key storage

**Windows:**

- API: `CredWriteW` / `CredReadW`, `CRED_TYPE_GENERIC`, DPAPI-scoped
  to the current Windows user.
- Target-name convention:
  - `CloudPunch/msal/<tenantId>/<clientId>/<oid>` — MSAL cache
  - `CloudPunch/device-key/<oid>` — Ed25519 private key (raw 32 bytes,
    base64url-encoded)
  - `CloudPunch/sqlite-key/<oid>` — SQLCipher key (raw 32 bytes,
    base64url-encoded)
  - `CloudPunch/device-id/<oid>` — the device's enrollment id (UUID;
    not secret, kept beside the key it names; added 2026-09-25, 2b.4
    F3b)
- Roaming: none (DPAPI is per-machine per-user; roaming profiles work
  because DPAPI keys travel with the profile, but a domain-joined
  machine that migrates the profile silently retains access).

**macOS:**

- API: `SecItemAdd` / `SecItemCopyMatching`, `kSecClassGenericPassword`
- Service names:
  - `com.cloudpunch.msal` — MSAL cache
  - `com.cloudpunch.device-key` — Ed25519 private key
  - `com.cloudpunch.sqlite-key` — SQLCipher key
  - `com.cloudpunch.device-id` — device enrollment id (not secret)
- Account name: the user's Entra `oid`.
- Access control: `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`,
  `kSecAttrSynchronizable=false`. Prevents iCloud sync and requires
  the device to be unlocked.
- The Rust `keyring` crate abstracts both platforms; we wrap it with a
  CloudPunch-specific safety layer that validates value shapes before
  return.

**Rules for the desktop:**

- Access tokens are **never** persisted to disk. They live in memory
  only, are wiped on process exit, and are refreshed silently from the
  stored refresh token.
- The Ed25519 private key never leaves the OS secure store. Signing
  operations happen in-process by loading the key, signing, and
  zeroing the buffer.
- SQLCipher receives its 32-byte key via `PRAGMA key = "x'<hex>'"`.
  The key material is zeroed after the PRAGMA call.
- Logout: the app deletes all three vault entries and force-closes the
  encrypted DB. A new sign-in generates new material. The device-id
  entry is kept, so the next sign-in re-enrols the same device with
  the new public key rather than registering another one.

### 6. Tauri auto-updater signing

- Ed25519 keypair generated once at product-launch preparation.
- Public key baked into the shipped binary (a public key is safe to
  ship — Tauri verifies signatures against it).
- Private key stored in `cloudpunch/signing/tauri-updater-private-key`,
  accessible only from the release GitHub Actions job assuming an OIDC
  role scoped to that secret.
- Rotation cadence: with each **major** desktop release. Rotation
  requires bumping the embedded public key, which is why it's
  coordinated with a release. Rolling rotations are possible via
  multi-key support if we ever need one — deferred.
- Signing job runs in a hardened runner (locked-down environment,
  ephemeral, no interactive shell). The private key is decrypted into
  memory, used for signing, and discarded. It never touches the
  runner's disk.

### 7. Code-signing certificates

**Windows:**

- **Preferred: Azure Trusted Signing.** No private key ever exists
  outside Microsoft's HSM. The GitHub Actions runner authenticates via
  federated identity to invoke signing. Zero secret material for the
  Windows cert lives in our vaults.
- **Fallback: DigiCert EV code-signing cert.** If Trusted Signing is
  not procurable, the `.p12` lives in `cloudpunch/signing/*` under
  `alias/cloudpunch-artifacts`, decrypted only inside the signing
  runner. This is a hard-fallback; strongly prefer Trusted Signing.

**macOS:**

- Apple Developer ID Application `.p12` in Secrets Manager, wrapped by
  `alias/cloudpunch-artifacts`.
- App-specific password for notarisation stored alongside.
- Both decrypted only in the macOS runner (self-hosted or
  GitHub-hosted macOS runner with tight IP allow-listing).
- Certificate expiry alerts: CloudWatch alarm 60 days ahead of
  `NotAfter`. Renewal is a manual procurement step recorded in
  `docs/ops/certificate-renewal-runbook.md` (to be written).

### 8. Session and CSRF tokens

- Backend session cookie is a random 128-bit identifier bound to a
  server-side session record. **Not** a JWT — server-side sessions
  make revocation trivial.
- Cookie is HttpOnly, Secure, SameSite=Strict, path `/`, lifetime 1
  hour, renewed on activity.
- Cookie value is HMAC-SHA256 signed with the key from
  `cloudpunch/session/cookie-signing-key`. Rotation is rolling: on
  rotation we accept old and new signatures for 24 hours, then only new.
- CSRF: double-submit cookie signed with
  `cloudpunch/session/csrf-signing-key`. Same rolling-rotation pattern.

### 9. Client-side secrets in the web SPA — there are none

- MSAL.js manages tokens in session storage (per-tab) with in-memory
  access tokens only. No refresh tokens in the browser.
- No API keys, no client secrets. Everything is fetched via authenticated
  API calls.
- If we later add third-party JS (analytics, telemetry) it must be
  self-hosted and reviewed; no arbitrary third-party scripts.

### 10. Break-glass access to secrets

- **IAM user** `cloudpunch-breakglass-secrets` — no console access, MFA
  required, disabled by default via a Service Control Policy.
- Enabling the account requires an explicit approval from a second admin
  (documented in the runbook to be written in `docs/ops/`).
- Access to `cloudpunch/*` secrets via this user emits a CloudWatch
  alert and a PagerDuty page to the on-call.
- Rotation of every touched secret is required within 24 hours after
  break-glass use.

### 11. Logging redaction

Every log line from the backend or the sync worker passes through a
redaction layer:

- Header values matching `/authorization/i`, `/x-.*-signature/i`,
  `/cookie/i` → replaced with `***REDACTED***`.
- JSON body fields matching keys in
  `apps/backend/src/observability/redactors.ts::REDACT_KEYS` (default:
  `password`, `client_secret`, `api_key`, `refresh_token`,
  `access_token`, `id_token`, `integrity_signature`, `signature`,
  `webhook_signing_key`, `sqlcipher_key`, `secret`) → replaced.
- Full body sizes over 4 KB are truncated with a `[TRUNCATED N BYTES]`
  marker (helps prevent accidental payload dumps).
- Sentry has an equivalent scrubber configured server-side.

Unit-tested against a redaction fixture per key.

### 12. Environment variables the app reads at boot

Only non-secret bootstrap values:

```
AWS_REGION=ap-south-1
NODE_ENV=production|staging|development
LOG_LEVEL=info
CLOUDPUNCH_ENV=prod|staging|dev
CLOUDPUNCH_SECRETS_PREFIX=cloudpunch
```

Everything else is fetched from Secrets Manager / Parameter Store by
prefix + name.

### 13. Rotation calendar

| Interval | What rotates | Owner |
|---|---|---|
| Every 30 days | Aurora master password | AWS automation |
| Every 90 days | Aurora app credentials, session/CSRF keys, greytHR credentials, Redis AUTH | Rotator Lambda + manual for greytHR |
| Every 180 days | Webhook signing keys, Entra Graph client secret, outbound webhook signing key | Rotator Lambda / manual portal |
| Every 12 months | KMS CMKs (AWS-managed automatic rotation) | AWS automation |
| Per release | Tauri updater keypair (major versions only) | Release engineer |
| Per validity | Windows + macOS code-signing certs | Release engineer, 60-day alert |

### 14. Failure modes

- **Secrets Manager unreachable at boot:** service refuses to start
  and emits a fatal log line. No fallback defaults. Kubernetes/ECS
  restart policy handles transient outages.
- **KMS decrypt fails:** same. Fail closed.
- **Rotation Lambda fails:** CloudWatch alarm; the previous secret
  remains valid until the overlap window closes, so operations
  continue while the alert is investigated.
- **Break-glass account used without paging on-call:** alarm on the
  alarm — a secondary CloudTrail-based alarm that pages if the primary
  alarm hasn't fired within 60 s of a break-glass IAM event.
- **DPAPI/Keychain read fails on desktop:** the desktop enters
  `ERROR_REQUIRING_ATTENTION`, prompts the user to re-authenticate,
  and re-provisions all vault entries.

## Consequences

### Positive

- Every secret has a documented location, rotation cadence, and owner.
- The desktop never persists anything sensitive to disk in the clear.
- Blast radius of a compromised KMS key is bounded by its scope
  (four separate CMKs).
- CI/CD authenticates via GitHub OIDC — zero long-lived AWS credentials
  in the pipeline.

### Negative

- Secrets Manager cost is nominal but non-zero (about 0.40 USD per
  secret per month at time of writing). At ~15 secrets that is
  ~72 USD/year. Trivial.
- Rotation Lambdas add ops surface. Mitigation: use AWS-managed
  rotators wherever possible; the custom Aurora app-role rotator is
  the only bespoke piece.
- Break-glass workflow has friction. That is the point.

### Neutral

- KMS automatic key rotation only rotates the *backing key* — the
  key material used for envelope encryption. The CMK alias remains
  stable, so consumers do not care. Any manual key replacement
  requires re-encryption; not planned.

## Alternatives considered

### HashiCorp Vault (self-hosted or Vault Cloud)

More featureful, cloud-agnostic. **Rejected** — pure AWS avoids
another vendor, and Secrets Manager + Parameter Store + KMS cover our
needs for a single-tenant, single-region product.

### AWS Systems Manager Parameter Store for secrets

Cheaper. **Rejected** — Parameter Store lacks rotation, per-secret KMS
key choice, and cross-account replication. Fine for non-secret config,
not for credentials.

### Environment variables injected by ECS Fargate at task start

Simplest. **Rejected** — leaks via `env` dumps, memory dumps, and
child-process inheritance. Also complicates rotation (task must
restart). Runtime-fetch from Secrets Manager solves both.

### Store desktop tokens in a plain-text file with a static "obfuscation"

Rejected out of hand; noted here so it's clear it was considered and
denied. DPAPI/Keychain are the right primitives.

### Bake the greytHR API key into the desktop client

The project brief forbids this. Rejected.

## Follow-up

- Phase 1: `infra/terraform/kms.tf` and
  `infra/terraform/secrets-manager.tf` provision the four CMKs and the
  Secrets Manager entries with empty placeholder values that operators
  fill via the AWS console.
- Phase 1: `apps/backend/src/config/secrets.ts` implements the caching
  fetcher with `AWSCURRENT` / `AWSPREVIOUS` overlap handling.
- Phase 2: desktop key vault wrapper in
  `apps/desktop/src-tauri/src/vault/`.
- Phase 6: rotation Lambdas and CloudWatch alarms.
- `docs/ops/certificate-renewal-runbook.md` and
  `docs/ops/break-glass-runbook.md` produced in Phase 7 hardening.

## References

- AWS Secrets Manager rotation —
  https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html
- AWS KMS key policies —
  https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html
- DPAPI overview —
  https://learn.microsoft.com/dotnet/standard/security/how-to-use-data-protection
- macOS Keychain services —
  https://developer.apple.com/documentation/security/keychain_services
- SQLCipher key derivation —
  https://www.zetetic.net/sqlcipher/sqlcipher-api/#key
- Tauri updater signing —
  https://v2.tauri.app/plugin/updater/
