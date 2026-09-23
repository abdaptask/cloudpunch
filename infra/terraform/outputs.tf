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
