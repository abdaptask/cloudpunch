# Moving CloudPunch from the pilot VM to AWS (ADR-0045)

The VM keeps serving everyone until the switch at **step D**. Steps A–C
build and rehearse alongside it; nothing anyone uses changes until D.
Switching back (step F) is one Cloudflare setting while the VM is
untouched.

**Rule:** nothing here is run without the owner's go-ahead. Terraform
`apply` and every AWS change are the owner's (ADR-0035 answer 1).

## What the owner provides

| What | Why | Where it goes |
| --- | --- | --- |
| AWS account access for Terraform (IAM Identity Center profile, e.g. `cloudpunch-prod`, with admin to create the stack) | create everything | your machine only |
| Approval of the `terraform plan` output | nothing is created before it | — |
| Remote state: an S3 bucket + DynamoDB lock table (or say "local state, kept safe") | Terraform's memory of what exists | `infra/terraform/backend.tf` (TODO) |
| Answers to ADR-0045's four questions | database, tasks, edge, budget | `terraform.tfvars` |
| A new Cloudflare tunnel `cloudpunch-aws` and its token | the AWS side of the switch | secret `app/cloudflared-token` |
| The Graph certificate's private key (ADR-0020, `ENTRA_OBO_CERT_KEY_PATH` on the VM) | People, welcome and alert emails | secret `app/entra-obo-key-pem` |
| The non-secret lines of `/etc/cloudpunch/api.env` (Entra ids, thumbprint, `WELCOME_*`, `ALERT_TO`, `SUPPORT_EMAIL`) | the same settings | `app_environment` in `terraform.tfvars` |
| Two new database passwords (app, migrator) | new roles in AWS | secrets `app/postgres-app-url`, `app/postgres-migrator-url` |
| Alarm email addresses | CloudWatch alarms | `alarm_emails`; each confirms once |
| A quiet window (proposed: **Sunday 05:00–07:00 IST**, which is Saturday evening US Eastern: nobody on shift) | the switch | — |

Not needed on AWS: the Tauri updater key (releases are signed on the
build machines), the Apple credentials, the backup encryption key (RDS
has its own backups; keep the S3 nightly dumps until the VM is retired).

## A. Build (weeks before; no effect on anyone)

1. **Remote state.** Create the state bucket and lock table, then
   uncomment `infra/terraform/backend.tf` with their names.
2. **Variables.** Copy `terraform.tfvars.example` to `terraform.tfvars`
   (git-ignored): `env = "prod"`, the ADR-0045 answers,
   `app_environment`, `alarm_emails`.
