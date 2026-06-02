import { analyticsConsents } from "../../analytics/analytics-consent.schema.js";
import { billingWebhookEvents } from "./billing-webhook-event.schema.js";
import { auditEvents } from "./audit-event.schema.js";
import { aiSuggestionCache } from "./ai-suggestion-cache.schema.js";
import { bookmarkFolders } from "./bookmark-folder.schema.js";
import { bookmarkTeamShares } from "./bookmark-team-share.schema.js";
import { bookmarkUserShares } from "./bookmark-user-share.schema.js";
import { bookmarkTags } from "./bookmark-tag.schema.js";
import { bookmarks } from "./bookmark.schema.js";
import { folderTeamShares } from "./folder-team-share.schema.js";
import { folderUserShares } from "./folder-user-share.schema.js";
import { tags } from "./tag.schema.js";
import { teamMemberships } from "./team-membership.schema.js";
import { teams } from "./team.schema.js";
import { folders } from "./folder.schema.js";
import { apiTokens } from "./api-token.schema.js";
import { emailChangeTokens } from "./email-change-token.schema.js";
import { emailVerificationTokens } from "./email-verification-token.schema.js";
import { mfaBackupCodes } from "./mfa-backup-code.schema.js";
import { instanceMetadata } from "./system.schema.js";
import { oidcAccounts } from "./oidc-account.schema.js";
import { oidcProviders } from "./oidc-provider.schema.js";
import { passwordResetTokens } from "./password-reset-token.schema.js";
import { sessions } from "./session.schema.js";
import { slugPreferences } from "./slug-preference.schema.js";
import { userAccounts } from "./user-account.schema.js";
import { workspaceInvitations } from "./workspace-invitation.schema.js";
import { workspaceMembers } from "./workspace-member.schema.js";
import { workspaces } from "./workspace.schema.js";

export { analyticsConsents } from "../../analytics/analytics-consent.schema.js";
export { billingWebhookEvents } from "./billing-webhook-event.schema.js";
export { auditEvents } from "./audit-event.schema.js";
export { aiSuggestionCache } from "./ai-suggestion-cache.schema.js";
export { bookmarkFolders } from "./bookmark-folder.schema.js";
export { bookmarkTeamShares } from "./bookmark-team-share.schema.js";
export { bookmarkUserShares } from "./bookmark-user-share.schema.js";
export { bookmarkTags } from "./bookmark-tag.schema.js";
export { bookmarks } from "./bookmark.schema.js";
export { folderTeamShares } from "./folder-team-share.schema.js";
export { folderUserShares } from "./folder-user-share.schema.js";
export { tags } from "./tag.schema.js";
export { teamMemberships } from "./team-membership.schema.js";
export { teams } from "./team.schema.js";
export { folders } from "./folder.schema.js";
export { apiTokens } from "./api-token.schema.js";
export { emailChangeTokens } from "./email-change-token.schema.js";
export { emailVerificationTokens } from "./email-verification-token.schema.js";
export { mfaBackupCodes } from "./mfa-backup-code.schema.js";
export { instanceMetadata } from "./system.schema.js";
export { oidcAccounts } from "./oidc-account.schema.js";
export { oidcProviders } from "./oidc-provider.schema.js";
export { passwordResetTokens } from "./password-reset-token.schema.js";
export { sessions } from "./session.schema.js";
export { slugPreferences } from "./slug-preference.schema.js";
export { userAccounts } from "./user-account.schema.js";
export { workspaceInvitations } from "./workspace-invitation.schema.js";
export { workspaceMembers } from "./workspace-member.schema.js";
export { workspaces } from "./workspace.schema.js";

export const schema = {
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
  emailChangeTokens,
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

export type AppSchema = typeof schema;
