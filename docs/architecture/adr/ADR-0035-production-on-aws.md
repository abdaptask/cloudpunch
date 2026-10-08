# ADR-0035 — Moving CloudPunch from the pilot server to production on AWS

- **Status:** Proposed (2026-10-08), five questions for the owner below
- **Date:** 2026-10-08
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0001 (stack: ECS Fargate, Aurora PostgreSQL 16, S3,
  Secrets Manager + KMS, `ap-south-1`), ADR-0007 (secrets), ADR-0019
  (the pilot on the internal VM), ADR-0002 (Entra registrations,
  break-glass account), ADR-0034 (releases).
- **Supersedes in part:** ADR-0001's "CloudFront + AWS WAF" edge row,
  if question 2 is answered (a).
- **Confidence:**
  - High on the shape: one container, one database; the app has no
    state outside Postgres and the downloads folder.
  - Medium on the cost range, until an AWS account and its discounts
    are known.
  - Medium on the cutover timing, until the pilot's data volume is
    measured.

## Context

Since 2026-09-28 the pilot has run on one internal VM (ADR-0019):

- the API, run by `node` and `tsx` under systemd;
- Postgres 16 on the same machine;
- a Cloudflare Tunnel publishing `cloudpunch.aptask.com`, with
  Cloudflare Access on `/download*` and `/app*`;
- two timers (the daily IP database update and the connections purge);
- the downloads folder, and secrets in `/etc/cloudpunch/api.env`.

That was right for three testers. It has no failover and no off-machine
backups, and it depends on one person's SSH access. Rolling CloudPunch
out to ApTask's workforce needs the production setup ADR-0001 chose.

Facts that shape the decision:

- **Every client talks to `https://cloudpunch.aptask.com`**: the
  desktop app, the updater and the web dashboard. If production keeps
  that name, the move needs **no new app version**. Only the name's
  target changes.
- **The app keeps no state outside Postgres and the downloads.** The
  API holds no sessions, and tokens are validated on every request
  (invariant 6). Moving the database and the downloads moves
  everything.
- **The time history must move intact.** `time_event` is append-only
  (invariant 2). The pilot's history moves by a full dump and restore,
  never by re-ingesting events.
- **Terraform exists** for KMS keys and Secrets Manager
  (`infra/terraform`), never applied. Nothing is applied without the
  owner (README rule).

## Decision

### 1. Shape

```
people ──► Cloudflare (DNS, Access on /download* and /app*, WAF)
              │  only Cloudflare reaches the origin
              ▼
        Application Load Balancer (ap-south-1, 2 AZs, TLS)
              ▼
        ECS Fargate service: the API container ×2 (serves /v1, /app, /download)
              │                    │
              ▼                    ▼
   Aurora PostgreSQL 16      S3 (private): installers, IP database
   Serverless v2, 2 AZs      Secrets Manager + KMS (ADR-0007)
```

- **One container image** (backend and built web app), as on the pilot
  but packaged. Two tasks in two Availability Zones, with the load
  balancer checking `/livez` (and alarms on `/deep-healthz`, which
  checks the database).
- **Aurora PostgreSQL 16 Serverless v2**, with a writer and a reader in
  two AZs:
  - point-in-time recovery for 14 days;
  - a daily snapshot copied to a second region (`ap-southeast-1`), for
    disaster recovery (ADR-0001's DR region);
  - storage encrypted with the data KMS key.
- **S3 for downloads and the IP database.** The API serves
  `/download/*` from S3 instead of a folder; private bucket,
  encrypted, versioned.
- **The timers become EventBridge Scheduler jobs** running the same
  scripts as one-off ECS tasks: the IP database daily, the connections
  purge daily.
- **Secrets move from `api.env` to Secrets Manager.** This covers the
  Graph certificate (ADR-0020), the mail settings and the database
  credentials, which rotate. The service reads them at start.
- **Logs** go to CloudWatch (30 days), with alarms emailed to the owner
  on 5xx errors, failing health checks and database CPU or storage.
  Sentry stays a later choice (ADR-0001).

### 2. Edge: keep Cloudflare (recommended)

- `aptask.com`'s DNS, the Access policies on `/download*` and `/app*`,
  and the tunnel all live in Cloudflare today. Keeping Cloudflare in
  front keeps those policies as they are.
- The origin becomes the load balancer. It accepts only Cloudflare's
  address ranges, plus a secret header that Cloudflare adds and the
  load balancer checks. Without that pair, nobody can bypass Access by
  calling the load balancer directly.
- This replaces ADR-0001's CloudFront + AWS WAF: Cloudflare's WAF does
  that job, and running both doubles the cost and the configuration.

### 3. Network

- A VPC with public subnets for the load balancer and private subnets
  for the tasks and the database.
- One NAT gateway for the tasks' outbound calls (Microsoft sign-in
  keys, Graph, mail). VPC endpoints for S3, Secrets Manager, ECR and
  CloudWatch keep AWS traffic off the NAT.
- The database accepts connections only from the tasks' security
  group. No public endpoint.

### 4. Deploys and migrations

- **Deploy.** A GitHub workflow, `deploy.yml`, run by hand and approved
  by the owner like ADR-0034:
  1. builds the image and pushes it to ECR;
  2. runs the migrations as a one-off ECS task, stopping on failure;
  3. updates the service (a rolling update, so no downtime);
  4. rolls back to the previous task definition if health checks fail.
