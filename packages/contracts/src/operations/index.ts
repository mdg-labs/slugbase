import type { OperationDefinition } from "./define.ts";
import { completeOidcSignIn, forgotPassword, login, logout, register, resendVerifyEmail, resetPassword, startOidcSignIn, verifyEmail, verifyMfa } from "./auth.ts";
import { cancelEmailChange, cancelPendingEmailChange, changePassword, confirmEmailChange, confirmMfaEnrollment, createApiToken, disableMfa, getMe, listApiTokens, listIdentities, listSessions, reauthenticate, regenerateMfaBackupCodes, requestEmailChange, revokeApiToken, revokeSession, revokeSessions, startMfaEnrollment, unlinkIdentity, updateMe } from "./me.ts";
import { getApiConfig, getHealth, getOpenApiDocument, getReady, getVersion } from "./meta.ts";
import { completeSetup, getSetupStatus } from "./setup.ts";

/** Every operation the generator publishes. A new tag file adds its operations here. */
export const operations: readonly OperationDefinition[] = [getHealth, getReady, getVersion, getApiConfig, getOpenApiDocument, login, register, verifyEmail, resendVerifyEmail, forgotPassword, resetPassword, verifyMfa, logout, startOidcSignIn, completeOidcSignIn, getMe, updateMe, listSessions, revokeSession, revokeSessions, reauthenticate, changePassword, requestEmailChange, confirmEmailChange, cancelEmailChange, cancelPendingEmailChange, startMfaEnrollment, confirmMfaEnrollment, regenerateMfaBackupCodes, disableMfa, listApiTokens, createApiToken, revokeApiToken, listIdentities, unlinkIdentity, getSetupStatus, completeSetup];

export * from "./auth.ts";
export * from "./define.ts";
export * from "./me.ts";
export * from "./meta.ts";
export * from "./setup.ts";
