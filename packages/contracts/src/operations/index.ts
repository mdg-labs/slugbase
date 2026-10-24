import type { OperationDefinition } from "./define.ts";
import { completeOidcSignIn, forgotPassword, login, logout, register, resendVerifyEmail, resetPassword, startOidcSignIn, verifyEmail, verifyMfa } from "./auth.ts";
import { cancelEmailChange, cancelPendingEmailChange, changePassword, confirmEmailChange, confirmMfaEnrollment, createApiToken, deleteMe, disableMfa, getMe, listApiTokens, listIdentities, listSessions, reauthenticate, regenerateMfaBackupCodes, requestEmailChange, revokeApiToken, revokeSession, revokeSessions, startMfaEnrollment, unlinkIdentity, updateMe } from "./me.ts";
import { acceptInvitation, createInvitation, createInvitationLink, inspectInvitation, listInvitations, resendInvitation, revokeInvitation } from "./invitations.ts";
import { bulkBookmarks, createBookmark, deleteBookmark, getBookmark, listBookmarkIds, listBookmarks, openBookmark, updateBookmark } from "./bookmarks.ts";
import { getEntitlements } from "./entitlements.ts";
import { addInstanceAdminMembership, createInstanceWorkspace, deleteInstanceAccount, deleteInstanceWorkspace, getInstanceSettings, getInstanceStatus, issueInstanceAccountResetLink, issueInstanceWorkspaceOwnerInvitation, listInstanceAccounts, listInstanceWorkspaces, resendInstanceAccountVerification, resetInstanceAccountMfa, sendInstanceTestMail, updateInstanceAccount, updateInstanceSettings } from "./instance.ts";
import { listMembers, removeMember, updateMember } from "./members.ts";
import { getApiConfig, getHealth, getOpenApiDocument, getReady, getVersion } from "./meta.ts";
import { completeSetup, getSetupStatus } from "./setup.ts";
import { createWorkspace, deleteWorkspace, getWorkspace, getWorkspaceSettings, leaveWorkspace, listWorkspaces, renameWorkspace, setActiveWorkspace, transferWorkspaceOwnership, updateWorkspaceSettings } from "./workspaces.ts";

/** Every operation the generator publishes. A new tag file adds its operations here. */
export const operations: readonly OperationDefinition[] = [getHealth, getReady, getVersion, getApiConfig, getOpenApiDocument, login, register, verifyEmail, resendVerifyEmail, forgotPassword, resetPassword, verifyMfa, logout, startOidcSignIn, completeOidcSignIn, getMe, updateMe, listSessions, revokeSession, revokeSessions, reauthenticate, changePassword, requestEmailChange, confirmEmailChange, cancelEmailChange, cancelPendingEmailChange, startMfaEnrollment, confirmMfaEnrollment, regenerateMfaBackupCodes, disableMfa, listApiTokens, createApiToken, revokeApiToken, listIdentities, unlinkIdentity, getSetupStatus, completeSetup, listWorkspaces, createWorkspace, setActiveWorkspace, getWorkspace, renameWorkspace, getWorkspaceSettings, updateWorkspaceSettings, listMembers, updateMember, removeMember, leaveWorkspace, deleteWorkspace, transferWorkspaceOwnership, getEntitlements, deleteMe, createInvitation, listInvitations, resendInvitation, createInvitationLink, revokeInvitation, inspectInvitation, acceptInvitation, getInstanceStatus, getInstanceSettings, updateInstanceSettings, sendInstanceTestMail, listInstanceWorkspaces, createInstanceWorkspace, addInstanceAdminMembership, issueInstanceWorkspaceOwnerInvitation, deleteInstanceWorkspace, listInstanceAccounts, updateInstanceAccount, deleteInstanceAccount, resetInstanceAccountMfa, issueInstanceAccountResetLink, resendInstanceAccountVerification, createBookmark, listBookmarks, listBookmarkIds, bulkBookmarks, getBookmark, updateBookmark, deleteBookmark, openBookmark];

export * from "./auth.ts";
export * from "./bookmarks.ts";
export * from "./define.ts";
export * from "./entitlements.ts";
export * from "./instance.ts";
export * from "./invitations.ts";
export * from "./me.ts";
export * from "./members.ts";
export * from "./meta.ts";
export * from "./setup.ts";
export * from "./workspaces.ts";
