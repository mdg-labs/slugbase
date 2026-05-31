import { bookmarks } from "./bookmark.schema.pg.js";
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

export { bookmarks } from "./bookmark.schema.pg.js";
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
  instanceMetadata,
  bookmarks,
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