3. **Plan.** `terraform -chdir=infra/terraform init && terraform plan
   -out prod.plan`. The owner reads it: one VPC, subnets, security
   groups (the tasks' has **no inbound rules**), KMS keys, secrets
   (placeholders), RDS, EFS, ECR, ECS cluster/service/task definitions,
   schedules, alarms, the deploy role, the transfer bucket.
4. **Apply**, on the owner's yes. The API service starts with no image
   yet and keeps retrying; that's expected until B5.

## B. Fill in and start (no effect on anyone)

1. **Image.** `AWS_PROFILE=cloudpunch-prod scripts/deploy-aws.sh
   --no-migrate` builds and pushes it. The service will start once the
   secrets exist.
2. **Tunnel.** Cloudflare → Zero Trust → Networks → Tunnels → Create
   `cloudpunch-aws` (Cloudflared). Copy the token. **Don't** add
   `cloudpunch.aptask.com` yet; add a test hostname
   `cloudpunch-aws.aptask.com` → `http://localhost:8080`.
3. **Secrets** (AWS console → Secrets Manager, prefix `cloudpunch/prod/app/`):
   - `cloudflared-token`: the token;
   - `entra-obo-key-pem`: the certificate key, the whole PEM;
   - `postgres-app-url`:
     `postgres://cloudpunch_app:<app pw>@<db_address>:5432/cloudpunch?sslmode=require`;
   - `postgres-migrator-url`: the same with `cloudpunch_migrator` and its password;
   - `postgres-admin-url`: the same with `cloudpunch_admin` and the
     password from the RDS master secret (`terraform output
     db_master_secret_arn`). URL-encode passwords with special characters.
4. **Roles.** Run the job once with `bootstrap-roles`:
   ```
   aws ecs run-task --cluster cloudpunch-prod --launch-type FARGATE \
     --task-definition cloudpunch-prod-job \
     --network-configuration "awsvpcConfiguration={subnets=[<task_subnets>],securityGroups=[<task_security_group>],assignPublicIp=ENABLED}" \
     --overrides '{"containerOverrides":[{"name":"job","command":["bootstrap-roles"]}]}'
   ```
   Check its log (`/cloudpunch/prod`, stream `job/…`) says
   `bootstrap-roles: done`. Then set `postgres-admin-url` back to a
   placeholder: nothing needs the master again.
5. **Restart the service** (ECS → service `api` → Update → Force new
   deployment). The API answers `/livez` with an empty database.

## C. Rehearse with the pilot's data (no effect on anyone)

1. **Dump the pilot**, on the VM (read-only for the pilot):
   ```
   sudo -u postgres pg_dump -Fc -d cloudpunch_dev -f /tmp/cloudpunch.dump
   ```
   Copy it to your machine and upload it:
   `aws s3 cp cloudpunch.dump s3://<transfer_bucket>/rehearsal.dump`, then
   `aws s3 presign s3://<transfer_bucket>/rehearsal.dump --expires-in 900`.
   Delete `/tmp/cloudpunch.dump` on the VM.
2. **Restore** into AWS with the job: command `restore`, environment
   override `DUMP_URL=<the signed link>`. Its log ends
   `restore: N time events`. (A rehearsal on a non-empty database: first
   recreate it — drop and re-run B4, or restore into a new RDS from the
   empty snapshot.)
3. **Compare** (both sides, the same queries; each should match):
   ```sql
   SELECT count(*) FROM time_event;
   SELECT count(*) FROM time_session;
   SELECT max(id) FROM schema_migrations;   -- 0018 or later
   SELECT employee_id, max(client_ts) FROM time_event GROUP BY 1 ORDER BY 1;
   ```
4. **Try it** on `https://cloudpunch-aws.aptask.com`:
   - `/livez`, `/readyz` answer `ok`;
   - the web console: add `https://cloudpunch-aws.aptask.com/app/` as a
     redirect URI on the **CloudPunch Web** Entra app for the rehearsal
     (remove it after), sign in, open Team and Reports;
   - a welcome-email preview in People (Graph works);
   - the schedules ran (`dbip-update` puts the IP database on EFS).
5. **Publish the installers to AWS:** copy the VM's
   `/opt/cloudpunch/downloads` into EFS (upload to the transfer bucket,
   then a job: `curl` the signed links into `/data/downloads`).
   `scripts/publish-installer.sh` publishes to the VM by SSH and must
   learn the AWS path before the switch (open item).

## D. The switch (the quiet window, about 45 minutes)

| T | Step |
| --- | --- |
| −1 day | Tell people: "CloudPunch is unavailable Sunday 05:00–06:00 IST; anything you do is saved and sent after." Freeze deploys on both sides. |
| 0:00 | **Stop writes on the VM:** `sudo systemctl stop cloudpunch-api`. The site shows Cloudflare's error page; desktop apps keep events in their outbox and retry (ADR-0004). |
| 0:02 | Final dump on the VM (C1), upload, sign. |
| 0:10 | **Restore** into a freshly bootstrapped database (B4, then C2). |
| 0:20 | **Compare** (C3). Any mismatch: stop here, go to F. |
| 0:25 | **Move the hostname:** Cloudflare → tunnel `cloudpunch` → Public Hostnames → remove `cloudpunch.aptask.com`; tunnel `cloudpunch-aws` → add `cloudpunch.aptask.com` → `http://localhost:8080`. |
| 0:27 | **Smoke test:** `/readyz`; sign in on `/app/`; a desktop app clocks in and out and the events show in Team; `/app/download/` serves an installer. |
| 0:35 | Watch the logs for 10 minutes: queued desktop events arrive; duplicates are answered `duplicate_noop` (invariant 4). |
| 0:45 | Done: tell people. The VM's API stays **stopped** (so nothing writes there) but untouched. |

## E. After

- Keep the VM as it is for two weeks: API stopped, database intact,
  `cloudflared` running (its tunnel just has no hostname).
- Switch off the VM's alert timers that would now complain
  (`cloudpunch-health.timer`) and its backups after the two weeks, then
  archive a final dump.
- Update `docs/ops/pilot-vm.md` and the memory of where production is.
- Deploys from now on: `scripts/deploy-aws.sh` (migrations included).

## F. Going back

- **Before people use AWS (up to 0:35):** move `cloudpunch.aptask.com`
  back to tunnel `cloudpunch`, `sudo systemctl start cloudpunch-api` on
  the VM. Nothing was written to AWS that the VM lacks. About 2 minutes.
- **After people used AWS:** first stop the AWS service (desired count
  0), dump AWS's database with a job (`pg_dump` to the transfer bucket),
  restore it on the VM with `infra/pilot/db-restore.sh`, then move the
  hostname back and start the VM's API. About 30 minutes; the desktop
  outboxes cover the gap.

## Timings and size

The pilot's database is small (well under 1 GB): dump and restore take a
minute or two. The window is mostly checking. About 60 people, none on
shift at the proposed time (India shifts end 18:00 IST; US Eastern
shifts end 03:30 IST).
