import { readFileSync } from "node:fs";
import { getOpenApiDocument } from "@slugbase/contracts";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { ContractDocument } from "../register.ts";

// GET /api/v1/openapi.json (doc 04 section 1.4): the committed document, byte
// for byte. The body is sent as it is stored; the response stage lets it
// through unchanged (see `isOpenApiDocument`) because re-serialising it, which
// is how that stage strips undeclared fields in production, would change it.

// packages/server/{src,dist}/routes/meta/ -> packages/contracts/generated/openapi.json
const COMMITTED_DOCUMENT = new URL("../../../../contracts/generated/openapi.json", import.meta.url);

export interface OpenApiRouteOptions {
  readonly enabled: boolean;
  /** The document the composition registers its routes against, when it passes one instead of the committed document. */
  readonly document: ContractDocument | undefined;
}

/**
 * The bytes served: the committed file, or, for a composition that passes the
 * merged document of its own operations, that document in the committed format.
 */
function documentBytes(document: ContractDocument | undefined): string {
  return document === undefined ? readFileSync(COMMITTED_DOCUMENT, "utf8") : `${JSON.stringify(document, null, 2)}\n`;
}

/** Whether a response is the document this route serves, which the response stage must not re-serialise. */
export function isOpenApiDocument(operationId: string | undefined, status: number): boolean {
  return operationId === getOpenApiDocument.operationId && status === 200;
}

export function openApiRoute({ enabled, document }: OpenApiRouteOptions): RouteBinding {
  const body = enabled ? documentBytes(document) : undefined;
  return {
    operation: getOpenApiDocument,
    handler: () => {
      if (body === undefined) {
        throw new ProblemError("not_found", "The API reference documents are disabled on this server.");
      }
      return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    },
  };
}
