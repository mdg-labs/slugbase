import {
  AUDIENCES,
  AUTH_POLICIES,
  HTTP_METHODS,
  RATE_BUCKETS,
  TOKEN_SCOPES,
  type EmptyResponse,
  type JsonResponse,
  type OperationDefinition,
} from "@slugbase/contracts";
import type { z } from "zod";
import type { ChainContext, RouteBinding } from "../http/chain.ts";

// The registration path of doc 04 section 1.1: a route exists only as an
// operation declared in `@slugbase/contracts` plus a handler. `route` builds the
// binding from the two, with the handler typed from the operation's schemas.
// `checkRegistrations` is what `createServer` runs over every binding, the
// modules' included, before anything listens (doc 10, T3): an operation without
// a policy, absent from the committed document, registered with a policy that
// differs from the document's, or registered twice is refused by operation ID.

/** One part of the request, present when the operation declares its schema. */
export type RequestPart<Op extends OperationDefinition, K extends "params" | "query" | "body"> = Op["request"] extends {
  readonly [P in K]: infer S extends z.ZodType;
}
  ? { readonly [P in K]: z.output<S> }
  : unknown;

/** What a handler receives: the path, query and body the operation declares, as its schemas parsed them. */
export type RouteRequest<Op extends OperationDefinition> = RequestPart<Op, "params"> & RequestPart<Op, "query"> & RequestPart<Op, "body">;

/** The headers a response must carry: those its operation documents. */
export type ResponseHeadersOf<H> = keyof H extends never
  ? { readonly headers?: Readonly<Record<string, string>> }
  : string extends keyof H
    ? { readonly headers?: Readonly<Record<string, string>> }
    : { readonly headers: { readonly [K in keyof H & string]: string } };

/** The responses a handler may answer with, from the response map of an operation. */
export type ResponseResult<R> = {
  [S in keyof R & number]: R[S] extends JsonResponse<infer Schema, infer H>
    ? { readonly status: S; readonly body: z.input<Schema> } & ResponseHeadersOf<H>
    : R[S] extends EmptyResponse
      ? { readonly status: S; readonly body?: never; readonly headers?: Readonly<Record<string, string>> }
      : never;
}[keyof R & number];

/**
 * What a handler answers with: one of the JSON or empty responses its operation
 * declares, the body typed by that response's schema. A problem is not returned
 * but thrown as a `ProblemError`.
 */
export type RouteResult<Op extends OperationDefinition> = ResponseResult<Op["responses"]>;

export type RouteImplementation<Op extends OperationDefinition> = (
  request: RouteRequest<Op>,
  context: ChainContext,
) => RouteResult<Op> | Promise<RouteResult<Op>>;

export type RouteOptions = Pick<RouteBinding, "acceptsMultipart" | "marketingOrigin">;

interface UntypedResult {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

function respond(operation: OperationDefinition, result: UntypedResult): Response {
  const responses: Readonly<Partial<Record<number, JsonResponse | EmptyResponse | { readonly kind: "problem" }>>> = operation.responses;
  const declared = responses[result.status];
  if (declared?.kind !== "json" && declared?.kind !== "empty") {
    throw new Error(`${operation.operationId} answered ${String(result.status)}, which it does not declare as a body or empty response`);
  }
  const headers = new Headers(result.headers);
  if (declared.kind === "json") {
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(result.body), { status: result.status, headers });
  }
  return new Response(null, { status: result.status, headers });
}

/** The second half of `route`: the handler of an operation already fixed by the first. */
export interface RouteHandle<Op extends OperationDefinition> {
  handle(implementation: RouteImplementation<Op>, options?: RouteOptions): RouteBinding;
}

/**
 * Turns a contract operation and its handler into the route a module
 * contributes: `route(createBookmark).handle((request) => ...)`. The handler
 * receives the request the validation stage parsed and returns what the
 * operation declares; the answer is then checked again against the declared
 * schema by the response stage. The operation is fixed before the handler is
 * written, so the compiler types the handler's literals from the schemas.
 */
export function route<Op extends OperationDefinition>(operation: Op): RouteHandle<Op> {
  return {
    handle: (implementation, options = {}) => ({
      operation,
      handler: async (context) => {
        const input = context.get("input");
        if (input === undefined) {
          throw new Error(`${operation.operationId} was reached without a validated request`);
        }
        const result = (await implementation(input as RouteRequest<Op>, context)) as UntypedResult;
        return respond(operation, result);
      },
      ...(options.acceptsMultipart === undefined ? {} : { acceptsMultipart: options.acceptsMultipart }),
      ...(options.marketingOrigin === undefined ? {} : { marketingOrigin: options.marketingOrigin }),
    }),
  };
}

/**
 * The part of an OpenAPI 3.1 document the server reads: the operations by path
 * and method, each with the `x-slugbase-*` extensions that carry its policy.
 */
export interface ContractDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export type RegistrationProblemCode = "missing_policy" | "undocumented_operation" | "policy_mismatch";

export interface RegistrationProblem {
  readonly code: RegistrationProblemCode;
  readonly operationId: string;
  readonly message: string;
}

interface DocumentedOperation {
  readonly path: string;
  readonly method: string;
  readonly entry: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indexOperations(document: ContractDocument): ReadonlyMap<string, DocumentedOperation> {
  const operations = new Map<string, DocumentedOperation>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const entry = isRecord(item) ? item[method] : undefined;
      if (isRecord(entry) && typeof entry["operationId"] === "string") {
        operations.set(entry["operationId"], { path, method, entry });
      }
    }
  }
  return operations;
}

