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
  ScopedRepositoryOptions,
  UpdateValues,
  WorkspaceTable,
} from "./repositories/scoped.ts";
export { ACCENT_PRESETS, accountProfileRepository } from "./repositories/account-profile.ts";
export type { AccentPreset, AccountProfile, AccountProfileChanges, AccountProfileRepository, AnalyticsConsent, Onboarding } from "./repositories/account-profile.ts";
export { accountIdentityRepository } from "./repositories/account-identities.ts";
export type { AccountIdentity, AccountIdentityRepository } from "./repositories/account-identities.ts";
export { apiTokenRepository } from "./repositories/api-tokens.ts";
export type { ApiTokenCreation, ApiTokenRecord, ApiTokenRepository, ApiTokenScope, NewApiToken } from "./repositories/api-tokens.ts";
export { emailChangeRepository } from "./repositories/email-change.ts";
export type { EmailChangeRepository, NewEmailChangeToken } from "./repositories/email-change.ts";
export { credentialTokenRepository } from "./repositories/credential-tokens.ts";
export type { CredentialTokenRepository, NewCredentialToken } from "./repositories/credential-tokens.ts";
export { auditEventRepository } from "./repositories/audit-events.ts";
export type { AuditEventRepository } from "./repositories/audit-events.ts";
export { accountDeletionRepository } from "./repositories/account-deletion.ts";
export type { AccountDeletionRepository } from "./repositories/account-deletion.ts";
export { entitlementRepository } from "./repositories/entitlements.ts";
export type { EntitlementRepository, EntitlementUsage } from "./repositories/entitlements.ts";
export { instanceRepository } from "./repositories/instance.ts";
export type { InstanceCounts, InstanceRepository, JobHealth } from "./repositories/instance.ts";
export { bookmarkArchiveTransaction, bookmarkRepository, isBookmarkSlugTaken } from "./repositories/bookmarks.ts";
export type { BookmarkCreation, BookmarkCreationResult, BookmarkRepository, BookmarkUpdateJobs } from "./repositories/bookmarks.ts";
export { isTagNameTaken, tagRepository } from "./repositories/tags.ts";
export type { TagRepository } from "./repositories/tags.ts";
export { folderRepository, isFolderNameTaken } from "./repositories/folders.ts";
export { goRepository } from "./repositories/go.ts";
export { urlMetadataRepository } from "./repositories/url-metadata.ts";
export type { UrlMetadataFields, UrlMetadataRecord, UrlMetadataRepository, UrlMetadataResult } from "./repositories/url-metadata.ts";
export type { UrlMetadataStatus } from "./schema/url-metadata.ts";
export { dashboardRepository } from "./repositories/dashboard.ts";
export type { DashboardRepository } from "./repositories/dashboard.ts";
export { searchRepository } from "./repositories/search.ts";
export type { SearchRepository } from "./repositories/search.ts";
export type { GoRepository } from "./repositories/go.ts";
export type { FolderRepository } from "./repositories/folders.ts";
export { workspaceRepository } from "./repositories/workspaces.ts";
export type { NewWorkspace, WorkspaceDetail, WorkspaceRepository, WorkspaceSummary } from "./repositories/workspaces.ts";
export { isLastOwnerViolation, memberRepository, OWNER_REQUIRED_CONSTRAINT } from "./repositories/members.ts";
export type { MemberRepository, WorkspaceMember } from "./repositories/members.ts";
export { invitationAcceptanceRepository, invitationRepository } from "./repositories/invitations.ts";
export type { InvitationAcceptanceRepository, InvitationMailContext, InvitationRepository } from "./repositories/invitations.ts";
export { IdempotencyBusyError, idempotencyRepository } from "./repositories/idempotency.ts";
export type { IdempotencyClaim, IdempotencyOutcome, IdempotencyRepository, StoredResponse } from "./repositories/idempotency.ts";
export { membershipRepository } from "./repositories/memberships.ts";
export type { Membership, MembershipRepository } from "./repositories/memberships.ts";
export type { MemberRole } from "./schema/workspaces.ts";
export { listRepositoryMethods } from "./repositories/registry.ts";
export type { RepositoryInput, RepositoryMethodEntry, ScopedMethod } from "./repositories/registry.ts";
export { createRateLimitStore } from "./system/rate-limit.ts";
export type { RateLimitStore, RateLimitStoreOptions, RateLimitTake, RateLimitTaken } from "./system/rate-limit.ts";
export { createRetentionStore } from "./system/retention.ts";
export type { RetentionPurgeCount, RetentionStore, RetentionStoreOptions } from "./system/retention.ts";
export { USAGE_FLUSH_BATCH_SIZE, createUsageStore } from "./system/usage.ts";
export type { OpenCount, UsageStore, UsageStoreOptions } from "./system/usage.ts";
export type { QueuedJob, QueuedJobData } from "./system/queue.ts";
export { createWorkspaceDeletionStore } from "./system/workspace-deletion.ts";
export type { WorkspaceDeletionStore, WorkspaceDeletionStoreOptions } from "./system/workspace-deletion.ts";
export { WORKSPACE_PURGE_BATCH_SIZE, workspacePurgeOrder } from "./purge-registry.ts";
export { createAuthStore } from "./system/auth.ts";
export type {
  ApiTokenPrincipalRecord,
  AuthStore,
  AuthStoreOptions,
  LoginCandidate,
  NewSession,
  PasswordChange,
  SessionRecord,
  SessionSummary,
  SignInAlertContext,
} from "./system/auth.ts";
export type { CompleteSetup, SetupOutcome, SetupStore } from "./system/setup.ts";
export type { InstanceSettingsStore } from "./system/instance-settings.ts";
export type { NewRegistration, RegistrationStore } from "./system/registration.ts";
export type { InvitationAccountStore, InvitationAccountWrites, NewInvitationAccount } from "./system/invitation-account.ts";
export type { InvitationIdentityStore, InvitationIdentityWrites, NewInvitationIdentity } from "./system/invitation-identity.ts";
export type { AddressJobs } from "./system/address-jobs.ts";
export type { EmailVerification, EmailVerificationStore, VerificationResend, VerifiedEmail } from "./system/email-verification.ts";
export type { EmailChangeRequest, EmailChangeStore } from "./system/email-change.ts";
export type { PasswordReset, PasswordResetRequest, PasswordResetStore, ResetPasswordOutcome } from "./system/password-reset.ts";
export type { NewPersonalWorkspace, PersonalWorkspaceResult, PersonalWorkspaceWriter } from "./system/personal-workspace.ts";
export type { IdentityLink, IdentityLinkOutcome, IdentityReauthentication, IdentitySignIn, IdentityUnlinkOutcome, NewOidcLoginState, OidcLoginState, OidcStore, SealedVerifier } from "./system/oidc.ts";
export type {
  BackupCodeRecord,
  BackupCodesRegeneration,
  BackupCodesRegenerationOutcome,
  CodeReauthentication,
  CodeReauthenticationOutcome,
  MfaActivation,
  MfaActivationOutcome,
  MfaDisabling,
  MfaDisablingOutcome,
  MfaState,
  MfaStore,
  SealedMfaSecret,
  SecondFactor,
  SignInCompletion,
  SignInCompletionOutcome,
  UnusedBackupCode,
} from "./system/mfa.ts";
