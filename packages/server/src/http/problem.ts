import { randomUUID } from "node:crypto";
import {
  ProblemSchema,
  problemStatus,
  type BinaryResponse,
  type EmptyResponse,
  type JsonResponse,
  type Problem,
  type ProblemCode,
  type ProblemResponse,
} from "@slugbase/contracts";
import { PortUnavailable, type ErrorReportPort } from "@slugbase/core";
import { z } from "zod";
import type { Logger } from "../create-server.ts";
import type { ChainContext, ResponseStage } from "./chain.ts";

// Stage 11 of the chain (doc 01 section 4): every error becomes an RFC 9457
// problem document (doc 04 section 3), and every response is checked against
// the schema its operation declares. A body never carries a stack trace, SQL
// text, a connection string or an internal identifier (doc 10, T7): a document
// is built only from the code catalog and from text its author wrote for the
// caller, never from the message of an arbitrary error.

const PROBLEM_TYPE_BASE = "https://slugbase.app/problems/";
const PROBLEM_CONTENT_TYPE = "application/problem+json";
const REQUEST_ID_HEADER = "x-request-id";

/** Static English title per code (doc 04 section 3.1); a code added to the catalog needs an entry. */
const PROBLEM_TITLES: Record<ProblemCode, string> = {
  bad_request: "Bad request",
  unauthenticated: "Authentication required",
  mfa_required: "Second factor required",
  reauth_required: "Re-authentication required",
  forbidden: "Forbidden",
  registration_refused: "Registration refused",
  cross_site_request: "Cross-site request refused",
  token_scope: "Token scope insufficient",
  entitlement_required: "Plan does not include this feature",
  email_unverified: "Email address not verified",
  registration_closed: "Registration closed",
  setup_completed: "Setup already completed",
  not_found: "Not found",
  slug_not_found: "Slug not found",
  slug_taken: "Slug already in use",
  name_taken: "Name already in use",
  email_taken: "Email address already in use",
  already_member: "Already a member",
  last_owner: "Last owner",
  workspace_has_owner: "Workspace has an owner",
  idempotency_conflict: "Idempotency key conflict",
  billing_active: "Billing is active",
  token_expired: "Token unknown or expired",
  precondition_failed: "Precondition failed",
  payload_too_large: "Payload too large",
  unsupported_media_type: "Unsupported media type",
  validation_failed: "Validation failed",
  bookmark_limit_reached: "Bookmark limit reached",
  seat_limit_reached: "Seat limit reached",
  workspace_limit_reached: "Workspace limit reached",
  weak_password: "Password too weak",
  invalid_code: "Invalid code",
  url_not_allowed: "URL not allowed",
  rate_limited: "Too many requests",
  internal: "Internal error",
  upstream_failed: "Upstream service failed",
  unavailable: "Service unavailable",
  mail_unavailable: "Email delivery unavailable",
  ai_unavailable: "AI suggestions unavailable",
  billing_unavailable: "Billing unavailable",
};

/** The `detail` of the problems the mapper itself raises; everything else carries its author's text. */
const MAPPED_DETAILS = {
  not_found: "No such resource.",
  internal: "The request could not be completed.",
  validation_failed: "The request did not pass validation.",
  unavailable: "The service is temporarily unavailable.",
  mail_unavailable: "Email delivery is not available on this instance.",
  ai_unavailable: "AI suggestions are not available on this instance.",
  billing_unavailable: "Billing is not available on this instance.",
} as const satisfies Partial<Record<ProblemCode, string>>;

/** The `detail` of a `validation_failed` problem; the fields are in `errors[]`. */
export const VALIDATION_FAILED_DETAIL = MAPPED_DETAILS.validation_failed;

export type ProblemFieldError = NonNullable<Problem["errors"]>[number];

export interface ProblemErrorOptions {
  /** Per-field errors for `validation_failed` and per-field domain errors. */
  readonly errors?: readonly ProblemFieldError[];
  /** Members of the code beside the standard ones, JSON values the author wrote for the caller, such as the workspaces that block a `last_owner`; they never replace a standard member. */
  readonly members?: Readonly<Record<string, unknown>>;
}

/**
 * A failure a handler or service reports to the caller on purpose. `detail` is
 * written for the caller (English, doc 02 section 15) and may name values the
 * caller sent; it is sent as given, so it never holds anything else.
 */
export class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly detail: string;
  readonly errors: readonly ProblemFieldError[] | undefined;
  readonly members: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ProblemCode, detail: string, options: ProblemErrorOptions = {}) {
    super(detail);
    this.name = "ProblemError";
    this.code = code;
    this.detail = detail;
    this.errors = options.errors;
    this.members = options.members;
  }
}

/** What an error answers with. */
export interface MappedProblem {
  readonly code: ProblemCode;
  readonly detail: string;
  readonly errors?: readonly ProblemFieldError[];
  readonly members?: Readonly<Record<string, unknown>>;
  /** True for a `500`: it is logged and reported through the error port. */
  readonly unexpected: boolean;
}

