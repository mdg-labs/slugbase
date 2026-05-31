import { instanceMetadata } from "../system.schema.js";
import { apiTokens } from "./api-token.schema.js";
import { emailVerificationTokens } from "./email-verification-token.schema.js";
import { mfaBackupCodes } from "./mfa-backup-code.schema.js";
import { oidcAccounts } from "./oidc-account.schema.js";
import { oidcProviders } from "./oidc-provider.schema.js";
import { passwordResetTokens } from "./password-reset-token.schema.js";
import { sessions } from "./session.schema.js";
import { userAccounts } from "./user-account.schema.js";
import { workspaceInvitations } from "./workspace-invitation.schema.js";
import { workspaceMembers } from "./workspace-member.schema.js";
import { workspaces } from "./workspace.schema.js";

export { instanceMetadata } from "../system.schema.js";
export { apiTokens } from "./api-token.schema.js";
export { emailVerificationTokens } from "./email-verification-token.schema.js";
export { mfaBackupCodes } from "./mfa-backup-code.schema.js";
export { oidcAccounts } from "./oidc-account.schema.js";
export { oidcProviders } from "./oidc-provider.schema.js";
export { passwordResetTokens } from "./password-reset-token.schema.js";
export { sessions } from "./session.schema.js";
export { userAccounts } from "./user-account.schema.js";
export { workspaceInvitations } from "./workspace-invitation.schema.js";
export { workspaceMembers } from "./workspace-member.schema.js";
export { workspaces } from "./workspace.schema.js";

export const schema = {
  instanceMetadata,
  apiTokens,
  emailVerificationTokens,
  mfaBackupCodes,
  oidcAccounts,
  oidcProviders,
  passwordResetTokens,
  sessions,
  userAccounts,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
};

export type AppSchema = typeof schema;
