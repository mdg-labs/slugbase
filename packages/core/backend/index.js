/**
 * @slugbase/core/backend – re-exports from built backend (packages/core/backend/dist).
 * Run root build (or copy-core-dist) so that dist/ exists.
 */

export { getConfig } from './dist/config.js';
export { createDbPool } from './dist/db/pool.js';
export { setDb, initDatabase, getDb, getDbType, query, queryOne, execute, isInitialized } from './dist/db/index.js';
export { runMigrations } from './dist/db/migrations/index.js';
export { createApp } from './dist/app-factory.js';
export { registerCoreRoutes } from './dist/register-routes.js';
export { default as openapiRoutes } from './dist/routes/openapi.js';
export { DatabaseSessionStore } from './dist/utils/session-store.js';
export { loadOIDCStrategies } from './dist/auth/oidc.js';
export { validateEnvironmentVariables } from './dist/utils/env-validation.js';
export { errorHandler, notFoundHandler } from './dist/middleware/error-handler.js';
export { requireAuth } from './dist/middleware/auth.js';
export {
  recordAuditEvent,
  recordAuditEventForTenant,
  isAuditLogEnabledForRequest,
  isAuditLogEnabledForTenantId,
} from './dist/services/audit-log.js';
export {
  buildEmailLayout,
  escapeHtml,
  EMAIL_CALLOUT_BG,
  EMAIL_CALLOUT_BORDER,
  EMAIL_CALLOUT_TEXT,
  EMAIL_HEADER_BG,
  EMAIL_PAGE_BG,
  EMAIL_PRIMARY,
  EMAIL_PRIMARY_SHADOW,
} from './dist/utils/email-layout.js';
