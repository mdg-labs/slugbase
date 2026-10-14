import type { OperationDefinition } from "./define.ts";
import { login, logout } from "./auth.ts";
import { changePassword, getMe, listSessions, reauthenticate, revokeSession, revokeSessions, updateMe } from "./me.ts";
import { getApiConfig, getHealth, getOpenApiDocument, getReady, getVersion } from "./meta.ts";
import { completeSetup, getSetupStatus } from "./setup.ts";

/** Every operation the generator publishes. A new tag file adds its operations here. */
export const operations: readonly OperationDefinition[] = [getHealth, getReady, getVersion, getApiConfig, getOpenApiDocument, login, logout, getMe, updateMe, listSessions, revokeSession, revokeSessions, reauthenticate, changePassword, getSetupStatus, completeSetup];

export * from "./auth.ts";
export * from "./define.ts";
export * from "./me.ts";
export * from "./meta.ts";
export * from "./setup.ts";
