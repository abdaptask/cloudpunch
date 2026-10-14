variable "env" {
  description = "Deployment environment: dev | staging | prod. Flows into resource names and tags."
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be one of dev, staging, prod."
  }
}

variable "aws_region" {
  description = "Primary AWS region. Mumbai (ap-south-1) for the India-only workforce."
  type        = string
  default     = "ap-south-1"
}

variable "owner" {
  description = "Team or individual accountable for this deployment. Applied as a default tag."
  type        = string
  default     = "cloudpunch-platform"
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set. Never store secrets here."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------
# Break-glass principal for CMK key policies
# ---------------------------------------------------------------------

variable "break_glass_role_arn" {
  description = "IAM role ARN of the break-glass admin (kms-secrets)."
  type        = string
  default     = "" # populated in terraform.tfvars per env
}

variable "ecs_task_role_arn" {
  description = "IAM role ARN assumed by the ECS Fargate tasks that read secrets and decrypt data at rest."
  type        = string
  default     = "" # populated in terraform.tfvars per env
}

variable "ci_release_role_arn" {
  description = "GitHub OIDC role ARN used by the release job to unwrap signing artefacts."
  type        = string
  default     = "" # populated in terraform.tfvars per env
}

# ---------------------------------------------------------------------
# Production on AWS (ADR-0035, ADR-0045). Defaults are the proposed
# small setup for ~60 people; every size is a variable.
# ---------------------------------------------------------------------

variable "vpc_cidr" {
  description = "VPC address range. Must not overlap ApTask's office ranges if a VPN is added later."
  type        = string
  default     = "10.40.0.0/16"
}

variable "app_image_tag" {
  description = "Tag of the API image in this stack's ECR repository (scripts/deploy-aws.sh pushes it)."
  type        = string
  default     = "latest"
}

variable "api_cpu" {
  description = "Fargate CPU units for the API task (the API and its cloudflared sidecar)."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory (MiB) for the API task."
  type        = number
  default     = 1024
}

variable "api_desired_count" {
  description = "How many API tasks run. 1 is enough for ~60 people; 2 keeps one up through an AZ failure (about +$17/month)."
  type        = number
  default     = 1
}

variable "db_engine" {
  description = "rds (PostgreSQL 16 on one RDS instance, ADR-0045's proposal) or aurora (Aurora PostgreSQL 16 Serverless v2, ADR-0035's plan)."
  type        = string
  default     = "rds"
  validation {
    condition     = contains(["rds", "aurora"], var.db_engine)
    error_message = "db_engine must be rds or aurora."
  }
}

variable "db_engine_version" {
  description = "PostgreSQL major.minor (the pilot runs 16)."
  type        = string
  default     = "16.4"
}

variable "db_instance_class" {
  description = "RDS instance class when db_engine = rds."
  type        = string
  default     = "db.t4g.small"
}

variable "db_multi_az" {
  description = "RDS standby in a second AZ (doubles the database cost; failover in about a minute)."
  type        = bool
  default     = false
}

variable "db_allocated_storage_gb" {
  description = "RDS storage (gp3). The pilot's database is well under 1 GB."
  type        = number
  default     = 20
}

variable "aurora_min_acu" {
  description = "Aurora Serverless v2 minimum capacity when db_engine = aurora."
  type        = number
  default     = 0.5
}

variable "aurora_max_acu" {
  description = "Aurora Serverless v2 maximum capacity when db_engine = aurora."
  type        = number
  default     = 4
}

variable "db_backup_retention_days" {
  description = "Automated backups and point-in-time recovery window, in days."
  type        = number
  default     = 14
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the API and jobs."
  type        = number
  default     = 30
}

variable "alarm_emails" {
  description = "Who gets CloudWatch alarm emails (each confirms the subscription email once)."
  type        = list(string)
  default     = []
}

variable "app_environment" {
  description = "Non-secret API settings, the pilot's api.env without secrets: ENTRA_TENANT_ID, ENTRA_API_CLIENT_ID, ENTRA_API_APPLICATION_ID_URI, ENTRA_WEB_CLIENT_ID, ENTRA_OBO_CERT_THUMBPRINT, WELCOME_FROM, WELCOME_CC, SUPPORT_EMAIL, ALERT_TO and so on."
  type        = map(string)
  default     = {}
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through GitHub OIDC."
  type        = string
  default     = "abdaptask/cloudpunch"
}

variable "create_github_oidc_provider" {
  description = "Create the account's GitHub OIDC provider (false if the account already has one)."
  type        = bool
  default     = true
}
