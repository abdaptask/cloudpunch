# ADR-0045 — Moving to AWS: the small shape for ~60 people

- **Status:** Proposed (2026-10-14). The owner chose to prepare the move
  now and approve the switch separately; the choices below need the
  owner's yes before anything is created in AWS.
- **Date:** 2026-10-14
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0035 (production on AWS: the plan, kept for when
  there's a budget), ADR-0001 (stack: ECS Fargate, Aurora PostgreSQL,
  `ap-south-1`), ADR-0007 (secrets and keys), ADR-0019 (the pilot VM),
  ADR-0034 (releases).
- **Amends, if accepted:** ADR-0035 §1–3 (load balancer, NAT gateway,
  Aurora, S3 downloads), for the first production setup only.
- **Confidence:**
  - High on the shape: one container image, one database, Cloudflare in
    front, as ADR-0035 says.
  - High that the tunnel works from a container: it is the same
    `cloudflared` the VM runs today.
  - Medium on the costs: list prices, before any ApTask discount.

## Context

ADR-0035 planned production on AWS at ~$165–285 a month: two Fargate
tasks behind an Application Load Balancer, a NAT gateway, Aurora
Serverless v2 in two AZs, and downloads moved to S3 (a code change). The
owner then chose to stay on the internal VM (no spend), with backups and
alerts.

On 2026-10-14 the owner asked to move off the VM, prepared now and
switched separately. CloudPunch serves about 60 people. Since ADR-0035:

- **Cloudflare Access is gone** (2026-10-13): the site is public through
  the tunnel, and every page and API call checks the Microsoft sign-in
  itself. Nothing in front has to stay in sync with the origin.
- **The tunnel already does the load balancer's job:** Cloudflare
  terminates TLS and forwards to `localhost:8080`. `cloudflared` runs as
  well in a container as on the VM.
- **The app reads downloads and the IP database from folders**
  (`DOWNLOADS_DIR`, `DBIP_ASN_MMDB`).

## Proposed decision

1. **Edge: the Cloudflare tunnel, from inside the task.** Each API task
   runs `cloudflared` beside the app, connecting out to Cloudflare. A
   new tunnel, `cloudpunch-aws`, gets the hostname at the cutover.
   - No load balancer, and **no inbound port at all**: the tasks'
     security group has no inbound rules.
   - Switching and switching back is one setting in Cloudflare (which
     tunnel serves `cloudpunch.aptask.com`), instant both ways.
   - Saves the load balancer (~$20) and makes ADR-0035 §2's "only
     Cloudflare's addresses plus a secret header" unnecessary.
2. **Network: public subnets for the tasks, private for the database,
   no NAT gateway.** The tasks get a public IP for outbound calls only
   (Cloudflare, Microsoft, DB-IP, AWS APIs); with no inbound rules,
   nothing can reach them. The database's subnets have no internet
   route. Saves the NAT gateway (~$35–50).
3. **Database: RDS PostgreSQL 16, one `db.t4g.small` instance**,
   encrypted, 14 days of point-in-time recovery, deletion protection,
   TLS required. ~$40 a month instead of Aurora's ~$60–150. A standby
   (`db_multi_az`) doubles that and turns a zone failure from "restore"
   into "fail over in a minute". Aurora Serverless v2 stays one variable
   away (`db_engine = "aurora"`).
4. **Compute: one Fargate task (ARM64, 0.5 vCPU, 1 GB)** with a rolling
   deploy (the new task is healthy before the old stops) and automatic
   rollback. `api_desired_count = 2` adds a second zone. The background
   jobs (shift-start emails, day-end summary) are safe with two tasks:
   every send is claimed in the database first (invariant 4).
5. **Files: EFS** for published installers and the IP database, mounted
   at `/data`, encrypted, backed up. No code change (ADR-0035 wanted S3,
   which needs code); a few hundred MB costs under $1.
