import type { OperationDefinition } from "./define.ts";
import { login, logout } from "./auth.ts";
import { getMe, listSessions, revokeSession, revokeSessions } from "./me.ts";
import { getApiConfig, getHealth, getOpenApiDocument, getReady, getVersion } from "./meta.ts";

/** Every operation the generator publishes. A new tag file adds its operations here. */
export const operations: readonly OperationDefinition[] = [getHealth, getReady, getVersion, getApiConfig, getOpenApiDocument, login, logout, getMe, listSessions, revokeSession, revokeSessions];

export * from "./auth.ts";
export * from "./define.ts";
export * from "./me.ts";
export * from "./meta.ts";
