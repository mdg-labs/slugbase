import { AUDIENCES, AUTH_POLICIES, HTTP_METHODS, RATE_BUCKETS, TOKEN_SCOPES } from "@slugbase/contracts";

// The operations of an OpenAPI document as the contract walker reads them: each
// with the policy extensions of doc 04 section 1.2. An operation that does not
// declare a policy the vocabulary knows is a failure (T3), never skipped.

export interface ContractFailure {
  /** The operation, with the scenario it was called in when the failure belongs to one. */
  readonly subject: string;
  readonly kind: string;
  readonly detail: string;
}

export interface DocumentedOperation {
  readonly operationId: string;
  readonly method: string;
  /** The path template. */
  readonly path: string;
  readonly auth: string;
  readonly scope?: string;
  readonly entitlement?: string;
  /** Present, and true, when the operation declares that it needs re-authentication. */
  readonly reauth?: true;
  /** The operation object of the document. */
  readonly entry: Readonly<Record<string, unknown>>;
}

const OPENAPI_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nameOf(operation: Pick<DocumentedOperation, "operationId" | "method" | "path">): string {
  return `${operation.operationId} (${operation.method.toUpperCase()} ${operation.path})`;
}

function includes(list: readonly string[], value: unknown): value is string {
  return typeof value === "string" && list.includes(value);
}

/** The operations of a document, and a failure for each one that cannot be walked. */
export function readOperations(document: unknown): { operations: DocumentedOperation[]; failures: ContractFailure[]; documented: number } {
  const operations: DocumentedOperation[] = [];
  const failures: ContractFailure[] = [];
  let documented = 0;
  const paths = isRecord(document) ? document["paths"] : undefined;
  if (!isRecord(paths) || Object.keys(paths).length === 0) {
    return { operations, failures: [{ subject: "document", kind: "no_operations", detail: "the document declares no paths" }], documented };
  }
  for (const [path, item] of Object.entries(paths)) {
    for (const method of isRecord(item) ? Object.keys(item).filter((key) => OPENAPI_METHODS.includes(key)) : []) {
      documented += 1;
      const entry = isRecord(item) ? item[method] : undefined;
      const subject = `${method.toUpperCase()} ${path}`;
      const fail = (kind: string, detail: string): void => {
        failures.push({ subject, kind, detail });
      };
      if (!isRecord(entry) || typeof entry["operationId"] !== "string" || entry["operationId"] === "") {
        fail("policy_missing", "the operation has no operationId");
        continue;
      }
      if (!(HTTP_METHODS as readonly string[]).includes(method)) {
        fail("unsupported_method", `${method.toUpperCase()} is not a method the contract declares`);
        continue;
      }
      const policy = {
        auth: entry["x-slugbase-auth"],
        rate: entry["x-slugbase-rate"],
        scope: entry["x-slugbase-scope"],
        entitlement: entry["x-slugbase-entitlement"],
        audience: entry["x-slugbase-audience"],
        reauth: entry["x-slugbase-reauth"],
      };
      const problems = [
        includes(AUTH_POLICIES, policy.auth) ? undefined : `x-slugbase-auth is absent or not one of ${AUTH_POLICIES.join(", ")}`,
        includes(RATE_BUCKETS, policy.rate) ? undefined : "x-slugbase-rate is absent or not a bucket of doc 04 section 7",
        policy.scope === undefined || includes(TOKEN_SCOPES, policy.scope) ? undefined : "x-slugbase-scope is not read or write",
        policy.entitlement === undefined || (typeof policy.entitlement === "string" && policy.entitlement !== "")
          ? undefined
          : "x-slugbase-entitlement is not a non-empty string",
        policy.audience === undefined || includes(AUDIENCES, policy.audience) ? undefined : "x-slugbase-audience is not a known audience",
        policy.reauth === undefined || typeof policy.reauth === "boolean" ? undefined : "x-slugbase-reauth is not a boolean",
      ].filter((problem) => problem !== undefined);
      if (problems.length > 0 || !includes(AUTH_POLICIES, policy.auth)) {
        failures.push({ subject: `${entry["operationId"]} (${subject})`, kind: "policy_missing", detail: problems.join("; ") });
        continue;
      }
      operations.push({
        operationId: entry["operationId"],
        method,
        path,
        auth: policy.auth,
        ...(typeof policy.scope === "string" ? { scope: policy.scope } : {}),
        ...(typeof policy.entitlement === "string" ? { entitlement: policy.entitlement } : {}),
        ...(policy.reauth === true ? { reauth: true as const } : {}),
        entry,
      });
    }
  }
  return { operations, failures, documented };
}
