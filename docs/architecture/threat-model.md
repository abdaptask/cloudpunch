# CloudPunch — Threat model (STRIDE-lite)

- **Status:** Living document — refreshed at every phase gate.
- **Last full review:** Phase 0 kickoff, 2026-09-23.
- **Next scheduled review:** end of Phase 1 (auth + identity), then
  end of every subsequent phase.
- **Related:** ADR-0002 (auth), ADR-0004 (event integrity),
  ADR-0005 (source of truth), ADR-0007 (secrets).

## Scope

CloudPunch's threat surface for the purposes of this model:

- **Windows and macOS desktop agent** — installed on employee devices.
- **Web dashboard** — used by employees, managers, HR, admins,
  payroll, auditors.
- **Backend API** — Fastify service on ECS Fargate.
- **Sync worker** — background jobs (greytHR, notifications,
  reconciliation) on ECS Fargate.
- **Aurora Postgres**, **ElastiCache Redis**, **S3** archive buckets,
  **Secrets Manager**, **KMS**, **CloudFront + WAF** edge.
- **CI/CD pipeline** — GitHub Actions with OIDC to AWS + release
  runners that sign macOS and Windows builds.
- **greytHR integration** — API-first with CSV fallback.
- **Microsoft Entra ID tenant `aptask.com`** — external identity
  provider; considered trusted but attackers of Entra are in scope
  where they affect CloudPunch.

**Out of scope for MVP:**

- Physical security of Aurora HSMs (AWS responsibility).
- Full-tenant compromise of Entra (Microsoft responsibility; we
  assume defence in depth via CA + MFA + monitoring).
- Attacks on employee home Wi-Fi or ISP (we require HTTPS + agent
  signature enforcement, but downstream is not ours).

## Assets — what we protect

Ranked by consequences of compromise:

1. **Payable-hours integrity.** If an attacker can inflate or deflate
   hours undetectably, CloudPunch is worthless. Highest priority.
2. **Audit history.** If audit rows can be forged or erased, disputes
   become unresolvable and DPDPA obligations are unmet.
3. **Employee identity mapping.** If one employee's events can be
   silently attributed to another, payroll pays the wrong person.
4. **Access to raw event data.** Even without content capture, event
   timing patterns are personal data under DPDPA. Broad read is a
   privacy incident.
5. **Entra tokens and device keys on employee laptops.** Compromise
   allows attribution of unauthorised events to a real employee.
6. **greytHR credentials.** Broad read/write access into a payroll
   system.
7. **Signing keys** (Tauri updater, code-signing certs). Enable
   supply-chain attacks against every installed agent.
8. **PII in logs.** Retroactive breach source if unredacted.

## Actors

| Actor | Motivation | Capability |
|---|---|---|
| **External attacker on the internet** | Money (data resale, ransom) | Can probe the public API, edge, and public artefacts. Cannot see internal networks. |
| **Malicious employee** | Inflate own hours; steal peer data | Has authenticated Entra access, an enrolled agent, a laptop under partial control. |
| **Malicious manager** | Suppress team members' hours; retaliate | Has Manager role; sees assigned team. |
| **Compromised employee laptop** (malware) | Attacker uses one endpoint to abuse others | Runs as the Windows/macOS user; can read files the user can read, run other processes. |
| **Rogue admin** | Payroll fraud; retaliation; data resale | Full CloudPunch privileges; possibly Entra Global Admin. |
| **Compromised CI/CD** | Supply-chain injection | Can push code, artefacts, and (if signing pipeline is breached) signed binaries. |
| **AWS insider / provider risk** | Rare but exists | Hypothetical control-plane access to KMS or Aurora. |
| **greytHR-side compromise** | Payroll manipulation upstream | Attacker in greytHR could push wrong employee data or accept forged exports. |
| **State-level actor** | Targeted surveillance of a specific person | High skill, patient, out of scope for MVP but noted. |

Trust boundaries where checks matter most: the desktop-agent →
backend, the web-SPA → backend, and the sync-worker → greytHR.

## STRIDE per component

### Desktop agent

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** poofing | An adversarial process on the same machine impersonates the CloudPunch agent and posts events. | Every event is Ed25519-signed with a key in DPAPI/Keychain, only accessible to the current OS user. The backend rejects unsigned or wrong-key events (ADR-0004 §5). |
| **T** ampering | Modify the local SQLite outbox to insert or edit events before sync. | SQLCipher encrypts the DB with a key in DPAPI/Keychain; events are also signed at the moment of state transition, so post-hoc payload edits break the signature. |
| **R** epudiation | "That wasn't me who clocked in / took a long break." | Every event is signed by the device key, carries `oid`, and the audit_log is append-only and hash-chainable in Phase 6. |
| **I** nformation disclosure | Reading tokens from disk. | Tokens in DPAPI/Keychain, not on disk in the clear. Access tokens are memory-only. |
| **D** enial of service | Agent uses excessive CPU / bandwidth. | Debounced watchers; batched ingest; server-side rate limits per device. |
| **E** levation of privilege | Agent runs elevated and is exploited. | Agent runs as user, no admin/root, no drivers, no privileged services. |

