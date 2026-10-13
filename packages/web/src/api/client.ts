import type { ComponentTypes, paths } from "@slugbase/contracts";
import createClient, { type Client, type Middleware } from "openapi-fetch";

/** The stable machine identifier of a problem (doc 04 section 3.2). */
export type ApiProblemCode = ComponentTypes["schemas"]["Problem"]["code"];

type ProblemFields = { code: ApiProblemCode; status: number; requestId: string };

const PROBLEM_CONTENT_TYPE = "application/problem+json";

/**
 * A failed API call that answered with a problem document (doc 04 section 3):
 * the stable machine `code`, the HTTP `status` and the `requestId` that ties the
 * failure to the server log. The English `detail` of the document is kept off the
 * error message because it may hold user-supplied values.
 */
export class ApiProblemError extends Error {
  readonly code: ApiProblemCode;
  readonly status: number;
  readonly requestId: string;

  constructor(problem: { code: ApiProblemCode; status: number; requestId: string }) {
    super(`The API answered ${String(problem.status)} ${problem.code}`);
    this.name = "ApiProblemError";
    this.code = problem.code;
    this.status = problem.status;
    this.requestId = problem.requestId;
  }
}

export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  /** The origin the API is reached at; by default the origin of the page, so every call is same-origin. */
  readonly baseUrl?: string;
  /** Replaces the transport; by default the platform one. */
  readonly fetch?: (request: Request) => Promise<Response>;
}

function isProblem(value: unknown): value is ProblemFields {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { code, status, requestId } = value as Record<string, unknown>;
  return typeof code === "string" && typeof status === "number" && typeof requestId === "string";
}

const problemMiddleware: Middleware = {
  async onResponse({ response }) {
    if (response.ok || !(response.headers.get("Content-Type") ?? "").toLowerCase().startsWith(PROBLEM_CONTENT_TYPE)) {
      return undefined;
    }
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => undefined);
    if (isProblem(body)) {
      throw new ApiProblemError(body);
    }
    return undefined;
  },
};

/**
 * The typed client over the generated `paths` (doc 04 section 1.1) and the only
 * network path of the web app. Calls are same-origin: the session cookie travels
 * with them and no CORS mode is set. A problem response throws `ApiProblemError`;
 * a network failure or an abort rejects with the transport's own error.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? globalThis.location.origin,
    credentials: "same-origin",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  client.use(problemMiddleware);
  return client;
}
