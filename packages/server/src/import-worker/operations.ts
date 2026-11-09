import type { OperationDefinition } from "@slugbase/contracts";
import type { ImportJobKind } from "./job.ts";

/** The operations whose body is read by the import worker, and what kind of body each has. */
const IMPORT_OPERATIONS: ReadonlyMap<string, ImportJobKind> = new Map([
  ["importJson", "json"],
  ["importNetscape", "netscape"],
]);

/** Whether the body of `operation` is decoded and parsed by the import worker and not by the stages of the request thread. */
export function isImportOperation(operation: OperationDefinition): boolean {
  return IMPORT_OPERATIONS.has(operation.operationId);
}