### Web dashboard

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** poofing | CSRF, session fixation. | Server-side sessions with HttpOnly + Secure + SameSite=Strict cookie; CSRF double-submit token on state-changing endpoints; MSAL-managed silent renewal. |
| **T** ampering | XSS injecting malicious script. | Strict CSP with a nonce per response; every user-supplied string is escaped at render; DOMPurify for any HTML-carrying field (notes, reasons). |
| **R** epudiation | Manager denies approving a timesheet. | Every approval writes an audit_log row with `oid`, IP, user-agent hash, correlation_id, and before/after snapshots. |
| **I** nformation disclosure | An employee accesses another employee's data by URL manipulation. | Server-side authorization on every endpoint keyed on `oid` + role + scope-of-visibility rules (managers see only assigned team; employees see only themselves). |
| **D** enial of service | Report queries expensive. | Rate limit per role; expensive queries hit read replicas; pagination is mandatory. |
| **E** levation of privilege | Client-supplied role claim is trusted. | Backend ignores client-side role; reads `roles` from the Entra token every request (ADR-0002 §5). |

### Backend API

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** poofing | Forged JWT or accepted expired token. | Full validation per ADR-0002 §5 (iss, aud, tid, sig, exp, nbf, scp); JWKS cache with `kid` miss refresh; 60-s skew tolerance. |
| **T** ampering | SQL injection, parameter manipulation. | Parameterised queries only (no template SQL). Prisma / pgtyped enforces this. Deny-list ESLint rule for raw SQL that concatenates. |
| **R** epudiation | Backend loses an event silently. | `INSERT ON CONFLICT DO NOTHING RETURNING`; results echoed to client per event; outbox at the client persists until it sees the ack. |
| **I** nformation disclosure | Verbose error messages leaking internals. | Errors mapped to safe error codes; stack traces to Sentry only, never to clients. |
| **D** enial of service | Ingest floods; expensive reports. | WAF rate limit at edge; per-token limits in the API; expensive report endpoints run against read replicas. |
| **E** levation of privilege | Broken authorisation rule. | Central permission matrix in `packages/shared/src/permissions.ts`; every route registers its required roles; matrix is property-tested. |

### Sync worker + greytHR integration

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** poofing | Fake webhook posing as greytHR. | HMAC-SHA256 signature verification against a Secrets-Manager-held key; reject unsigned; timestamp binding to prevent replay. |
| **T** ampering | Attacker intercepts our export and modifies payable hours. | TLS 1.2+ pinned CA, request signature (when supported), idempotency key checked on both sides. |
| **R** epudiation | Export was made but greytHR denies receiving it. | Every export writes a `sync_export` row with request/response, idempotency key, and greytHR reference ID. Reconciliation dashboard shows discrepancies. |
| **I** nformation disclosure | Log lines leak the greytHR API key or PII. | Redaction layer scrubs `authorization`, `client_secret`, `api_key`; truncates large bodies; unit tests per key. |
| **D** enial of service | greytHR rate limits us mid-export. | Client-side rate limiter respects `Retry-After`; circuit breaker isolates per endpoint; exports pause cleanly, don't drop rows. |
| **E** levation of privilege | Sync worker has broader Graph permissions than needed. | Scoped IAM role for the worker; Graph client is a single isolated module with its own audit trail. |

### Data at rest

| STRIDE | Threat | Mitigation |
|---|---|---|
| **T** ampering | DBA edits the `time_event` table directly. | Row-level security denies UPDATE/DELETE on `time_event` to every role except `retention_worker`; before-trigger raises exception. All access via audited application paths. Break-glass RDS access alerts on connection. |
| **I** nformation disclosure | S3 archive bucket public. | Block Public Access on. VPC endpoint + gateway for S3 access. Bucket policy restricts to CloudPunch principals + KMS decrypt. |
| **R** epudiation | "The audit log was tampered with." | append-only + hash chain (Phase 6). Even without hash chain, RLS + trigger prevents in-place mutation. |