6. **Secrets:** Secrets Manager, injected by ECS as environment
   variables at start: the two database URLs, the Graph certificate key
   (written to a private file by the entrypoint) and the tunnel token.
   This is a small step back from ADR-0007's "secrets never in the
   environment", the same as the VM's `api.env` today; reading them
   through the SDK at start can come later.
7. **The VM's timers become EventBridge schedules** running one-off
   tasks from the same image: the IP database daily, the connections
   purge daily. The nightly `pg_dump` isn't needed (RDS backups).
8. **Alarms: CloudWatch to email** (SNS): the API not running, memory,
   server errors in the logs, failed jobs, database CPU and space. The
   outside check (the whole site, through Cloudflare) stays separate.
9. **Deploys:** `scripts/deploy-aws.sh` (build, migrate as a one-off
   task, rolling update) run by the owner; a GitHub OIDC role, limited
   to the `production` environment, is ready for a later workflow.
10. **No staging** (the owner's ADR-0035 answer). The cutover rehearses
    on production's own database before the switch.

## Cost (per month, `ap-south-1`, list prices, rough)

| Item                                        | Default    | With 2 tasks + standby |
| ------------------------------------------- | ---------- | ---------------------- |
| Fargate ARM64, 0.5 vCPU / 1 GB, always on   | ~$17       | ~$34                   |
| RDS `db.t4g.small` + 20 GB gp3 + backups    | ~$42       | ~$85                   |
| Public IPv4 for the task(s)                 | ~$4        | ~$8                    |
| EFS, ECR, Secrets Manager, KMS (6 keys)     | ~$10       | ~$10                   |
| CloudWatch logs and alarms, SNS             | ~$5        | ~$5                    |
| Jobs and data transfer                      | ~$2        | ~$2                    |
| **Total**                                   | **~$80**   | **~$145**              |

Compared with ADR-0035's ~$165–285. Aurora instead of RDS adds about
$20–110. Not counted: the 15 placeholder secrets already in
`secrets-manager.tf` (~$6 if applied; most are for features not built).

## Consequences

- **Positive:** no single machine or person; backups and recovery by
  AWS; deploys without SSH; switching back is instant. Same hostname, so
  no new desktop app and no Entra changes.
- **Negative:**
  - one task and one database zone by default: an AZ outage means
    downtime until restore or failover (the two variables above remove
    that for ~$65 more);
  - Cloudflare stays a dependency (as today);
  - secrets in the task's environment (as in `api.env` today).
- **Unchanged:** all six invariants, the schema and migrations, the
  desktop and web apps, Entra.

## Alternatives considered

- **ADR-0035 as written** (load balancer, NAT, Aurora, S3 downloads):
  more to run and about twice the cost for the same 60 people.
- **One EC2 instance** like the VM: cheapest, but it keeps manual
  patching and a single machine. Rejected again (ADR-0035).
- **App Runner:** no tunnel sidecar and no EFS; it would need a load
  balancer-style public endpoint and S3 downloads.

## Questions for the owner

1. **Database:** RDS `db.t4g.small` single-AZ (proposed, ~$42), with a
   standby (~$85), or Aurora Serverless v2 (ADR-0035, ~$60–150)?
2. **Tasks:** one (proposed) or two (survives a zone outage, +$17)?
3. **Edge:** the tunnel from the task (proposed) instead of ADR-0035's
   load balancer?
4. **Budget:** about $80 a month at the defaults. OK?

## Plan

1. This ADR and the Terraform (plan only), the image and the cutover
   runbook (`docs/ops/aws-cutover.md`). Nothing created in AWS.
2. The owner answers the questions, sets up remote state and runs
   `terraform plan`; reviews it; applies.
3. Rehearsal: a copy of the pilot's data restored into AWS, checked on a
   test hostname. The pilot keeps serving everyone.
4. Cutover at a quiet time (runbook), the VM on standby for two weeks.
