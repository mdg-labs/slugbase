import { readFileSync } from "node:fs";
import type { ContractDocument } from "./register.ts";

// packages/server/{src,dist}/routes/ -> packages/contracts/generated/openapi.json
const COMMITTED_DOCUMENT = new URL("../../../contracts/generated/openapi.json", import.meta.url);

/**
 * The OpenAPI document committed with `@slugbase/contracts`: the policy every
 * Community Edition route is registered against. Throws when it cannot be read,
 * so a server that cannot check its routes does not start.
 */
export function loadCommittedDocument(): ContractDocument {
  const parsed = JSON.parse(readFileSync(COMMITTED_DOCUMENT, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("paths" in parsed) || typeof parsed.paths !== "object" || parsed.paths === null) {
    throw new Error("the committed OpenAPI document has no paths");
  }
  return parsed as ContractDocument;
}