function mapped(code: ProblemCode, detail: string, errors?: readonly ProblemFieldError[], members?: Readonly<Record<string, unknown>>): MappedProblem {
  return {
    code,
    detail,
    ...(errors === undefined ? {} : { errors }),
    ...(members === undefined ? {} : { members }),
    unexpected: problemStatus(code) === 500,
  };
}

function fieldPath(path: readonly PropertyKey[]): string {
  return path.map((segment) => String(segment)).join(".");
}

/** The `errors[]` of a failed parse: where each issue is and its code, never the value that failed. */
export function fieldErrors(error: z.core.$ZodError): ProblemFieldError[] {
  return error.issues.flatMap((issue): ProblemFieldError[] => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({ path: fieldPath([...issue.path, key]), code: issue.code }));
    }
    return [{ path: fieldPath(issue.path), code: issue.code }];
  });
}

/** The problem an error answers with: validation, a deliberate failure, an unavailable port, or a `500`. */
export function mapError(error: unknown): MappedProblem {
  if (error instanceof ProblemError) {
    return mapped(error.code, error.detail, error.errors, error.members);
  }
  if (error instanceof z.core.$ZodError) {
    return mapped("validation_failed", VALIDATION_FAILED_DETAIL, fieldErrors(error));
  }
  if (error instanceof PortUnavailable) {
    const code = error.code;
    return mapped(code, MAPPED_DETAILS[code]);
  }
  return mapped("internal", MAPPED_DETAILS.internal);
}

/** The request ID of the request: the one the request-context stage set, else a fresh one that the problem and its header then share. */
export function requestIdOf(context: ChainContext): string {
  const existing = context.get("requestId");
  if (existing !== undefined) {
    return existing;
  }
  const generated = randomUUID();
  context.set("requestId", generated);
  return generated;
}

/** Builds the `application/problem+json` response for a mapped problem. */
export function problemDocument(requestId: string, problem: Pick<MappedProblem, "code" | "detail" | "errors" | "members">): Response {
  const status = problemStatus(problem.code);
  const body: Problem = {
    ...problem.members,
    type: `${PROBLEM_TYPE_BASE}${problem.code}`,
    title: PROBLEM_TITLES[problem.code],
    status,
    code: problem.code,
    detail: problem.detail,
    requestId,
    ...(problem.errors === undefined ? {} : { errors: [...problem.errors] }),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": PROBLEM_CONTENT_TYPE, [REQUEST_ID_HEADER]: requestId },
  });
}

/** The answer to a request that matches no operation. */
export function notFoundProblem(context: ChainContext): Response {
  return problemDocument(requestIdOf(context), { code: "not_found", detail: MAPPED_DETAILS.not_found });
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;

/** The only parts of an error that reach a log line: its class name and a short code, never its message or stack. */
export function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorType: typeof error };
  }
  const code = (error as { code?: unknown }).code;
  return {
    ...(SAFE_IDENTIFIER.test(error.name) ? { errorName: error.name } : {}),
    ...(typeof code === "string" && SAFE_IDENTIFIER.test(code) ? { errorCode: code } : {}),
  };
}

export interface ProblemReporting {
  readonly logger: Logger;
  readonly errors: ErrorReportPort;
}

/**
 * Answers a failed request: logs and reports a `500`, and returns the problem
 * document. The error port is not awaited and its failure never changes the answer.
 */
export function failRequest(context: ChainContext, error: unknown, reporting: ProblemReporting): Response {
  const problem = mapError(error);
  const requestId = requestIdOf(context);
  context.error = error instanceof Error ? error : new Error("a non-error value was thrown");
  if (problem.unexpected) {
    const { logger, errors } = reporting;
    logger.error("Request failed", { ...describeError(error), requestId });
    const operation = context.get("route")?.operation;
    void Promise.resolve()
      .then(() => errors.capture(error, { requestId, ...(operation === undefined ? {} : { route: `${operation.method.toUpperCase()} ${operation.path}` }) }))
      .catch((reportError: unknown) => {
        logger.warn("Error report failed", { ...describeError(reportError), requestId });
      });
  }
  return problemDocument(requestId, problem);
}

export interface ResponseIssue {
  readonly path: string;
  readonly code: string;
}

/** A response that does not match what its operation declares; the issues name fields, never values. */
export class ResponseMismatchError extends Error {
  readonly issues: readonly ResponseIssue[];

  constructor(issues: readonly ResponseIssue[]) {
    super("the response does not match its declared schema");
    this.name = "ResponseMismatchError";
    this.issues = issues;
  }
}

/**
 * `throw` is for development and CI: a response that differs from its declared
 * schema in any way, undeclared fields included, is an error. `strip` is for
 * production: undeclared fields are removed and everything else that differs
 * is still an error, so a response is never sent unchecked.
 */
export type ResponseValidation = "throw" | "strip";

type DeclaredResponse = JsonResponse | EmptyResponse | ProblemResponse | BinaryResponse;

