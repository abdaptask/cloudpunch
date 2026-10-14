# =====================================================================
# Image registry, shared files and the app's secrets (ADR-0045)
# =====================================================================

# ---------------------------------------------------------------------
# ECR: the API image (infra/aws/Dockerfile)
# ---------------------------------------------------------------------

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.artifacts.arn
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images (rollback room)"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------
# EFS: published installers and the DB-IP database. ADR-0045: the API
# keeps reading them from a folder (DOWNLOADS_DIR, DBIP_ASN_MMDB), as on
# the VM, so moving needs no code change. A few hundred MB at most.
# ---------------------------------------------------------------------

resource "aws_efs_file_system" "data" {
  creation_token   = "${local.name}-data"
  encrypted        = true
  kms_key_id       = aws_kms_key.data_at_rest.arn
  performance_mode = "generalPurpose"
  throughput_mode  = "elastic"

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  tags = { Name = "${local.name}-data" }
}

resource "aws_efs_backup_policy" "data" {
  file_system_id = aws_efs_file_system.data.id
  backup_policy {
    status = "ENABLED"
  }
}

resource "aws_efs_mount_target" "data" {
  count           = 2
  file_system_id  = aws_efs_file_system.data.id
  subnet_id       = aws_subnet.public[count.index].id
  security_groups = [aws_security_group.efs.id]
}

# The container user (uid 10001, infra/aws/Dockerfile) owns /data.
resource "aws_efs_access_point" "data" {
  file_system_id = aws_efs_file_system.data.id

  posix_user {
    uid = 10001
    gid = 10001
  }

  root_directory {
    path = "/cloudpunch"
    creation_info {
      owner_uid   = 10001
      owner_gid   = 10001
      permissions = "0750"
    }
  }
}

# ---------------------------------------------------------------------
# The app's secrets. Created with placeholders; the real values are put
# in by hand (docs/ops/aws-cutover.md, step B3), never through Terraform.
# ---------------------------------------------------------------------

locals {
  app_secrets = {
    "app/postgres-app-url"      = "API connection string (role cloudpunch_app), sslmode=require"
    "app/postgres-migrator-url" = "Migrations and jobs connection string (role cloudpunch_migrator), sslmode=require"
    "app/entra-obo-key-pem"     = "Private key of the Graph on-behalf-of certificate (ADR-0020), PEM"
    "app/cloudflared-token"     = "Token of the cloudpunch-aws Cloudflare tunnel (ADR-0045)"
    "app/postgres-admin-url"    = "RDS master connection string, for the one-time bootstrap-roles job only; blank it afterwards"
  }
}

# ---------------------------------------------------------------------
# Transfer bucket: the cutover's pg_dump goes here and is fetched by the
# restore job through a short-lived signed link. Objects expire after 7
# days; nothing else uses the bucket.
# ---------------------------------------------------------------------

resource "aws_s3_bucket" "transfer" {
  bucket_prefix = "${local.name}-transfer-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "transfer" {
  bucket                  = aws_s3_bucket.transfer.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "transfer" {
  bucket = aws_s3_bucket.transfer.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data_at_rest.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "transfer" {
  bucket = aws_s3_bucket.transfer.id
  rule {
    id     = "expire-after-7-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 7
    }
  }
}

resource "aws_s3_bucket_policy" "transfer_tls_only" {
  bucket = aws_s3_bucket.transfer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.transfer.arn, "${aws_s3_bucket.transfer.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_secretsmanager_secret" "app" {
  for_each = local.app_secrets

  name                    = "${local.secret_path_prefix}/${each.key}"
  description             = each.value
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = var.env == "prod" ? 30 : 7
}

resource "aws_secretsmanager_secret_version" "app" {
  for_each = local.app_secrets

  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = "placeholder: set by hand, see docs/ops/aws-cutover.md"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
