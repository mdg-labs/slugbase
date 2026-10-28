import type { OperationDefinition } from "./define.ts";
import { completeOidcSignIn, forgotPassword, login, logout, register, resendVerifyEmail, resetPassword, startOidcSignIn, verifyEmail, verifyMfa } from "./auth.ts";
import { cancelEmailChange, cancelPendingEmailChange, changePassword, confirmEmailChange, confirmMfaEnrollment, createApiToken, deleteMe, disableMfa, getMe, listApiTokens, listIdentities, listSessions, reauthenticate, regenerateMfaBackupCodes, requestEmailChange, revokeApiToken, revokeSession, revokeSessions, startMfaEnrollment, unlinkIdentity, updateMe } from "./me.ts";
import { acceptInvitation, createInvitation, createInvitationLink, inspectInvitation, listInvitations, resendInvitation, revokeInvitation } from "./invitations.ts";
import { bulkBookmarks, checkSlugAvailability, createBookmark, deleteBookmark, getBookmark, listBookmarkIds, listBookmarks, openBookmark, previewBulkBookmarks, updateBookmark } from "./bookmarks.ts";
import { getEntitlements } from "./entitlements.ts";
import { chooseSlug, resolveSlug, suggestSlugs } from "./go.ts";
import { deleteGoPreference, listGoPreferences } from "./go-preferences.ts";
import { addFolderBookmarks, createFolder, deleteFolder, getFolder, listFolders, removeFolderBookmarks, updateFolder } from "./folders.ts";
import { createTag, deleteTag, getTagStats, listTags, mergeTag, renameTag } from "./tags.ts";
import { getDashboard } from "./dashboard.ts";
import { search } from "./search.ts";
import { addInstanceAdminMembership, createInstanceWorkspace, deleteInstanceAccount, deleteInstanceWorkspace, getInstanceSettings, getInstanceStatus, issueInstanceAccountResetLink, issueInstanceWorkspaceOwnerInvitation, listInstanceAccounts, listInstanceWorkspaces, resendInstanceAccountVerification, resetInstanceAccountMfa, sendInstanceTestMail, updateInstanceAccount, updateInstanceSettings } from "./instance.ts";
import { listMembers, removeMember, updateMember } from "./members.ts";
import { getApiConfig, getHealth, getOpenApiDocument, getReady, getVersion } from "./meta.ts";
import { completeSetup, getSetupStatus } from "./setup.ts";
import { createWorkspace, deleteWorkspace, getWorkspace, getWorkspaceSettings, leaveWorkspace, listWorkspaces, renameWorkspace, setActiveWorkspace, transferWorkspaceOwnership, updateWorkspaceSettings } from "./workspaces.ts";

/** Every operation the generator publishes. A new tag file adds its operations here. */
export const operations: readonly OperationDefinition[] = [getHealth, getReady, getVersion, getApiConfig, getOpenApiDocument, login, register, verifyEmail, resendVerifyEmail, forgotPassword, resetPassword, verifyMfa, logout, startOidcSignIn, completeOidcSignIn, getMe, updateMe, listSessions, revokeSession, revokeSessions, reauthenticate, changePassword, requestEmailChange, confirmEmailChange, cancelEmailChange, cancelPendingEmailChange, startMfaEnrollment, confirmMfaEnrollment, regenerateMfaBackupCodes, disableMfa, listApiTokens, createApiToken, revokeApiToken, listIdentities, unlinkIdentity, getSetupStatus, completeSetup, listWorkspaces, createWorkspace, setActiveWorkspace, getWorkspace, renameWorkspace, getWorkspaceSettings, updateWorkspaceSettings, listMembers, updateMember, removeMember, leaveWorkspace, deleteWorkspace, transferWorkspaceOwnership, getEntitlements, deleteMe, createInvitation, listInvitations, resendInvitation, createInvitationLink, revokeInvitation, inspectInvitation, acceptInvitation, getInstanceStatus, getInstanceSettings, updateInstanceSettings, sendInstanceTestMail, listInstanceWorkspaces, createInstanceWorkspace, addInstanceAdminMembership, issueInstanceWorkspaceOwnerInvitation, deleteInstanceWorkspace, listInstanceAccounts, updateInstanceAccount, deleteInstanceAccount, resetInstanceAccountMfa, issueInstanceAccountResetLink, resendInstanceAccountVerification, createBookmark, listBookmarks, listBookmarkIds, bulkBookmarks, previewBulkBookmarks, getBookmark, updateBookmark, deleteBookmark, openBookmark, checkSlugAvailability, resolveSlug, chooseSlug, suggestSlugs, listGoPreferences, deleteGoPreference, createTag, listTags, getTagStats, renameTag, mergeTag, deleteTag, createFolder, listFolders, getFolder, updateFolder, deleteFolder, addFolderBookmarks, removeFolderBookmarks, search, getDashboard];

export * from "./auth.ts";
export * from "./bookmarks.ts";
export * from "./dashboard.ts";
export * from "./define.ts";
export * from "./entitlements.ts";
export * from "./folders.ts";
export * from "./go.ts";
export * from "./go-preferences.ts";
export * from "./instance.ts";
export * from "./invitations.ts";
export * from "./me.ts";
export * from "./members.ts";
export * from "./meta.ts";
export * from "./search.ts";
export * from "./setup.ts";
export * from "./tags.ts";
export * from "./workspaces.ts";
