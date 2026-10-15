import type { OperationDefinition } from "./define.ts";
import { completeOidcSignIn, login, logout, startOidcSignIn, verifyMfa } from "./auth.ts";
import { changePassword, confirmMfaEnrollment, createApiToken, disableMfa, getMe, listApiTokens, listIdentities, listSessions, reauthenticate, regenerateMfaBackupCodes, revokeApiToken, revokeSession, revokeSessions, startMfaEnrollment, unlinkIdentity, updateMe } from "./me.ts";
import { getApiConfig, getHealth, getOpenApiDocument, getReady, getVersion } from "./meta.ts";
import { completeSetup, getSetupStatus } from "./setup.ts";

/** Every operation the generator publishes. A new tag file adds its operations here. */
export const operations: readonly OperationDefinition[] = [getHealth, getReady, getVersion, getApiConfig, getOpenApiDocument, login, verifyMfa, logout, startOidcSignIn, completeOidcSignIn, getMe, updateMe, listSessions, revokeSession, revokeSessions, reauthenticate, changePassword, startMfaEnrollment, confirmMfaEnrollment, regenerateMfaBackupCodes, disableMfa, listApiTokens, createApiToken, revokeApiToken, listIdentities, unlinkIdentity, getSetupStatus, completeSetup];

export * from "./auth.ts";
export * from "./define.ts";
export * from "./me.ts";
export * from "./meta.ts";
export * from "./setup.ts";
