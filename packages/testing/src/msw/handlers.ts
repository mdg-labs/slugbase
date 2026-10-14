import { http, HttpResponse, type HttpHandler } from "msw";
import {
  describe,
  isRecord,
  listOperations,
  type DeclaredResponse,
  type DocumentOperation,
  type HttpMethod,
  type OpenApiDocument,
} from "./document.js";
import { fixtureFor } from "./fixture.js";
import { DEFAULT_SCENARIO, type Scenario } from "./scenarios.js";

const PROBLEM_MEDIA_TYPE = "application/problem+json";

// A schema of type string would give `Set-Cookie` the value `string`, which the cookie store of the MSW
// server cannot parse: it answers 500. Any operation that declares the header gets a cookie that parses,
// shaped like the session cookie of doc 04 section 4.1 without the `__Host-` prefix and `Secure` that
// only an https origin accepts.
const MOCK_SET_COOKIE = "slugbase_session=mock-session; Path=/; HttpOnly; SameSite=Lax";

function headerValue(document: OpenApiDocument, name: string, schema: unknown): string {
  return name.toLowerCase() === "set-cookie" ? MOCK_SET_COOKIE : String(fixtureFor(document, schema));
}

// The stable code a problem document carries for each status the contract
// declares (doc 04 section 3.2).
const PROBLEM_CODE: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  412: "precondition_failed",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "validation_failed",
  429: "rate_limited",
  500: "internal",
  502: "upstream_failed",
  503: "unavailable",
};

export interface CreateHandlersOptions {
  /** The state the handlers answer in; by default `default`. */
  readonly scenario?: Scenario;
  /** operationId to the body of the success response, replacing the generated one in every scenario. */
  readonly fixtures?: Readonly<Record<string, unknown>>;
  /** The origin the handlers match; by default none, so they match the origin of the page. */
  readonly baseUrl?: string;
}

/**
 * Bodies the document alone cannot make useful. Each one is checked against the
 * response schema of its operation by the tests, so a contract change that
 * invalidates one fails there.
 */
export function baseFixtures(document: OpenApiDocument): Readonly<Record<string, unknown>> {
  return {
    getApiConfig: {
      apiVersion: "v1",
      origin: "https://slugbase.example",
      product: { name: "SlugBase Mock", version: "0.0.0" },
      locales: ["en", "de"],
      defaultLocale: "en",
      docsBaseUrl: "https://slugbase.app/docs",
      features: { mail: false, ai: false },
      setupRequired: false,
    },
    getOpenApiDocument: document,
  };
}

function pickContent(response: DeclaredResponse): [string, unknown] | undefined {
  const json = response.content.get("application/json");
  if (json !== undefined) {
    return ["application/json", json];
  }
  const [first] = response.content.entries();
  return first;
}

function problemBody(schemaBody: unknown, status: number, operation: DocumentOperation): unknown {
  if (!isRecord(schemaBody)) {
    return schemaBody;
  }
  const code = PROBLEM_CODE[status] ?? "internal";
  const fields: Record<string, unknown> = {
    type: `https://slugbase.app/problems/${code}`,
    title: code,
    status,
    code,
    detail: `Mock answer for ${describe(operation)}`,
    requestId: "mock-request",
  };
  return Object.fromEntries(Object.entries(schemaBody).map(([key, value]) => [key, key in fields ? fields[key] : value]));
}

function chooseResponse(operation: DocumentOperation, scenario: Scenario): DeclaredResponse {
  const forced = scenario.statuses?.[operation.operationId];
  if (forced !== undefined) {
    const declared = operation.responses.find((response) => response.status === forced);
    if (declared === undefined) {
      throw new Error(
        `Scenario ${scenario.name} answers ${describe(operation)} with ${String(forced)}, which the operation does not declare`,
      );
    }
    return declared;
  }
  const success = operation.responses.find((response) => response.status < 400);
  if (success === undefined) {
    throw new Error(`${describe(operation)} declares no success response`);
  }
  return success;
}

function buildResponse(
  document: OpenApiDocument,
  operation: DocumentOperation,
  response: DeclaredResponse,
  fixtures: Readonly<Record<string, unknown>>,
): () => Response {
  // Entries, not a `Headers`: a `Headers` copied into the response init loses every header once it holds a
  // `Set-Cookie`, so each answer builds its own from the entries.
  const headers: [string, string][] = [];
  for (const [name, schema] of response.headers) {
    headers.push([name, headerValue(document, name, schema)]);
  }
  const content = operation.method === "head" ? undefined : pickContent(response);
  if (content === undefined) {
    return () => new HttpResponse(null, { status: response.status, headers: new Headers(headers) });
  }
  const [mediaType, schema] = content;
  const isJson = mediaType === "application/json" || mediaType.endsWith("+json");
  if (!isJson && !mediaType.startsWith("text/")) {
    throw new Error(`${describe(operation)} answers ${mediaType}; the mock builds JSON and text bodies only`);
  }
  const override = response.status < 400 ? fixtures[operation.operationId] : undefined;
  let value = override === undefined ? fixtureFor(document, schema) : override;
  if (override === undefined && mediaType === PROBLEM_MEDIA_TYPE) {
    value = problemBody(value, response.status, operation);
  }
  const body = isJson ? JSON.stringify(value) : String(value);
  const bodyHeaders = [...headers.filter(([name]) => name.toLowerCase() !== "content-type"), ["Content-Type", mediaType]] satisfies [string, string][];
  return () => new HttpResponse(body, { status: response.status, headers: new Headers(bodyHeaders) });
}

const BUILDERS: Readonly<Record<HttpMethod, typeof http.get>> = {
  get: http.get,
  put: http.put,
  post: http.post,
  delete: http.delete,
  patch: http.patch,
  head: http.head,
  options: http.options,
};

/**
 * `/api/v1/bookmarks/{bookmarkId}` as the path syntax of the handlers. A name holds
 * neither brace, so a run of unclosed `{` is scanned once, not once per brace.
 */
export function handlerPath(template: string): string {
  return template.replaceAll(/\{([^{}]+)\}/g, ":$1");
}

/**
 * One handler per operation of the document. Every answer is built when the
 * handlers are created, so an operation the mock cannot answer fails here, not
 * on the request that first reaches it.
 */
export function createHandlers(document: OpenApiDocument, options: CreateHandlersOptions = {}): HttpHandler[] {
  const scenario = options.scenario ?? DEFAULT_SCENARIO;
  const fixtures = { ...baseFixtures(document), ...options.fixtures, ...scenario.fixtures };
  const baseUrl = options.baseUrl ?? "";
  return listOperations(document).map((operation) => {
    const respond = buildResponse(document, operation, chooseResponse(operation, scenario), fixtures);
    return BUILDERS[operation.method](`${baseUrl}${handlerPath(operation.path)}`, () => respond());
  });
}
