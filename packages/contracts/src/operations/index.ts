import type { OperationDefinition } from "./define.ts";
import { login, logout, verifyMfa } from "./auth.ts";
import { changePassword, confirmMfaEnrollment, createApiToken, disableMfa, getMe, listApiTokens, listSessions, reauthenticate, regenerateMfaBackupCodes, revokeApiToken, revokeSession, revokeSessions, startMfaEnrollment, updateMe } from "./me.ts";
import { getApiConfig, getHealth, getOpenApiDocument, getReady, getVersion } from "./meta.ts";
import { completeSetup, getSetupStatus } from "./setup.ts";

/** Every operation the generator publishes. A new tag file adds its operations here. */
export const operations: readonly OperationDefinition[] = [getHealth, getReady, getVersion, getApiConfig, getOpenApiDocument, login, verifyMfa, logout, getMe, updateMe, listSessions, revokeSession, revokeSessions, reauthenticate, changePassword, startMfaEnrollment, confirmMfaEnrollment, regenerateMfaBackupCodes, disableMfa, listApiTokens, createApiToken, revokeApiToken, getSetupStatus, completeSetup];

export * from "./auth.ts";
export * from "./define.ts";
export * from "./me.ts";
export * from "./meta.ts";
export * from "./setup.ts";
