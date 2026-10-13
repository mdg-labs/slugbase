/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setupServer, type SetupServer } from "msw/node";
import { parseDocument, type OpenApiDocument } from "./document.js";
import { createHandlers, type CreateHandlersOptions } from "./handlers.js";
import type { Scenario } from "./scenarios.js";

// packages/testing/{src,dist}/msw/ -> packages/contracts/generated/openapi.json. Not a
// `new URL(..., import.meta.url)`: Vite reads that form as an asset and rewrites it to an HTTP URL in tests.
const COMMITTED_DOCUMENT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../contracts/generated/openapi.json");

/** The committed OpenAPI document, as the contracts package generated it. */
export function readOpenApiDocument(): OpenApiDocument {
  return parseDocument(JSON.parse(readFileSync(COMMITTED_DOCUMENT, "utf8")));
}

export type { CreateHandlersOptions, OpenApiDocument, Scenario };

export interface MockServerOptions extends CreateHandlersOptions {
  /** The document to mock; by default the committed one. */
  readonly document?: OpenApiDocument;
}

/**
 * The handlers of the committed document on an MSW server for Node. Without a
 * `baseUrl` the handlers match the origin of the page, which a jsdom test has;
 * a test without a page gives one.
 */
export function createMockServer(options: MockServerOptions = {}): SetupServer {
  const { document = readOpenApiDocument(), ...rest } = options;
  return setupServer(...createHandlers(document, rest));
}
