# =====================================================================
# The pilot's timers as EventBridge Scheduler jobs (ADR-0035 §1)
# =====================================================================
#
#   dbip-update        daily 02:30 IST   (cloudpunch-dbip-update.timer)
#   purge-connections  daily 03:00 IST   (cloudpunch-connections-purge.timer)
#
# The nightly pg_dump timer isn't needed: RDS/Aurora keep automated
# backups with point-in-time recovery (db_backup_retention_days).
# =====================================================================

locals {
  jobs = {
    dbip-update       = "cron(30 2 * * ? *)"
    purge-connections = "cron(0 3 * * ? *)"
  }
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    sid       = "RunTheJobTask"
    actions   = ["ecs:RunTask"]
    resources = [
      "arn:${local.partition}:ecs:${var.aws_region}:${local.account_id}:task-definition/${aws_ecs_task_definition.job.family}",
      "arn:${local.partition}:ecs:${var.aws_region}:${local.account_id}:task-definition/${aws_ecs_task_definition.job.family}:*",
    ]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }
  statement {
    sid       = "HandItItsRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "run-jobs"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "job" {
  for_each = local.jobs

  name                         = "${local.name}-${each.key}"
  schedule_expression          = each.value
  schedule_expression_timezone = "Asia/Kolkata"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      # The family, so a schedule runs the latest revision.
      task_definition_arn = "arn:${local.partition}:ecs:${var.aws_region}:${local.account_id}:task-definition/${aws_ecs_task_definition.job.family}"
      launch_type         = "FARGATE"
      task_count          = 1

      network_configuration {
        subnets          = aws_subnet.public[*].id
        security_groups  = [aws_security_group.api.id]
        assign_public_ip = true
      }
    }

    input = jsonencode({
      containerOverrides = [{ name = "job", command = [each.key] }]
    })

    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}
