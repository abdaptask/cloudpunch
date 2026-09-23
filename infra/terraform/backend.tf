# Remote state backend — placeholder.
#
# This block is intentionally left commented until the bootstrap PR
# creates the S3 state bucket and DynamoDB lock table (see README §
# "Bootstrap"). Running `terraform init` without an explicit backend
# will use local state, which is fine for reviewing plans but must not
# be used for any environment that will be shared or applied.
#
# terraform {
#   backend "s3" {
#     bucket         = "cloudpunch-tfstate-<env>"
#     key            = "cloudpunch/<env>/terraform.tfstate"
#     region         = "ap-south-1"
#     dynamodb_table = "cloudpunch-tfstate-lock-<env>"
#     encrypt        = true
#   }
# }