- **Authentication.** GitHub signs in to AWS through OIDC (no stored
  AWS keys), with a role that can only push to ECR, run the migration
  task and update the one service.
- **Releases.** ADR-0034's pull becomes "copy to S3". Its timer moves
  to a scheduled task.

### 5. Environments

- **`prod`**: everything above.
- **`staging`**: the same Terraform at the smallest sizes (one task,
  Aurora at minimum capacity, scaled to zero overnight), on
  `cloudpunch-staging.aptask.com`. Releases and migrations run here
  first. Question 3 is whether to have it at all.

### 6. Cutover (about one hour, outside India working hours)

1. **Build and test.** Production runs alongside the pilot on a test
   name, with the pilot's data restored as a rehearsal. The testers
   check the desktop app (through a test config) and `/app/` against
   it.
2. **On the night:**
   1. Put the pilot API in maintenance mode: it answers 503, and the
      desktop apps keep their events in the local outbox and retry
      (ADR-0004).
   2. `pg_dump` the pilot and restore it into Aurora.
   3. Compare row counts and the latest `time_event` per person.
   4. Point `cloudpunch.aptask.com` at the load balancer in Cloudflare.
   5. The desktop apps send their queued events, and duplicates are
      ignored (invariant 4).
3. **Rollback.** Point the name back at the tunnel. The pilot stays
   untouched for two weeks, then is backed up and switched off.

### 7. Before the cutover (owner, Entra)

- **The break-glass account** (ADR-0002): a cloud-only Global
  Administrator with no MFA dependency on a phone. Its password is
  sealed and stored offline, and every sign-in alerts. Without it, a
  locked-out admin account could lock ApTask out of CloudPunch's
  roles.
- **Each app registration's redirect and reply URLs** stay the same,
  because the hostname doesn't change.

## Cost (rough, per month, ap-south-1, list prices)

| Item                                   | prod           | staging      |
| -------------------------------------- | -------------- | ------------ |
| Fargate, 2 × (0.5 vCPU, 1 GB)          | ~$30           | ~$10         |
| Aurora Serverless v2 (0.5–4 ACU) + I/O | ~$60–150       | ~$15–25      |
| Load balancer                          | ~$20           | ~$20         |
| NAT gateway + data                     | ~$35–50        | ~$35         |
| S3, Secrets Manager, KMS, CloudWatch   | ~$15–25        | ~$5          |
| Cross-region snapshot copies           | ~$5–10         | none         |
| **Total**                              | **~$165–285**  | **~$85–95**  |

The biggest swing is Aurora capacity under real load. These are
estimates from list prices, not quotes. ApTask's own AWS agreements may
change them.

## Rollout (each step owner-approved)

1. This ADR, with the owner's answers.
2. **Terraform, plan only:** state bucket, VPC, Aurora, ECS, the load
   balancer, S3, Secrets Manager, alarms. Reviewed as `terraform plan`
   output; nothing applied.
3. **Code:**
   - a Dockerfile;
   - `/download` from S3;
   - secrets from Secrets Manager;
   - the timers as one-off tasks;
   - `deploy.yml`.

   Each piece is tested against the pilot, which keeps running as is.
4. **The owner applies staging,** then prod. A rehearsal restore, and
   the testers check it.
5. **Cutover night,** then two weeks of the pilot on standby.

## Consequences

- **Positive:**
  - No single machine or person to lose.
  - Backups off the machine and in a second region.
  - Deploys without SSH.
  - The same name, so no app update for anyone.
- **Negative:**
  - A monthly AWS bill instead of a free internal VM.
  - More moving parts (Terraform, IAM, a load balancer, a NAT
    gateway) that someone has to own.
  - Cloudflare stays a dependency, as it is today.
- **Unchanged:**
  - All six invariants.
  - The data: same schema and migrations, a full copy.
  - Entra.
  - The desktop and web apps.

## Alternatives considered

- **A bigger VM** (EC2, or ApTask's own), the pilot copied as is.
  Cheapest, but it keeps a single machine, manual patching and SSH
  deploys. Fine as a stopgap, not as production. Rejected as the target.
- **CloudFront + AWS WAF, as ADR-0001 said.** It would move DNS or
  duplicate the Access policies, which Cloudflare already enforces.
  This is question 2, option (b).
- **RDS PostgreSQL** (not Aurora), a single small instance. Cheaper at
  this size (~$30–60), but slower failover and no serverless scaling.
  ADR-0001 chose Aurora; question 4 revisits it if cost matters more.
- **App Runner or Lambda.** Less to run, but the timers, the
  long-running calls and the background jobs fit ECS better. ADR-0001
  chose Fargate.

## Questions for the owner

1. **AWS account:** which ApTask account does production go in, and who
   besides you can approve changes there? (Recommended: a separate
   account for CloudPunch, or at least separate `staging` and `prod`
   accounts.)
2. **Edge:** (a) _recommended:_ keep Cloudflare in front; (b) CloudFront
   + AWS WAF, as ADR-0001 said.
3. **Staging:** (a) _recommended:_ yes, at about $90 a month; (b) no:
   rehearse on prod before the cutover, then deploy straight to prod.
4. **Database:** (a) _recommended:_ Aurora Serverless v2 across two
   AZs; (b) RDS PostgreSQL, single AZ, cheaper and slower to recover.
5. **When:** a target date for the cutover. It needs about two weeks
   of build and test after the answers, and a quiet night for the
   move.
