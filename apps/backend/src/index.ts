export { buildApp, type BuildAppOptions } from './app.js';
export { loadEnv, type Env } from './config/env.js';
export { createLogger } from './logging/logger.js';
export { authPlugin, type AuthPluginOptions } from './auth/plugin.js';
export { requireAuth, requireCapability } from './auth/require.js';
export {
  TokenVerificationError,
  verifyEntraToken,
  type TokenClaims,
  type VerifyOptions,
} from './auth/verify.js';
export { createEntraJwks, type JwksOptions } from './auth/jwks.js';
export { healthPlugin, type HealthProbe } from './health/routes.js';
export * from './db/index.js';
export { meRoutes } from './me/routes.js';
export { devicesRoutes } from './devices/routes.js';
export { enrollDeviceService } from './devices/enroll.js';
export { eventsRoutes } from './events/routes.js';
export {
  ingestBatch,
  MAX_SEQUENCE_GAP,
  type IngestBatchInput,
  type IngestBatchOutcome,
  type EventIngestResult,
} from './events/ingest.js';
export {
  derivePeriods,
  type BreakKind,
  type DerivedBreakPeriod,
  type DerivedIdlePeriod,
  type DeriveResult,
  type EventForDerivation,
  type IdleResolution,
} from './events/derive.js';
export {
  deriveState,
  nextState,
  INITIAL_STATE,
  type PayrollState,
} from './events/state-machine.js';
