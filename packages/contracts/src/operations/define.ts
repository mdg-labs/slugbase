import { z } from "zod";

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * x-slugbase-auth: who may call the operation (doc 04 section 1.2). Every
 * policy but `partial` needs a session whose second factor is complete (doc 04
 * section 4.3); `partial` also admits a session still waiting for it.
 */
export const AUTH_POLICIES = ["anonymous", "partial", "account", "member", "admin", "owner", "instanceAdmin", "machine"] as const;
export type AuthPolicy = (typeof AUTH_POLICIES)[number];

/** x-slugbase-rate: the bucket of doc 04 section 7, or `none` for probes and machine routes. */
export const RATE_BUCKETS = [
  "login",
  "mfa",
  "register",
  "reset",
  "token_redeem",
  "token_create",
  "setup",
  "go",
  "read",
  "write",
  "bulk",
  "fetch",
  "ai",
  "public",
  "none",
] as const;
export type RateBucket = (typeof RATE_BUCKETS)[number];

/** x-slugbase-scope: the API-token scope an operation needs. An operation without one is not token-callable. */
export const TOKEN_SCOPES = ["read", "write"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** audience: operations outside the browser session model (doc 01 section 4 step 5). */
export const AUDIENCES = ["machine", "marketing-form"] as const;
export type Audience = (typeof AUDIENCES)[number];

export type ProblemResponseStatus = 400 | 401 | 403 | 404 | 409 | 410 | 412 | 413 | 415 | 422 | 429;
export type OtherResponseStatus = 200 | 201 | 202 | 204 | 302 | 500 | 502 | 503;

/** A documented response header. Headers are always sent, so the generator marks them required. */
export interface ResponseHeader {
  readonly description: string;
  readonly schema: z.ZodType;
}

export type ResponseHeaders = Readonly<Record<string, ResponseHeader>>;

/** The schema and the headers stay in the type, so a handler is typed from what its operation declares. */
export interface JsonResponse<S extends z.ZodType = z.ZodType, H extends ResponseHeaders = ResponseHeaders> {
  readonly kind: "json";
  readonly description: string;
  readonly schema: S;
  readonly headers?: H;
}

export interface JsonResponseOptions<H extends ResponseHeaders = ResponseHeaders> {
  readonly headers?: H;
}

export interface ProblemResponse {
  readonly kind: "problem";
  readonly description: string;
  readonly headers?: ResponseHeaders;
}

/** The name of the header a `429` carries, so the generator and the checks spell it once. */
export const RETRY_AFTER_HEADER = "Retry-After";

/**
 * Retry-After on a rate-limit refusal: whole seconds to wait, at least one because a
 * refusal always has a wait left (doc 04 section 7). The server never sends the HTTP-date form.
 */
export const RetryAfterSchema = z.number().int().min(1);

/** A `429` problem response; it always declares `Retry-After`. */
export interface RateLimitedResponse extends ProblemResponse {
  readonly headers: { readonly [RETRY_AFTER_HEADER]: ResponseHeader } & ResponseHeaders;
}

export interface EmptyResponse {
  readonly kind: "empty";
  readonly description: string;
}

/** A response with a JSON body described by a Zod schema, and optionally the headers it documents. */
export function jsonResponse<S extends z.ZodType, H extends ResponseHeaders = ResponseHeaders>(
  description: string,
  schema: S,
  options: JsonResponseOptions<H> = {},
): JsonResponse<S, H> {
  return options.headers === undefined ? { kind: "json", description, schema } : { kind: "json", description, schema, headers: options.headers };
}

/** An `application/problem+json` response carrying the shared Problem schema. */
export function problemResponse(description: string): ProblemResponse {
  return { kind: "problem", description };
}

/**
 * The `429 rate_limited` problem response (doc 04 section 3.2). Every operation's
 * `429` is built here, so each one declares `Retry-After` in integer seconds and the
 * generated client and mocks carry it (doc 04 section 7).
 */
export function rateLimitedResponse(description: string): RateLimitedResponse {
  return {
    kind: "problem",
    description,
    headers: { [RETRY_AFTER_HEADER]: { description: "Whole seconds to wait before the request can succeed", schema: RetryAfterSchema } },
  };
}

/** A response without a body. */
export function emptyResponse(description: string): EmptyResponse {
  return { kind: "empty", description };
}

export type AtLeastOne<T> = { [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>> }[keyof T];

/**
 * Client-error statuses are problem documents, and at least one must be declared.
 * Other statuses carry any response kind.
 */
export type OperationResponses = { [S in OtherResponseStatus]?: JsonResponse | EmptyResponse | ProblemResponse } & AtLeastOne<{
  [S in ProblemResponseStatus]: S extends 429 ? RateLimitedResponse : ProblemResponse;
}>;

export interface OperationRequest {
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  /** Object bodies must be strict: unknown fields are a 422 (doc 04 section 2.3). */
  readonly body?: z.ZodType;
}

export interface OperationDefinition {
  readonly method: HttpMethod;
  /** The path as served, for example `/health` or `/api/v1/bookmarks/{id}`. */
  readonly path: string;
  readonly operationId: string;
  readonly tag: string;
  readonly summary?: string;
  readonly auth: AuthPolicy;
  readonly rate: RateBucket;
  readonly scope?: TokenScope;
  readonly entitlement?: string;
  /**
   * The operation needs a session re-authenticated within the last 10 minutes
   * and is refused to an API token (doc 04 section 4.4, doc 10 T18). Published as
   * x-slugbase-reauth when `true`; an absent or `false` declaration is the same.
   */
  readonly reauth?: boolean;
  readonly audience?: Audience;
  readonly request?: OperationRequest;
  /**
   * The largest request body the body-limits stage accepts, in bytes. Absent,
   * the stage's default applies (doc 01 section 4 step 3). Server-side policy:
   * it is not part of the generated OpenAPI document.
   */
  readonly maxBodyBytes?: number;
  readonly responses: OperationResponses;
}

/**
 * Declares an operation together with its policy. The authorization, rate-limit
 * and token-scope stages read the policy fields from the generated document
 * (doc 04 section 1.2); leaving one out is a compile error.
 */
export function defineOperation<const D extends OperationDefinition>(definition: D): D {
  return definition;
}
