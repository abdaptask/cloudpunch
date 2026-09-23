# CloudPunch — Terraform infrastructure

AWS `ap-south-1` primary. Terraform >= 1.7 + AWS provider `~> 5.60`.

## Layout

```
versions.tf         — Terraform + provider version pins
providers.tf        — AWS provider config (assumes IAM Identity Center / OIDC)
backend.tf          — remote state backend (S3 + DynamoDB lock) — placeholder
variables.tf        — env, region, tags, external references
kms.tf              — four customer-managed keys (ADR-0007 §3)
secrets-manager.tf  — Secrets Manager entries with placeholder values (ADR-0007 §2)
outputs.tf          — export ARNs for downstream stacks
terraform.tfvars.example — copy to terraform.tfvars per environment (ignored by git)
```

## Rules

- **Do not `terraform apply`** from this directory without an owner
  sign-off. Every plan is reviewed before apply, and remote state is
  the source of truth once wired up.
- **No secret values** in `.tf` or `.tfvars` files. Secrets Manager
  entries are created with a placeholder JSON body and operators fill
  the real value via the AWS console (or a rotation Lambda).
- **Every KMS key is customer-managed** (`aws_kms_key` + `aws_kms_alias`).
  Automatic yearly rotation is enabled.
- **`sensitive = true`** on every output that could leak an ARN or ID
  in the plan (KMS key ARNs, secret ARNs).

## Environments

Recommend one Terraform workspace per environment:

- `dev`
- `staging`
- `prod`

Environment name flows through the `env` variable and is baked into
resource names and tags.

## Bootstrap

Phase 1 lands the skeleton with placeholder values. The actual
`terraform init` + `terraform apply` happens once:

1. An AWS account is designated for CloudPunch dev (and one for prod).
2. IAM Identity Center / GitHub OIDC is configured so `terraform`
   can authenticate without long-lived keys.
3. The S3 bucket + DynamoDB table for remote state exist (created via
   a bootstrap script — see `infra/terraform/bootstrap/` in a future
   PR).
4. `terraform.tfvars` is populated locally per environment and NOT
   committed.

Until then, the files here are review-only.