function includes(list: readonly string[], value: unknown): boolean {
  return typeof value === "string" && list.includes(value);
}

/** The policy fields an operation must declare, and the first one that is absent or outside its vocabulary. */
function missingPolicy(operation: OperationDefinition): string | undefined {
  if (!includes(AUTH_POLICIES, operation.auth)) {
    return "auth (x-slugbase-auth)";
  }
  if (!includes(RATE_BUCKETS, operation.rate)) {
    return "rate (x-slugbase-rate)";
  }
  if (operation.scope !== undefined && !includes(TOKEN_SCOPES, operation.scope)) {
    return "scope (x-slugbase-scope)";
  }
  if (operation.audience !== undefined && !includes(AUDIENCES, operation.audience)) {
    return "audience";
  }
  if (operation.reauth !== undefined && typeof operation.reauth !== "boolean") {
    return "reauth";
  }
  if (operation.idempotency !== undefined && typeof operation.idempotency !== "boolean") {
    return "idempotency";
  }
  return undefined;
}

/**
 * Why an operation's declared re-authentication contradicts the rest of its policy, or
 * `undefined`. Re-authentication is a property of a fully authenticated session (doc 04
 * section 4.4, doc 10 T18): an operation that declares it cannot also be open to an
 * anonymous caller, a machine, a session whose second factor is pending or an API token.
 */
function inconsistency(operation: OperationDefinition): string | undefined {
  if (operation.idempotency === true && (operation.auth === "anonymous" || operation.auth === "machine")) {
    return `idempotency cannot be declared on a ${operation.auth} operation, which has no account to keep a key for`;
  }
  if (operation.reauth !== true) {
    return undefined;
  }
  if (operation.auth === "anonymous" || operation.auth === "machine" || operation.auth === "partial") {
    return `reauth cannot be declared on a ${operation.auth} operation`;
  }
  if (operation.scope !== undefined) {
    return "an operation that needs re-authentication cannot be callable with an API token, so it declares no scope";
  }
  if (operation.audience !== undefined) {
    return "an operation outside the browser session model cannot need re-authentication";
  }
  return undefined;
}

// Each declared field, and the extension of the document that carries it. `reauth`
// is a flag: the document writes it only when true, so absent and false agree.
const POLICY_FIELDS = [
  ["auth", "x-slugbase-auth"],
  ["rate", "x-slugbase-rate"],
  ["scope", "x-slugbase-scope"],
  ["entitlement", "x-slugbase-entitlement"],
  ["audience", "x-slugbase-audience"],
] as const;

const REAUTH_EXTENSION = "x-slugbase-reauth";
const IDEMPOTENCY_EXTENSION = "x-slugbase-idempotency";

function problemOf(operation: OperationDefinition, documented: ReadonlyMap<string, DocumentedOperation>): RegistrationProblem | undefined {
  // A binding can come from JavaScript, so the ID is checked before it names anything.
  const operationId: unknown = operation.operationId;
  if (typeof operationId !== "string" || operationId === "") {
    return { code: "undocumented_operation", operationId: "", message: "a route is registered for an operation without an operationId" };
  }
  const refuse = (code: RegistrationProblemCode, message: string): RegistrationProblem => ({
    code,
    operationId,
    message: `${operationId}: ${message}`,
  });
  const missing = missingPolicy(operation);
  if (missing !== undefined) {
    return refuse("missing_policy", `the operation declares no valid ${missing}; every route needs the policy of its contract`);
  }
  const inconsistent = inconsistency(operation);
  if (inconsistent !== undefined) {
    return refuse("missing_policy", `the policy contradicts itself: ${inconsistent}`);
  }
  const entry = documented.get(operationId);
  if (entry === undefined) {
    return refuse("undocumented_operation", "the operation is not in the committed OpenAPI document; run pnpm api:gen after declaring it");
  }
  if (entry.path !== operation.path || entry.method !== operation.method) {
    return refuse(
      "policy_mismatch",
      `the route is ${operation.method.toUpperCase()} ${operation.path} but the document declares ${entry.method.toUpperCase()} ${entry.path}`,
    );
  }
  for (const [field, extension] of POLICY_FIELDS) {
    if (operation[field] !== entry.entry[extension]) {
      return refuse("policy_mismatch", `${field} differs from the document's ${extension}; a route takes its policy from the contract`);
    }
  }
  if ((operation.reauth === true) !== (entry.entry[REAUTH_EXTENSION] === true)) {
    return refuse("policy_mismatch", `reauth differs from the document's ${REAUTH_EXTENSION}; a route takes its policy from the contract`);
  }
  if ((operation.idempotency === true) !== (entry.entry[IDEMPOTENCY_EXTENSION] === true)) {
    return refuse("policy_mismatch", `idempotency differs from the document's ${IDEMPOTENCY_EXTENSION}; a route takes its policy from the contract`);
  }
  return undefined;
}

/**
 * The first reason a binding cannot be registered, or `undefined` when every
 * operation has its policy and matches the document. Fails closed: a binding is
 * checked against the document by its operation ID and its whole policy, not by
 * the operation object it carries.
 */
export function checkRegistrations(bindings: readonly RouteBinding[], document: ContractDocument): RegistrationProblem | undefined {
  const documented = indexOperations(document);
  for (const binding of bindings) {
    const problem = problemOf(binding.operation, documented);
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
}
