# =====================================================================
# CloudPunch Secrets Manager entries (ADR-0007 §2)
# =====================================================================
#
# Skeleton with placeholder secret values. Operators populate real
# values via the AWS console (or a rotation Lambda) after apply.
#
# Rotation cadences per ADR-0007 §13 are configured on entries where
# AWS-managed rotation exists; custom rotators land in a later PR.
# =====================================================================

locals {
  secret_path_prefix = "cloudpunch/${var.env}"

  # Set of secrets that exist in every environment. Actual values are
  # populated post-apply — the resources here just create the entries
  # with a stable ARN.
  secrets = {
    "db/aurora/master"                     = "Aurora master password (AWS-managed rotation, 30d)"
    "db/aurora/app-rw"                     = "Aurora app read-write role"
    "db/aurora/app-ro"                     = "Aurora app read-only role"
    "redis/streams"                        = "ElastiCache Redis AUTH token"
    "session/cookie-signing-key"           = "HMAC key for backend session cookies"
    "session/csrf-signing-key"             = "HMAC key for CSRF token binding"
    "entra/graph-app-secret"               = "Client secret for AppRoleAssignment.ReadWrite.All"
    "greythr/oauth-client"                 = "greytHR OAuth 2.0 client credentials (when applicable)"
    "greythr/api-key"                      = "greytHR API key (when applicable)"
    "greythr/webhook-signing-key"          = "greytHR webhook HMAC verification key"
    "signing/tauri-updater-private-key"    = "Tauri updater Ed25519 private key"
    "signing/apple-developer-id-p12"       = "Apple Developer ID Application .p12"
    "signing/apple-app-specific-password"  = "Apple notarisation credential"
    "webhooks/outbound-signing-key"        = "HMAC key for CloudPunch outbound webhooks"
    "sentry/dsn"                           = "Sentry DSN with PII scrubber tag"
  }
}

resource "aws_secretsmanager_secret" "entries" {
  for_each = local.secrets

  name        = "${local.secret_path_prefix}/${each.key}"
  description = each.value
  kms_key_id  = aws_kms_key.secrets.arn

  # Deleting a secret is a two-step process; keep the recovery window
  # long in prod so an accidental destroy is recoverable.
  recovery_window_in_days = var.env == "prod" ? 30 : 7
}

# Placeholder initial values so downstream references resolve. Real
# values are populated post-apply via console/CLI/Lambda rotator.
# The placeholder is JSON so operators can rotate to a JSON-encoded
# credential without changing the value's shape.
resource "aws_secretsmanager_secret_version" "entries" {
  for_each = local.secrets

  secret_id     = aws_secretsmanager_secret.entries[each.key].id
  secret_string = jsonencode({
    placeholder = true
    populated   = false
    hint        = each.value
  })

  lifecycle {
    ignore_changes = [secret_string] # never let Terraform overwrite operator-set values
  }
}