function mismatch(path: string, code: string): ResponseMismatchError {
  return new ResponseMismatchError([{ path, code }]);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameJson(a[key], b[key]));
  }
  return a === b;
}

function removeKeys(root: unknown, path: readonly PropertyKey[], keys: readonly string[]): void {
  let target = root;
  for (const segment of path) {
    target = isRecord(target) ? target[segment] : undefined;
  }
  if (isRecord(target) && !Array.isArray(target)) {
    for (const key of keys) {
      Reflect.deleteProperty(target, key);
    }
  }
}

// Removes the keys the schema names as unrecognized, as often as a nested
// object's removal exposes another.
const MAX_STRIP_PASSES = 4;

function stripUndeclared(schema: z.ZodType, body: unknown): z.ZodSafeParseResult<unknown> {
  let result = schema.safeParse(body);
  for (let pass = 0; pass < MAX_STRIP_PASSES && !result.success; pass += 1) {
    const unrecognized = result.error.issues.filter((issue) => issue.code === "unrecognized_keys");
    if (unrecognized.length === 0) {
      break;
    }
    for (const issue of unrecognized) {
      removeKeys(body, issue.path, issue.keys);
    }
    result = schema.safeParse(body);
  }
  return result;
}

function issuesOf(error: z.core.$ZodError): ResponseIssue[] {
  return error.issues.map((issue) => ({ path: fieldPath(issue.path), code: issue.code }));
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw mismatch("", "invalid_json");
  }
}

function checkProblem(text: string, response: Response): void {
  const result = ProblemSchema.safeParse(parseBody(text));
  if (!result.success) {
    throw new ResponseMismatchError(issuesOf(result.error));
  }
  const { code, status, type, requestId } = result.data;
  if (status !== response.status || problemStatus(code) !== status) {
    throw mismatch("status", "wrong_status");
  }
  if (type !== `${PROBLEM_TYPE_BASE}${code}`) {
    throw mismatch("type", "wrong_type");
  }
  if (requestId !== response.headers.get(REQUEST_ID_HEADER)) {
    throw mismatch("requestId", "request_id_mismatch");
  }
}

function checkJson(declared: JsonResponse, text: string, response: Response, validation: ResponseValidation): string {
  if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw mismatch("", "wrong_content_type");
  }
  const body = parseBody(text);
  if (validation === "throw") {
    const result = declared.schema.safeParse(body);
    if (!result.success) {
      throw new ResponseMismatchError(issuesOf(result.error));
    }
    if (!sameJson(result.data, body)) {
      throw mismatch("", "undeclared_fields");
    }
    return text;
  }
  const result = stripUndeclared(declared.schema, body);
  if (!result.success) {
    throw new ResponseMismatchError(issuesOf(result.error));
  }
  return JSON.stringify(result.data);
}

function isProblemContentType(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().startsWith(PROBLEM_CONTENT_TYPE);
}

function declaredResponse(context: ChainContext, status: number): DeclaredResponse | undefined {
  const responses: Readonly<Partial<Record<number, DeclaredResponse>>> | undefined = context.get("route")?.operation.responses;
  return responses?.[status];
}

/**
 * Stage 11: checks the response against the schema its operation declares.
 * A problem document is checked against the shared problem schema whatever
 * the operation declares, since any stage may answer with one. Throws a
 * `ResponseMismatchError`, which the chain answers as `500 internal`.
 */
export function responseStage(validation: ResponseValidation): ResponseStage {
  return async (context) => {
    const response = context.res;
    const route = context.get("route");
    const problem = isProblemContentType(response);
    if (route === undefined && !problem) {
      return;
    }
    const declaredNow = problem ? undefined : declaredResponse(context, response.status);
    if (declaredNow?.kind === "binary") {
      // Bytes are checked as bytes: reading them as text would change them.
      const bytes = new Uint8Array(await response.arrayBuffer());
      if ((response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() !== declaredNow.mediaType) {
        throw mismatch("", "wrong_content_type");
      }
      if (bytes.length === 0) {
        throw mismatch("", "empty_body");
      }
      const kept = new Headers(response.headers);
      context.res = undefined;
      context.res = new Response(bytes, { status: response.status, statusText: response.statusText, headers: kept });
      return;
    }
    const text = await response.text();
    let sent = text;
    if (problem) {
      checkProblem(text, response);
    } else {
      const declared = declaredResponse(context, response.status);
      if (declared === undefined) {
        throw mismatch("status", "undeclared_status");
      }
      if (declared.kind === "json") {
        sent = checkJson(declared, text, response, validation);
      } else if (declared.kind === "empty") {
        if (text !== "") {
          throw mismatch("", "unexpected_body");
        }
      } else {
        throw mismatch("", "wrong_content_type");
      }
    }
    const headers = new Headers(response.headers);
    if (sent !== text) {
      headers.delete("content-length");
    }
    context.res = undefined;
    context.res = new Response(sent === "" ? null : sent, { status: response.status, statusText: response.statusText, headers });
  };
}
