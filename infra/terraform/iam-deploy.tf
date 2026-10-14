# =====================================================================
# Deploy role (ADR-0035 §4): GitHub signs in through OIDC, no stored
# AWS keys. It can push the image, register task definitions, run the
# migration job and update the one service; nothing else.
#
# The owner's own deploys (scripts/deploy-aws.sh) use the owner's
# credentials; this role is for a later GitHub workflow.
# =====================================================================

resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_github_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? one(aws_iam_openid_connect_provider.github[*].arn) : one(data.aws_iam_openid_connect_provider.github[*].arn)
}

data "aws_iam_policy_document" "deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only a workflow run in the `production` environment (which the
    # owner approves, ADR-0034) can take this role.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:production"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${local.name}-deploy"
  assume_role_policy   = data.aws_iam_policy_document.deploy_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "PushTheApiImage"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
      "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload",
      "ecr:PutImage", "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.api.arn]
  }
  statement {
    sid       = "EncryptTheImage"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.artifacts.arn]
  }
  statement {
    sid       = "TaskDefinitions"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"]
    resources = ["*"] # these actions don't take a resource
  }
  statement {
    sid       = "UpdateTheApiService"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [aws_ecs_service.api.id]
  }
  statement {
    sid       = "RunTheMigrationJob"
    actions   = ["ecs:RunTask", "ecs:DescribeTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }
  statement {
    sid       = "HandTasksTheirRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
