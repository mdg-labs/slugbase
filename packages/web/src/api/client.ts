import type { ComponentTypes, paths } from "@slugbase/contracts";
import createClient, { type Client, type Middleware } from "openapi-fetch";

/** The stable machine identifier of a problem (doc 04 section 3.2). */
export type ApiProblemCode = ComponentTypes["schemas"]["Problem"]["code"];

type FieldError = ComponentTypes["schemas"]["ProblemFieldError"];

type ProblemFields = {
  code: ApiProblemCode;
  status: number;
  requestId: string;
  errors?: readonly FieldError[] | undefined;
  retryAfterSeconds?: number | undefined;
};

const PROBLEM_CONTENT_TYPE = "application/problem+json";
const CONFIG_PATH = "/api/config";

/**
 * A failed API call that answered with a problem document (doc 04 section 3):
 * the stable machine `code`, the HTTP `status` and the `requestId` that ties the
 * failure to the server log. The English `detail` of the document is kept off the
 * error message because it may hold user-supplied values. `retryAfterSeconds` is the
 * wait a `Retry-After` header asks for, and `errors` the per-field errors of the document.
 */
export class ApiProblemError extends Error {
  readonly code: ApiProblemCode;
  readonly status: number;
  readonly requestId: string;
  readonly retryAfterSeconds: number | undefined;
  readonly errors: readonly { readonly path: string; readonly code: string }[];

  constructor(problem: {
    code: ApiProblemCode;
    status: number;
    requestId: string;
    errors?: readonly { readonly path: string; readonly code: string }[] | undefined;
    retryAfterSeconds?: number | undefined;
  }) {
    super(`The API answered ${String(problem.status)} ${problem.code}`);
    this.name = "ApiProblemError";
    this.code = problem.code;
    this.status = problem.status;
    this.requestId = problem.requestId;
    this.retryAfterSeconds = problem.retryAfterSeconds;
    this.errors = problem.errors ?? [];
  }
}

export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  /** The origin the API is reached at; by default the origin of the page, so every call is same-origin. */
  readonly baseUrl?: string;
  /** Replaces the transport; by default the platform one. */
  readonly fetch?: (request: Request) => Promise<Response>;
  /** Called when an answer other than the configuration's says the session has ended. */
  readonly onUnauthenticated?: () => void;
}

function isFieldError(value: unknown): value is FieldError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { path, code } = value as Record<string, unknown>;
  return typeof path === "string" && typeof code === "string";
}

function isProblem(value: unknown): value is ProblemFields {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { code, status, requestId } = value as Record<string, unknown>;
  return typeof code === "string" && typeof status === "number" && typeof requestId === "string";
}

/** The wait a `Retry-After` header asks for, in whole seconds: delay seconds or an HTTP date; undefined when absent or unreadable. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  const value = header?.trim();
  if (value === undefined || value === "") {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  // An HTTP date starts with a day name; the date parser alone also accepts a bare number as a year.
  const date = /^[A-Za-z]/.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

async function readProblem(response: Response): Promise<ProblemFields | undefined> {
  if (!(response.headers.get("Content-Type") ?? "").toLowerCase().startsWith(PROBLEM_CONTENT_TYPE)) {
    return undefined;
  }
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  return isProblem(body) ? body : undefined;
}

/**
 * Whether a 401 means the session is gone. `/api/config` is answered without a
 * session, and `reauth_required` asks for a fresh password or code on a live
 * session (doc 04 section 4.4); neither sends the member back to sign in.
 */
function endsSession(request: Request, response: Response, problem: ProblemFields | undefined): boolean {
  return (
    response.status === 401 && new URL(request.url).pathname !== CONFIG_PATH && problem?.code !== "reauth_required"
  );
}

function createProblemMiddleware(onUnauthenticated: (() => void) | undefined): Middleware {
  return {
    async onResponse({ request, response }) {
      if (response.ok) {
        return undefined;
      }
      const problem = await readProblem(response);
      if (endsSession(request, response, problem)) {
        onUnauthenticated?.();
      }
      if (problem !== undefined) {
        throw new ApiProblemError({
          ...problem,
          errors: Array.isArray(problem.errors) ? problem.errors.filter(isFieldError) : undefined,
          retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
        });
      }
      return undefined;
    },
  };
}

/**
 * The typed client over the generated `paths` (doc 04 section 1.1) and the only
 * network path of the web app. Calls are same-origin: the session cookie travels
 * with them and no CORS mode is set. A problem response throws `ApiProblemError`;
 * a network failure or an abort rejects with the transport's own error. A `401`
 * that ends the session also calls `onUnauthenticated`, before the error is thrown.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? globalThis.location.origin,
    credentials: "same-origin",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  client.use(createProblemMiddleware(options.onUnauthenticated));
  return client;
}

/** Whether the error is a `401` that ended the session, as opposed to one asking for a fresh re-authentication. */
export function isSessionEnded(error: unknown): boolean {
  return error instanceof ApiProblemError && error.status === 401 && error.code !== "reauth_required";
}
