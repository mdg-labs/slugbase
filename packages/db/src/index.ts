export { ConnectionRoleError, connectionRole } from "./connection-role.ts";
export type { ConnectionRole, ConnectionRoleOptions } from "./connection-role.ts";
export { CE_CHAIN, MigrationError, migrate, migrationLevel } from "./migrate.ts";
export type {
  MigrateOptions,
  MigrateResult,
  MigrationChain,
  MigrationLevel,
  MigrationLevelOptions,
} from "./migrate.ts";
export { TenantContextError, createDatabase } from "./tenant.ts";
export type {
  Database,
  DatabaseOptions,
  TenantContext,
  TenantContextErrorCode,
  TenantTx,
} from "./tenant.ts";
export { defineScopedRepository } from "./repositories/scoped.ts";
export type {
  InsertValues,
  ScopedRepository,
  ScopedRepositoryDefinition,
  UpdateValues,
  WorkspaceTable,
} from "./repositories/scoped.ts";
export { ACCENT_PRESETS, accountProfileRepository } from "./repositories/account-profile.ts";
export type { AccentPreset, AccountProfile, AccountProfileChanges, AccountProfileRepository, AnalyticsConsent, Onboarding } from "./repositories/account-profile.ts";
export { membershipRepository } from "./repositories/memberships.ts";
export type { Membership, MembershipRepository } from "./repositories/memberships.ts";
export type { MemberRole } from "./schema/workspaces.ts";
export { listRepositoryMethods } from "./repositories/registry.ts";
export type { RepositoryInput, RepositoryMethodEntry, ScopedMethod } from "./repositories/registry.ts";
export { createRateLimitStore } from "./system/rate-limit.ts";
export type { RateLimitStore, RateLimitStoreOptions, RateLimitTake, RateLimitTaken } from "./system/rate-limit.ts";
export { createRetentionStore } from "./system/retention.ts";
export type { RetentionPurgeCount, RetentionStore, RetentionStoreOptions } from "./system/retention.ts";
export { createAuthStore } from "./system/auth.ts";
export type {
  AuthStore,
  AuthStoreOptions,
  LoginCandidate,
  NewSession,
  SessionRecord,
  SessionSummary,
} from "./system/auth.ts";
export type { CompleteSetup, SetupOutcome, SetupStore } from "./system/setup.ts";
