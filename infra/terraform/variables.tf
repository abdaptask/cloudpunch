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
