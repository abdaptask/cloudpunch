import { z } from 'zod';

/**
 * Bootstrap environment schema. These variables must be present before
 * the process starts serving traffic. Non-secret runtime configuration
 * (feature flags, base URLs, policy defaults) lives in SSM Parameter
 * Store — see docs/ops/env-vars.md — and is fetched at startup.
 *
 * Secrets are fetched from AWS Secrets Manager and NEVER injected here.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  CLOUDPUNCH_ENV: z.enum(['dev', 'staging', 'prod', 'test']).default('dev'),
  AWS_REGION: z.string().min(1).default('ap-south-1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),

  CLOUDPUNCH_SECRETS_PREFIX: z.string().default('cloudpunch'),
  CLOUDPUNCH_CONFIG_PREFIX: z.string().default('cloudpunch/config'),

  OTEL_SERVICE_NAME: z.string().default('cloudpunch-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  SENTRY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Entra config — usually populated from Parameter Store in prod; env fallback for
  // local dev + tests. These are non-secret identifiers, safe in env.
  ENTRA_TENANT_ID: z.string().uuid().optional(),
  ENTRA_API_CLIENT_ID: z.string().uuid().optional(),
  ENTRA_API_APPLICATION_ID_URI: z.string().min(1).optional(),
  ENTRA_REQUIRED_SCOPE: z.string().default('api.access'),

  APP_VERSION: z.string().default('0.0.0-dev'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Load and validate the environment. Fails-closed: if any required
 * value is missing or malformed, the process exits with code 1. There
 * is no fallback to unsafe defaults (see ADR-0007 §14).
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Structured error suitable for CloudWatch; still readable in a terminal.
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      code: i.code,
      message: i.message,
    }));
    process.stderr.write(
      `${JSON.stringify({
        level: 'fatal',
        msg: 'environment validation failed',
        issues,
      })}\n`,
    );
    process.exit(1);
  }
  return result.data;
}
