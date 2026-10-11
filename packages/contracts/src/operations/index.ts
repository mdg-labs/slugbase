import type { OperationDefinition } from "./define.ts";
import { getHealth, getReady, getVersion } from "./meta.ts";

/** Every operation the generator publishes. A new tag file adds its operations here. */
export const operations: readonly OperationDefinition[] = [getHealth, getReady, getVersion];

export * from "./define.ts";
export * from "./meta.ts";
