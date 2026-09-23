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
