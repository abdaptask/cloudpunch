# =====================================================================
# Alarms (ADR-0035 §1): emailed through SNS to var.alarm_emails
# =====================================================================
#
# Inside AWS: the API not running, its memory, server errors in its
# logs, failed jobs, and the database's CPU and space. The outside
# check (is cloudpunch.aptask.com answering through Cloudflare?) stays
# the GitHub uptime workflow and the 2026-10-14 alerts work (item 3),
# because only an outside check sees Cloudflare or the tunnel failing.
# =====================================================================

resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  for_each  = toset(var.alarm_emails)
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
  ecs_dims = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.api.name
  }
}

# No task running reports no CPU at all: missing data is the alarm.
resource "aws_cloudwatch_metric_alarm" "api_down" {
  alarm_name          = "${local.name}-api-not-running"
  alarm_description   = "No CloudPunch API task has reported for 3 minutes."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = local.ecs_dims
  statistic           = "SampleCount"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_memory" {
  alarm_name          = "${local.name}-api-memory"
  alarm_description   = "The API task is above 85% of its memory."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = local.ecs_dims
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
}

# Server errors, from the API's request logs (pino: res.statusCode).
resource "aws_cloudwatch_log_metric_filter" "api_5xx" {
  name           = "${local.name}-api-5xx"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.res.statusCode >= 500 }"
  metric_transformation {
    name          = "Api5xx"
    namespace     = "CloudPunch/${var.env}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  alarm_description   = "More than 10 server errors in 5 minutes."
  namespace           = "CloudPunch/${var.env}"
  metric_name         = "Api5xx"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# A job (migrate, purge, IP database) that ended with an error.
resource "aws_cloudwatch_log_metric_filter" "job_failed" {
  name           = "${local.name}-job-failed"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "?\"migrate: failed\" ?\"dbip-update: no file\" ?\"is not a valid database\" ?\"ERROR:\""
  metric_transformation {
    name          = "JobFailed"
    namespace     = "CloudPunch/${var.env}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "job_failed" {
  alarm_name          = "${local.name}-job-failed"
  alarm_description   = "A scheduled job or migration logged a failure."
  namespace           = "CloudPunch/${var.env}"
  metric_name         = "JobFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# ---------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------

locals {
  db_dims = local.use_rds ? tomap({
    DBInstanceIdentifier = one(aws_db_instance.main[*].identifier)
    }) : tomap({
    DBClusterIdentifier = one(aws_rds_cluster.main[*].cluster_identifier)
  })
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${local.name}-db-cpu"
  alarm_description   = "Database CPU above 80% for 15 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = local.db_dims
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  count               = local.use_rds ? 1 : 0
  alarm_name          = "${local.name}-db-storage"
  alarm_description   = "Less than 2 GB of database storage left (it grows by itself up to 5× the starting size)."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = local.db_dims
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 2147483648
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.alarm_actions
}
