provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(
      {
        Project     = "CloudPunch"
        ManagedBy   = "Terraform"
        Environment = var.env
        Owner       = var.owner
      },
      var.extra_tags,
    )
  }
}
