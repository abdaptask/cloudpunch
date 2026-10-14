# =====================================================================
# ECS Fargate: the API, with cloudflared beside it (ADR-0035, ADR-0045)
# =====================================================================
#
# One task definition for the API: the app container plus cloudflared,
# which connects out to Cloudflare and forwards cloudpunch.aptask.com to
# localhost:8080 (the tasks share a network namespace). A second task
# definition runs one-off jobs from the same image: migrations, the
# connections purge and the IP database refresh.
# =====================================================================

locals {
  image          = "${aws_ecr_repository.api.repository_url}:${var.app_image_tag}"
  log_group_name = "/cloudpunch/${var.env}"

  api_environment = merge(
    {
      NODE_ENV        = "production"
      CLOUDPUNCH_ENV  = var.env
      AWS_REGION      = var.aws_region
      LOG_LEVEL       = "info"
      PUBLIC_SITE_URL = "https://cloudpunch.aptask.com"
    },
    var.app_environment,
  )
  api_environment_list = [for k, v in local.api_environment : { name = k, value = v }]

  secret_arn = { for k, v in aws_secretsmanager_secret.app : k => v.arn }

  logs = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = local.log_group_name
      awslogs-region        = var.aws_region
      awslogs-stream-prefix = "ecs"
    }
  }
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "disabled" # ~$5/month; turn on when investigating
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
}

# ---------------------------------------------------------------------
# IAM: least privilege
# ---------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# Execution role: what ECS itself needs to start the containers.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadTheAppSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = values(local.secret_arn)
  }
  statement {
    sid       = "DecryptThem"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn]
  }
  statement {
    sid       = "PullTheEncryptedImage"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.artifacts.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "app-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# Task role: what the running app may call. Only the shared volume; the
# app reads its secrets from the environment ECS gives it.
resource "aws_iam_role" "task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "MountTheDataVolume"
    actions   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
    resources = [aws_efs_file_system.data.arn]
    condition {
      test     = "StringEquals"
      variable = "elasticfilesystem:AccessPointArn"
      values   = [aws_efs_access_point.data.arn]
    }
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "data-volume"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# ---------------------------------------------------------------------
# The API task and service
# ---------------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume {
    name = "data"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.data.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.data.id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name         = "api"
      image        = local.image
      essential    = true
      command      = ["api"]
      environment  = local.api_environment_list
      portMappings = [{ containerPort = 8080, protocol = "tcp" }]
      secrets = [
        { name = "POSTGRES_APP_URL", valueFrom = local.secret_arn["app/postgres-app-url"] },
        { name = "ENTRA_OBO_CERT_KEY_PEM", valueFrom = local.secret_arn["app/entra-obo-key-pem"] },
      ]
      mountPoints = [{ sourceVolume = "data", containerPath = "/data", readOnly = false }]
      healthCheck = {
        command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:8080/livez || exit 1"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      logConfiguration = merge(local.logs, {
        options = merge(local.logs.options, { awslogs-stream-prefix = "api" })
      })
    },
    {
      # Pinned: a new cloudflared is a deliberate change, like the app.
      name      = "cloudflared"
      image     = "cloudflare/cloudflared:2024.12.2"
      essential = true
      command   = ["tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:20241", "run"]
      secrets = [
        { name = "TUNNEL_TOKEN", valueFrom = local.secret_arn["app/cloudflared-token"] },
      ]
      dependsOn = [{ containerName = "api", condition = "HEALTHY" }]
      logConfiguration = merge(local.logs, {
        options = merge(local.logs.options, { awslogs-stream-prefix = "cloudflared" })
      })
    },
  ])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = true # outbound only: the security group has no inbound rules
  }

  # Rolling deploy: the new task is healthy before the old one stops.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # The deploy script sets the image; Terraform owns the rest.
  lifecycle {
    ignore_changes = [task_definition]
  }
}

# ---------------------------------------------------------------------
# One-off jobs: the same image, run by the schedules and the deploy
# script with a command (migrate | purge-connections | dbip-update).
# ---------------------------------------------------------------------

resource "aws_ecs_task_definition" "job" {
  family                   = "${local.name}-job"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume {
    name = "data"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.data.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.data.id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name        = "job"
      image       = local.image
      essential   = true
      command     = ["migrate"]
      environment = local.api_environment_list
      # The app and admin URLs are only for the one-time bootstrap-roles
      # job (it reads the passwords to create the roles).
      secrets = [
        { name = "POSTGRES_URL", valueFrom = local.secret_arn["app/postgres-migrator-url"] },
        { name = "POSTGRES_APP_URL", valueFrom = local.secret_arn["app/postgres-app-url"] },
        { name = "POSTGRES_ADMIN_URL", valueFrom = local.secret_arn["app/postgres-admin-url"] },
      ]
      mountPoints = [{ sourceVolume = "data", containerPath = "/data", readOnly = false }]
      logConfiguration = merge(local.logs, {
        options = merge(local.logs.options, { awslogs-stream-prefix = "job" })
      })
    },
  ])
}
