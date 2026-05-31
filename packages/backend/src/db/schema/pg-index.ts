import { analyticsConsents } from "../../analytics/analytics-consent.schema.pg.js";
import { billingWebhookEvents } from "./billing-webhook-event.schema.pg.js";
import { auditEvents } from "./audit-event.schema.pg.js";
import { aiSuggestionCache } from "./ai-suggestion-cache.schema.pg.js";
import { bookmarkFolders } from "./bookmark-folder.schema.pg.js";
import { bookmarkTeamShares } from "./bookmark-team-share.schema.pg.js";
import { bookmarkUserShares } from "./bookmark-user-share.schema.pg.js";
import { bookmarkTags } from "./bookmark-tag.schema.pg.js";
import { bookmarks } from "./bookmark.schema.pg.js";
import { folderTeamShares } from "./folder-team-share.schema.pg.js";
import { folderUserShares } from "./folder-user-share.schema.pg.js";
import { tags } from "./tag.schema.pg.js";
import { teamMemberships } from "./team-membership.schema.pg.js";
import { teams } from "./team.schema.pg.js";
import { folders } from "./folder.schema.pg.js";
import { apiTokens } from "./api-token.schema.pg.js";
import { emailVerificationTokens } from "./email-verification-token.schema.pg.js";
import { mfaBackupCodes } from "./mfa-backup-code.schema.pg.js";
import { instanceMetadata } from "./system.schema.pg.js";
import { oidcAccounts } from "./oidc-account.schema.pg.js";
import { oidcProviders } from "./oidc-provider.schema.pg.js";
import { passwordResetTokens } from "./password-reset-token.schema.pg.js";
import { sessions } from "./session.schema.pg.js";
import { slugPreferences } from "./slug-preference.schema.pg.js";
import { userAccounts } from "./user-account.schema.pg.js";
import { workspaceInvitations } from "./workspace-invitation.schema.pg.js";
import { workspaceMembers } from "./workspace-member.schema.pg.js";
import { workspaces } from "./workspace.schema.pg.js";

export { analyticsConsents } from "../../analytics/analytics-consent.schema.pg.js";
export { billingWebhookEvents } from "./billing-webhook-event.schema.pg.js";
export { auditEvents } from "./audit-event.schema.pg.js";
export { aiSuggestionCache } from "./ai-suggestion-cache.schema.pg.js";
export { bookmarkFolders } from "./bookmark-folder.schema.pg.js";
export { bookmarkTeamShares } from "./bookmark-team-share.schema.pg.js";
export { bookmarkUserShares } from "./bookmark-user-share.schema.pg.js";
export { bookmarkTags } from "./bookmark-tag.schema.pg.js";
export { bookmarks } from "./bookmark.schema.pg.js";
export { folderTeamShares } from "./folder-team-share.schema.pg.js";
export { folderUserShares } from "./folder-user-share.schema.pg.js";
export { tags } from "./tag.schema.pg.js";
export { teamMemberships } from "./team-membership.schema.pg.js";
export { teams } from "./team.schema.pg.js";
export { folders } from "./folder.schema.pg.js";
export { apiTokens } from "./api-token.schema.pg.js";
export { emailVerificationTokens } from "./email-verification-token.schema.pg.js";
export { mfaBackupCodes } from "./mfa-backup-code.schema.pg.js";
export { instanceMetadata } from "./system.schema.pg.js";
export { oidcAccounts } from "./oidc-account.schema.pg.js";
export { oidcProviders } from "./oidc-provider.schema.pg.js";
export { passwordResetTokens } from "./password-reset-token.schema.pg.js";
export { sessions } from "./session.schema.pg.js";
export { slugPreferences } from "./slug-preference.schema.pg.js";
export { userAccounts } from "./user-account.schema.pg.js";
export { workspaceInvitations } from "./workspace-invitation.schema.pg.js";
export { workspaceMembers } from "./workspace-member.schema.pg.js";
export { workspaces } from "./workspace.schema.pg.js";

export const pgSchema = {
  analyticsConsents,
  billingWebhookEvents,
  auditEvents,
  aiSuggestionCache,
  instanceMetadata,
  bookmarkFolders,
  bookmarkTeamShares,
  bookmarkUserShares,
  bookmarkTags,
  bookmarks,
  folderTeamShares,
  folderUserShares,
  folders,
  tags,
  teamMemberships,
  teams,
  apiTokens,
  emailVerificationTokens,
  mfaBackupCodes,
  oidcAccounts,
  oidcProviders,
  passwordResetTokens,
  sessions,
  slugPreferences,
  userAccounts,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
};

export type PgAppSchema = typeof pgSchema;
