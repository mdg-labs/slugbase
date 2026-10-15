import type { TokenScope } from "./fixture.js";
import { classifyOperations, describeOperation, type ClassificationSummary, type ClassifiedOperation } from "./openapi.js";
import type { ApiResponse } from "./api-mode.js";
import type { MatrixFailure } from "./report.js";

// Token mode of the matrix (doc 08 section 3.3, doc 04 sections 1.2 and 4.2, doc
// 10 T3 and T18): for every operation of the OpenAPI document, what a bearer
// request of an API token may and may not do. Which operations a token may call
// is read from the document alone, so an operation added to the contract is
// covered without a test edit:
//
//   anonymous, machine   outside the token rules: the answer is the one the same request
//                        gets without a credential
//   no scope, or reauth  never token-callable: 403 forbidden for either scope, before
//                        the body or the handler is looked at
//   write scope          a read token is 403 token_scope
//   any token-callable   a valid token is never answered 401, and a read-write token is
//                        never answered token_scope; what else it gets is the handler's
//
// An operation that is not a read (POST, PUT, PATCH, DELETE) and declares the read
// scope is a failure: a read token would reach it.

const MUTATING_METHODS: readonly string[] = ["post", "put", "patch", "delete"];

/** Whether an API token may call an operation that requires an account or member principal. */
export function isTokenCallable(operation: Pick<ClassifiedOperation, "scope" | "reauth">): boolean {
  return operation.scope !== undefined && !operation.reauth;
}

function outsideTokenRules(operation: ClassifiedOperation): boolean {
  return operation.policy === "anonymous" || operation.policy === "machine";
}

/** One request the token mode makes. */
export interface TokenCall {
  readonly operation: ClassifiedOperation;
  /** The scope of the token sent as a bearer credential; undefined sends no credential at all. */
  readonly scope: TokenScope | undefined;
}

/**
 * Sends a call. A request function gives the operation a valid request where it
 * has one (the walker's fixtures) and an empty or placeholder one otherwise,
 * so that an operation nobody wrote a fixture for is still called.
 */
export type TokenRequestFunction = (call: TokenCall) => Promise<ApiResponse>;

export interface TokenMatrixOptions {
  /** The OpenAPI document, parsed. */
  readonly document: unknown;
  readonly request: TokenRequestFunction;
}

export interface TokenMatrixReport {
  readonly classified: ClassificationSummary;
  /** Requests made. */
  readonly attempts: number;
  /** Operations a token may never call (account, member and instance policies without a usable scope). */
  readonly refused: number;
  /** Token-callable operations that declare the write scope. */
  readonly scoped: number;
  /** Token-callable operations that declare the read scope. */
  readonly readable: number;
  /** Operations outside the token rules. */
  readonly unaffected: number;
  readonly failures: readonly MatrixFailure[];
}

const SCOPES: readonly TokenScope[] = ["read", "read-write"];

function failure(subject: string, kind: string, detail: string): MatrixFailure {
  return { mode: "token", subject, kind, detail };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("code" in body)) {
    return undefined;
  }
  return typeof body.code === "string" ? body.code : undefined;
}

function answerOf(response: ApiResponse): string {
  const code = codeOf(response.body);
  return code === undefined ? String(response.status) : `${String(response.status)} ${code}`;
}

export async function runTokenMatrix(options: TokenMatrixOptions): Promise<TokenMatrixReport> {
  const classification = classifyOperations(options.document);
  const failures: MatrixFailure[] = classification.problems.map((problem) =>
    failure(problem.subject, "unclassified_operation", problem.detail),
  );
  let attempts = 0;
  let refused = 0;
  let scoped = 0;
  let readable = 0;
  let unaffected = 0;

  for (const operation of classification.operations) {
    const subject = describeOperation(operation);
    const send = async (scope: TokenScope | undefined): Promise<ApiResponse | undefined> => {
      attempts += 1;
      try {
        return await options.request({ operation, scope });
      } catch (error) {
        failures.push(failure(subject, "request_failed", `${scope === undefined ? "without a token" : `with a ${scope} token`}: ${messageOf(error)}`));
        return undefined;
      }
    };

    if (outsideTokenRules(operation)) {
      unaffected += 1;
      const bare = await send(undefined);
      for (const scope of SCOPES) {
        const response = await send(scope);
        if (bare !== undefined && response !== undefined && answerOf(response) !== answerOf(bare)) {
          failures.push(
            failure(
              subject,
              "token_changed_answer",
              `with a ${scope} token it answered ${answerOf(response)}; without a credential ${answerOf(bare)} (the ${operation.policy} policy is outside the token rules)`,
            ),
          );
        }
      }
      continue;
    }

    if (!isTokenCallable(operation)) {
      refused += 1;
      for (const scope of SCOPES) {
        const response = await send(scope);
        if (response !== undefined && !(response.status === 403 && codeOf(response.body) === "forbidden")) {
          failures.push(
            failure(
              subject,
              "token_not_refused",
              `with a ${scope} token it answered ${answerOf(response)}, expected 403 forbidden (it declares ${operation.reauth ? "reauth" : "no scope"}, so no token may call it)`,
            ),
          );
        }
      }
      continue;
    }

    if (operation.scope === "write") {
      scoped += 1;
    } else {
      readable += 1;
      if (MUTATING_METHODS.includes(operation.method)) {
        failures.push(
          failure(subject, "mutation_declared_read", `${operation.method.toUpperCase()} declares the read scope, so a read token may mutate with it`),
        );
      }
    }
    for (const scope of SCOPES) {
      const response = await send(scope);
      if (response === undefined) {
        continue;
      }
      const mustRefuse = operation.scope === "write" && scope === "read";
      if (mustRefuse && !(response.status === 403 && codeOf(response.body) === "token_scope")) {
        failures.push(
          failure(subject, "scope_not_enforced", `with a read token it answered ${answerOf(response)}, expected 403 token_scope (it declares the write scope)`),
        );
      } else if (!mustRefuse && (response.status === 401 || codeOf(response.body) === "token_scope")) {
        failures.push(
          failure(subject, "token_refused", `with a ${scope} token it answered ${answerOf(response)}, but the token is valid and its scope suffices`),
        );
      }
    }
  }

  return { classified: classification.summary, attempts, refused, scoped, readable, unaffected, failures };
}