### CI/CD + signing pipeline

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** poofing | Attacker pushes to a compromised branch and triggers a signed release. | Branch protection on `main`; releases require a merged, reviewed PR; release jobs run only on tag pushes signed by a maintainer. |
| **T** ampering | Malicious build step exfiltrates signing material. | Signing runners are ephemeral, network-restricted, and use OIDC to fetch signing material scoped to a single job. Signing steps do not run in PR contexts. |
| **E** levation of privilege | GitHub Actions token misused. | GitHub OIDC to AWS with per-workflow role trust policy. No long-lived AWS keys. |
| **I** nformation disclosure | Artefacts contain build-time secrets. | Secret scanning on every PR (gitleaks or GitHub Secret Scanning). Deny-list of file names in `.gitignore`. |

## Ranked top threats

Ordered by (likelihood × impact). Numbers are qualitative.

1. **Broken authorisation rule allows an employee to see another
   employee's data** — likely (an easy code slip), high impact.
   *Mitigation:* central permission matrix, property-tested, plus
   E2E tests per role persona (Phase 7 hardening).
2. **Forged event from a compromised employee laptop** — moderate,
   very high impact on payroll.
   *Mitigation:* device-scoped Ed25519 signature per event
   (ADR-0004 §5); admin revocation revokes future events.
3. **Session takeover via stolen cookie** — moderate, high impact.
   *Mitigation:* HttpOnly + Secure + SameSite=Strict, short lifetime,
   server-side session (not JWT), IP + user-agent binding on renewal.
4. **Payroll export duplication or omission** — moderate, high
   impact on payable hours integrity.
   *Mitigation:* pre-export `checkAttendanceExists`, idempotency
   keys, reconciliation dashboard.
5. **Silent clock manipulation** — moderate, moderate impact.
   *Mitigation:* wall vs monotonic sampling, `CLOCK_DRIFT_DETECTED`
   → session frozen + ReviewCase.
6. **Rogue admin disables audit or edits history** — low, catastrophic.
   *Mitigation:* RLS on `audit_log` and `time_event`; break-glass
   IAM alerts; separation of duties (Auditor role can read audit_log
   without write access).
7. **Supply-chain compromise via CI/CD** — low, catastrophic.
   *Mitigation:* signing runners are ephemeral + OIDC-scoped; SBOM
   generated per build; Tauri updater public key baked in binary +
   ships with signature verification.
8. **greytHR credential leak from logs** — moderate, high.
   *Mitigation:* redaction layer + Secrets Manager rotation.
9. **Retention deletion executed early** — low, moderate.
   *Mitigation:* partition-detach + S3 archive before drop;
   legal-hold flag; retention worker requires a dry-run approval
   step.
10. **Notification channel abuse** — low, low.
    *Mitigation:* per-user rate limits; opt-out honoured; templates
    reviewed.

## Residual risks (accepted, documented)

- **Anomaly false positives** could pressure legitimate employees.
  Mitigation: signals never auto-act; human review required; an
  approved-automation and accessibility allowlist exists (Phase 5).
- **Autostart-enabled installations** on personal-feeling devices
  could feel intrusive. Mitigation: default off, admin can enable,
  privacy notice discloses.
- **Mic/camera in-use signal** could be misconstrued as surveillance.
  Mitigation: privacy notice explicitly names the signal, explains
  the boolean nature, and lists what is NOT captured.
- **Managers seeing "on call" state indirectly** — even though
  reports mask ON_CALL as ACTIVE, the state machine records the
  transition. If a manager gains access to raw events via an audit
  role, they could infer call activity. Mitigation: only Auditors
  see raw events; Manager view is derived and does not surface
  ON_CALL.

## Review cadence

| Trigger | Review depth |
|---|---|
| End of each phase | Full pass through this document; update statuses; add new threats surfaced during that phase. |
| Any incident affecting confidentiality, integrity, availability, or auditability | Ad hoc; add lessons learned. |
| Major dependency upgrade (Fastify, Tauri, MSAL) | Focused review of impacted rows. |
| Annually at minimum | Full re-review even if no phases changed. |
| Any change to authentication, authorization, or the event schema | Blocks merge until this document is updated. |

## What this document is not

- Not a security policy — that lives in `docs/policy/`.
- Not a pen-test report — that comes in Phase 7 from a third party.
- Not a compliance certification — DPIA is a separate document.
- Not a substitute for `security.txt` or an incident-response runbook.

## References

- Microsoft STRIDE overview —
  https://learn.microsoft.com/security/adaptive-cloud/threat-modeling-tool-mitigations
- OWASP ASVS v4 — https://owasp.org/www-project-application-security-verification-standard/
- CIS Benchmarks (AWS Foundations, PostgreSQL) —
  https://www.cisecurity.org/benchmark/
- DPDPA 2023 — https://www.meity.gov.in/data-protection-framework
