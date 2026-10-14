output "kms_secrets_key_arn" {
  description = "ARN of the KMS CMK protecting Secrets Manager entries."
  value       = aws_kms_key.secrets.arn
  sensitive   = true
}

output "kms_secrets_alias" {
  description = "Alias of the KMS CMK protecting Secrets Manager entries."
  value       = aws_kms_alias.secrets.name
}

output "kms_data_at_rest_key_arn" {
  description = "ARN of the KMS CMK protecting Aurora + S3 + backups."
  value       = aws_kms_key.data_at_rest.arn
  sensitive   = true
}

output "kms_data_at_rest_alias" {
  description = "Alias of the KMS CMK protecting data at rest."
  value       = aws_kms_alias.data_at_rest.name
}

output "kms_artifacts_key_arn" {
  description = "ARN of the KMS CMK protecting signing artefacts."
  value       = aws_kms_key.artifacts.arn
  sensitive   = true
}

output "kms_artifacts_alias" {
  description = "Alias of the KMS CMK protecting signing artefacts."
  value       = aws_kms_alias.artifacts.name
}

output "kms_logs_key_arn" {
  description = "ARN of the KMS CMK protecting sensitive CloudWatch Logs groups."
  value       = aws_kms_key.logs.arn
  sensitive   = true
}

output "secret_arns" {
  description = "Map of relative secret path -> full ARN. Downstream stacks consume these."
  value       = { for k, v in aws_secretsmanager_secret.entries : k => v.arn }
  sensitive   = true
}

# ---------------------------------------------------------------------
# Production on AWS (ADR-0045): what scripts/deploy-aws.sh and the
# cutover runbook need.
# ---------------------------------------------------------------------

output "ecr_repository_url" {
  description = "Where scripts/deploy-aws.sh pushes the API image."
  value       = aws_ecr_repository.api.repository_url
}

output "ecs_cluster" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service" {
  description = "The API service name."
  value       = aws_ecs_service.api.name
}

output "job_task_family" {
  description = "Task definition family for one-off jobs (migrate, restore, bootstrap-roles, …)."
  value       = aws_ecs_task_definition.job.family
}

output "task_subnets" {
  description = "Subnets to run one-off jobs in."
  value       = aws_subnet.public[*].id
}

output "task_security_group" {
  description = "Security group for one-off jobs."
  value       = aws_security_group.api.id
}

output "db_address" {
  description = "Database host (private; reachable from the tasks only)."
  value       = local.db_address
}

output "db_master_secret_arn" {
  description = "Secrets Manager entry RDS keeps the master password in."
  value       = local.db_master_secret_arn
  sensitive   = true
}

output "app_secret_arns" {
  description = "The app's secrets, to fill by hand (docs/ops/aws-cutover.md, B3)."
  value       = { for k, v in aws_secretsmanager_secret.app : k => v.arn }
  sensitive   = true
}

output "transfer_bucket" {
  description = "Bucket for the cutover's pg_dump."
  value       = aws_s3_bucket.transfer.bucket
}

output "deploy_role_arn" {
  description = "Role a GitHub workflow in the production environment can assume."
  value       = aws_iam_role.deploy.arn
}

output "alarm_topic_arn" {
  description = "SNS topic the alarms publish to."
  value       = aws_sns_topic.alarms.arn
}
