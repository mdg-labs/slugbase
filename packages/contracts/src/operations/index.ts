import type { OperationDefinition } from "./define.ts";
import { getApiConfig, getHealth, getOpenApiDocument, getReady, getVersion } from "./meta.ts";

/** Every operation the generator publishes. A new tag file adds its operations here. */
export const operations: readonly OperationDefinition[] = [getHealth, getReady, getVersion, getApiConfig, getOpenApiDocument];

export * from "./define.ts";
export * from "./meta.ts";
