# =====================================================================
# CloudPunch KMS customer-managed keys (ADR-0007 §3)
# =====================================================================
#
# Four separate keys, one purpose each, to bound blast radius:
#   - cloudpunch-secrets       Secrets Manager envelope encryption
#   - cloudpunch-data-at-rest  Aurora + S3 + backups
#   - cloudpunch-artifacts     Code-signing material + Tauri updater key
#   - cloudpunch-logs          CloudWatch Logs (sensitive log groups)
#
# Automatic yearly rotation is enabled on every key. Key policies below
# are minimal skeletons; they will be extended once the ECS task role,
# break-glass role, and CI release role ARNs exist.
# =====================================================================

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id      = data.aws_caller_identity.current.account_id
  partition       = data.aws_partition.current.partition
  root_principal  = "arn:${data.aws_partition.current.partition}:iam::${local.account_id}:root"
  key_admin_arns  = compact([var.break_glass_role_arn])
  ecs_task_arns   = compact([var.ecs_task_role_arn])
  release_arns    = compact([var.ci_release_role_arn])
}

# ---------------------------------------------------------------------
# cloudpunch-secrets — Secrets Manager
# ---------------------------------------------------------------------

resource "aws_kms_key" "secrets" {
  description             = "CloudPunch — Secrets Manager envelope encryption"
  key_usage               = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid       = "EnableRootPermissions"
          Effect    = "Allow"
          Principal = { AWS = local.root_principal }
          Action    = "kms:*"
          Resource  = "*"
        },
        {
          Sid       = "AllowSecretsManagerService"
          Effect    = "Allow"
          Principal = { Service = "secretsmanager.${data.aws_region.current.name}.amazonaws.com" }
          Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
          Resource  = "*"
        },
      ],
      length(local.ecs_task_arns) > 0 ? [{
        Sid       = "AllowEcsTaskDecrypt"
        Effect    = "Allow"
        Principal = { AWS = local.ecs_task_arns }
        Action    = ["kms:Decrypt", "kms:DescribeKey"]
        Resource  = "*"
      }] : [],
      length(local.key_admin_arns) > 0 ? [{
        Sid       = "AllowBreakGlassAdmin"
        Effect    = "Allow"
        Principal = { AWS = local.key_admin_arns }
        Action    = "kms:*"
        Resource  = "*"
      }] : [],
    )
  })
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/cloudpunch-${var.env}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

# ---------------------------------------------------------------------
# cloudpunch-data-at-rest — Aurora + S3 + backups
# ---------------------------------------------------------------------

resource "aws_kms_key" "data_at_rest" {
  description             = "CloudPunch — Aurora + S3 archive + backups"
  key_usage               = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid       = "EnableRootPermissions"
          Effect    = "Allow"
          Principal = { AWS = local.root_principal }
          Action    = "kms:*"
          Resource  = "*"
        },
        {
          Sid    = "AllowRdsService"
          Effect = "Allow"
          Principal = {
            Service = [
              "rds.${data.aws_region.current.name}.amazonaws.com",
              "s3.${data.aws_region.current.name}.amazonaws.com",
            ]
          }
          Action   = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
          Resource = "*"
        },
      ],
      length(local.ecs_task_arns) > 0 ? [{
        Sid       = "AllowEcsTaskCrypto"
        Effect    = "Allow"
        Principal = { AWS = local.ecs_task_arns }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
        Resource  = "*"
      }] : [],
    )
  })
}

resource "aws_kms_alias" "data_at_rest" {
  name          = "alias/cloudpunch-${var.env}-data-at-rest"
  target_key_id = aws_kms_key.data_at_rest.key_id
}

# ---------------------------------------------------------------------
# cloudpunch-artifacts — Tauri updater key + code-signing material
# ---------------------------------------------------------------------

resource "aws_kms_key" "artifacts" {
  description             = "CloudPunch — Signing artefact wrapping"
  key_usage               = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid       = "EnableRootPermissions"
          Effect    = "Allow"
          Principal = { AWS = local.root_principal }
          Action    = "kms:*"
          Resource  = "*"
        },
      ],
      length(local.release_arns) > 0 ? [{
        Sid       = "AllowReleaseRunnerDecrypt"
        Effect    = "Allow"
        Principal = { AWS = local.release_arns }
        Action    = ["kms:Decrypt", "kms:DescribeKey"]
        Resource  = "*"
      }] : [],
      length(local.key_admin_arns) > 0 ? [{
        Sid       = "AllowBreakGlassAdmin"
        Effect    = "Allow"
        Principal = { AWS = local.key_admin_arns }
        Action    = "kms:*"
        Resource  = "*"
      }] : [],
    )
  })
}

resource "aws_kms_alias" "artifacts" {
  name          = "alias/cloudpunch-${var.env}-artifacts"
  target_key_id = aws_kms_key.artifacts.key_id
}

# ---------------------------------------------------------------------
# cloudpunch-logs — CloudWatch Logs (sensitive groups)
# ---------------------------------------------------------------------

resource "aws_kms_key" "logs" {
  description             = "CloudPunch — CloudWatch Logs sensitive groups"
  key_usage               = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableRootPermissions"
        Effect    = "Allow"
        Principal = { AWS = local.root_principal }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "AllowCloudWatchLogsService"
        Effect    = "Allow"
        Principal = { Service = "logs.${data.aws_region.current.name}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
        Condition = {
          ArnEquals = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:${local.partition}:logs:${data.aws_region.current.name}:${local.account_id}:*"
          }
        }
      },
    ]
  })
}

resource "aws_kms_alias" "logs" {
  name          = "alias/cloudpunch-${var.env}-logs"
  target_key_id = aws_kms_key.logs.key_id
}
