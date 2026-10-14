# =====================================================================
# Database (ADR-0035 §1; engine per ADR-0045)
# =====================================================================
#
# PostgreSQL 16 in the private subnets, encrypted with the data key,
# reachable only from the tasks' security group. The master password is
# generated and kept by RDS in Secrets Manager (never in state or here).
#
#   db_engine = "rds"     one RDS instance (ADR-0045's proposal);
#                         db_multi_az adds a standby
#   db_engine = "aurora"  Aurora Serverless v2, one writer (ADR-0035)
#
# The app's two roles (cloudpunch_migrator, cloudpunch_app) are created
# by hand once, as on the pilot: docs/ops/aws-cutover.md, step B4.
# =====================================================================

locals {
  use_rds    = var.db_engine == "rds"
  db_name    = "cloudpunch"
  db_admin   = "cloudpunch_admin"
  db_address = local.use_rds ? one(aws_db_instance.main[*].address) : one(aws_rds_cluster.main[*].endpoint)
  # The secret RDS keeps the master password in (for the one-time role setup).
  db_master_secret_arn = local.use_rds ? one(aws_db_instance.main[*].master_user_secret[0].secret_arn) : one(aws_rds_cluster.main[*].master_user_secret[0].secret_arn)
}

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = local.name }
}

# ---------------------------------------------------------------------
# RDS PostgreSQL
# ---------------------------------------------------------------------

resource "aws_db_parameter_group" "pg16" {
  count  = local.use_rds ? 1 : 0
  name   = "${local.name}-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "2000"
  }
}

resource "aws_db_instance" "main" {
  count = local.use_rds ? 1 : 0

  identifier     = local.name
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class
  db_name        = local.db_name
  username       = local.db_admin

  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.secrets.arn

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_allocated_storage_gb * 5
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.data_at_rest.arn

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.pg16[0].name

  backup_retention_period    = var.db_backup_retention_days
  backup_window              = "20:30-21:00" # 02:00–02:30 IST
  maintenance_window         = "sun:21:30-sun:22:30"
  copy_tags_to_snapshot      = true
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${local.name}-final"
  auto_minor_version_upgrade = true
  apply_immediately          = false

  enabled_cloudwatch_logs_exports = ["postgresql"]
}

# ---------------------------------------------------------------------
# Aurora PostgreSQL Serverless v2 (the alternative)
# ---------------------------------------------------------------------

resource "aws_rds_cluster" "main" {
  count = local.use_rds ? 0 : 1

  cluster_identifier = local.name
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = var.db_engine_version
  database_name      = local.db_name
  master_username    = local.db_admin

  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.secrets.arn

  storage_encrypted      = true
  kms_key_id             = aws_kms_key.data_at_rest.arn
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_acu
    max_capacity = var.aurora_max_acu
  }

  backup_retention_period         = var.db_backup_retention_days
  preferred_backup_window         = "20:30-21:00"
  preferred_maintenance_window    = "sun:21:30-sun:22:30"
  copy_tags_to_snapshot           = true
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.name}-final"
  enabled_cloudwatch_logs_exports = ["postgresql"]
}

resource "aws_rds_cluster_instance" "writer" {
  count = local.use_rds ? 0 : 1

  identifier          = "${local.name}-writer"
  cluster_identifier  = aws_rds_cluster.main[0].id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.main[0].engine
  engine_version      = aws_rds_cluster.main[0].engine_version
  publicly_accessible = false
}
