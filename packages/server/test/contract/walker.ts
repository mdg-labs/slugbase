import { classifyOperations } from "@slugbase/testing/tenancy";
import { isRecord, nameOf, readOperations, type ContractFailure, type DocumentedOperation } from "./document.ts";
import { componentResolver, validateSchema, type ResolveReference } from "./schema.ts";

// The contract walker (doc 04 section 1.3, doc 10 T3): for every operation of
// the OpenAPI document it makes the calls the document's policy implies and
// checks each answer against what the document declares for it. The calls:
//
//   valid          a request from the operation's fixture, as a principal the
//                  policy admits: the declared success, schema and headers
//   unauthenticated  the same request without a credential: 401 unauthenticated
//                  (any operation but anonymous and machine ones)
//   too-low role   a principal just below the policy: 403 forbidden; below `member`
//                  that is an account with no workspace, which has nothing to name: 404 not_found
//   without re-authentication  an operation that declares `reauth`, called by a session that has
//                  not re-authenticated: 401 reauth_required
//   read-only token  a read-only token on a write-scope operation: 403 token_scope
//   no entitlement an operation that declares an entitlement: 403 entitlement_required
//   workspace B    the identifiers of workspace B, as a principal of workspace A,
//                  on a tenant-scoped operation that takes one: 404 not_found
//
// Every answer must be a status the document declares for the operation, with
// the declared media type, body and headers. A call that cannot be made (no
// fixture, no hook) is a failure, never a skip.

export interface RequestParts {
  /** Path parameter name to its value. */
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: unknown;
}

export interface OperationFixture extends RequestParts {
  /**
   * The status the valid request answers; by default the lowest 2xx the
   * operation declares. An operation that declares an entitlement answers 403
   * in a composition whose entitlement source holds none.
   */
  readonly status?: number;
  /** The request naming the resources of workspace B; needed by a tenant-scoped operation that takes an identifier. */
  readonly foreign?: RequestParts;
  /**
   * What the request naming the resources of workspace B is answered, when it is not `404 not_found`: an operation that looks a slug up answers `404`
   * with its own code (`slug_not_found`), or an empty `200`, for a slug nothing the caller can read has.
   */
  readonly foreignAnswer?: { readonly status: number; readonly code?: string };
}

export type ContractFixtures = Readonly<Record<string, OperationFixture>>;

/** What a principal sends with a request. */
export interface Credentials {
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The stub principals of the scenarios. Each answers for one operation of the
 * document, so that the credential fits its policy.
 */
export interface PolicyHooks {
  /**
   * Holds the role and the scope the operation needs, in workspace A; for an operation that declares `reauth`,
   * also a re-authentication within the window.
   */
  authorized(operation: DocumentedOperation): Credentials;
  /**
   * A session that otherwise satisfies the policy but has no re-authentication, of an account whose other
   * calls do not end it. Asked for only an operation that declares `reauth`.
   */
  withoutReauth(operation: DocumentedOperation): Credentials;
  /**
   * The highest principal still below the policy: refused with 403 forbidden, or with 404 not_found when the
   * policy is `member` and the principal has no workspace. Undefined where none is below it (`account`).
   */
  tooLowRole(operation: DocumentedOperation): Credentials | undefined;
  /** A read-only API token that otherwise satisfies the policy. */
  readOnlyToken(operation: DocumentedOperation): Credentials;
  /** Holds the role of the policy but not the entitlement the operation declares. */
  withoutEntitlement(operation: DocumentedOperation): Credentials;
  /** A principal of workspace A who satisfies the policy, sent against the resources of workspace B. */
  workspaceA(operation: DocumentedOperation): Credentials;
}

export interface WalkerOptions {
  readonly document: unknown;
  /** Serves one request through the server under test. */
  readonly send: (request: Request) => Promise<Response>;
  /** The `APP_ORIGIN` of the server: a mutation must come from it (doc 04 section 5). */
  readonly origin: string;
  readonly fixtures: ContractFixtures;
  readonly hooks: PolicyHooks;
}

export interface WalkerReport {
  /** Operations in the document, walked or not. */
  readonly operations: number;
  /** Requests made. */
  readonly calls: number;
  readonly failures: readonly ContractFailure[];
}

const BASE_URL = "http://localhost";
const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const UNAUTHENTICATED_EXEMPT = new Set(["anonymous", "machine"]);
const MAX_ISSUES_SHOWN = 5;

class FixtureError extends Error {}

function queryString(query: RequestParts["query"]): string {
  const pairs = Object.entries(query ?? {}).flatMap(([name, value]) =>
    (typeof value === "string" ? [value] : value).map((item) => `${encodeURIComponent(name)}=${encodeURIComponent(item)}`),
  );
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

/** The URL of an operation with the path parameters of the parts substituted. */
function urlOf(operation: DocumentedOperation, parts: RequestParts): string {
  const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = parts.path?.[name];
    if (value === undefined) {
      throw new FixtureError(`the fixture gives no value for the path parameter "${name}"`);
    }
    return encodeURIComponent(value);
  });
  return path + queryString(parts.query);
}

export interface RequestInit {
  readonly method: string;
  /** A path with its query. */
  readonly url: string;
  readonly body?: unknown;
  readonly credentials?: Credentials;
  readonly origin: string;
}

/** A request as a browser or a client would make it: a mutation carries its origin and is JSON. */
export function buildRequest({ method, url, body, credentials, origin }: RequestInit): Request {
  const headers = new Headers(credentials?.headers);
  const upper = method.toUpperCase();
  if (MUTATIONS.has(upper)) {
    headers.set("origin", origin);
    headers.set("content-type", "application/json");
  }
  return new Request(new URL(url, BASE_URL), { method: upper, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

interface Expectation {
  readonly status: number;
  /** The `code` of the problem document the answer must be. */
  readonly code?: string;
}

function mediaTypeOf(value: string | null): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function headerValue(schema: unknown, raw: string): unknown {
  const type = isRecord(schema) ? schema["type"] : undefined;
  if (type === "integer" || type === "number") {
    return raw.trim() === "" ? raw : Number(raw);
  }
  if (type === "boolean") {
    return raw === "true" ? true : raw === "false" ? false : raw;
  }
  return raw;
}

function issueText(issues: readonly { path: string; message: string }[]): string {
  const shown = issues.slice(0, MAX_ISSUES_SHOWN).map((issue) => `${issue.path === "" ? "(body)" : issue.path}: ${issue.message}`);
  return issues.length > MAX_ISSUES_SHOWN ? `${shown.join("; ")}; and ${String(issues.length - MAX_ISSUES_SHOWN)} more` : shown.join("; ");
}

/** What of an answer differs from what the operation declares for its status. */
function checkAnswer(
  operation: DocumentedOperation,
  response: Response,
  text: string,
  bytes: Uint8Array,
  resolve: ResolveReference,
): { kind: string; detail: string }[] {
  const found: { kind: string; detail: string }[] = [];
  const responses = isRecord(operation.entry["responses"]) ? operation.entry["responses"] : {};
  const declared = Object.hasOwn(responses, String(response.status)) ? responses[String(response.status)] : undefined;
  if (!isRecord(declared)) {
    found.push({
      kind: "undeclared_status",
      detail: `answered ${String(response.status)}, which the operation does not declare (declared: ${Object.keys(responses).join(", ") || "none"})`,
    });
    return found;
  }

  const content = isRecord(declared["content"]) ? declared["content"] : {};
  const mediaTypes = Object.keys(content);
  if (mediaTypes.length === 0) {
    if (text !== "") {
      found.push({ kind: "unexpected_body", detail: `answered ${String(response.status)} with a body, the document declares none` });
    }
  } else {
    const actual = mediaTypeOf(response.headers.get("content-type"));
    const media = mediaTypes.find((candidate) => candidate.toLowerCase() === actual);
    if (media === undefined) {
      found.push({ kind: "wrong_content_type", detail: `answered ${actual === "" ? "no content type" : actual}, declared ${mediaTypes.join(", ")}` });
    } else if (isRecord(content[media]) && isRecord(content[media]["schema"]) && content[media]["schema"]["type"] === "string" && content[media]["schema"]["format"] === "binary") {
      // Bytes, not JSON: the body must be a PNG when the operation declares image/png, and never empty.
      const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (bytes.length === 0 || (media === "image/png" && !png.every((value, index) => bytes[index] === value))) {
        found.push({ kind: "invalid_binary", detail: `the ${media} body is empty or does not start as the type declares` });
      }
    } else {
      let body: unknown;
      let parsed = true;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        parsed = false;
        found.push({ kind: "invalid_json", detail: `the ${media} body is not JSON` });
      }
      const mediaObject = content[media];
      const schema = isRecord(mediaObject) ? mediaObject["schema"] : undefined;
      if (parsed) {
        const issues = validateSchema(schema, body, resolve);
        if (issues.length > 0) {
          found.push({ kind: "schema_mismatch", detail: `the body does not match the declared schema: ${issueText(issues)}` });
        }
        if (media.endsWith("+json") && isRecord(body) && body["status"] !== response.status) {
          found.push({ kind: "problem_status_mismatch", detail: `the problem document says status ${String(body["status"])}, the response is ${String(response.status)}` });
        }
      }
    }
  }

  const headers = isRecord(declared["headers"]) ? declared["headers"] : {};
  for (const [name, spec] of Object.entries(headers)) {
    const raw = response.headers.get(name);
    if (raw === null) {
      if (isRecord(spec) && spec["required"] === true) {
        found.push({ kind: "missing_header", detail: `the response lacks the required header ${name}` });
      }
      continue;
    }
    const issues = validateSchema(isRecord(spec) ? spec["schema"] : undefined, headerValue(isRecord(spec) ? spec["schema"] : undefined, raw), resolve);
    if (issues.length > 0) {
      found.push({ kind: "header_mismatch", detail: `the header ${name} does not match its declared schema: ${issueText(issues)}` });
    }
  }
  return found;
}

function successStatus(operation: DocumentedOperation): number | undefined {
  const responses = isRecord(operation.entry["responses"]) ? operation.entry["responses"] : {};
  return Object.keys(responses)
    .map(Number)
    .filter((status) => Number.isInteger(status) && status >= 200 && status < 300)
    .sort((a, b) => a - b)[0];
}

export async function walkContract(options: WalkerOptions): Promise<WalkerReport> {
  const { document, send, origin, fixtures, hooks } = options;
  const { operations, failures, documented } = readOperations(document);
  const resolve = componentResolver(document);
  const classified = new Map(classifyOperations(document).operations.map((operation) => [operation.operationId, operation]));
  let calls = 0;

  for (const operation of operations) {
    const subject = nameOf(operation);
    const fail = (kind: string, detail: string, scenario?: string): void => {
      failures.push({ subject: scenario === undefined ? subject : `${subject}, ${scenario}`, kind, detail });
    };

    const exercise = async (scenario: string, credentials: Credentials | undefined, parts: RequestParts, expected: Expectation): Promise<void> => {
      let request: Request;
      try {
        request = buildRequest({ method: operation.method, url: urlOf(operation, parts), body: parts.body, credentials, origin });
      } catch (error) {
        fail("fixture_incomplete", error instanceof Error ? error.message : String(error), scenario);
        return;
      }
      calls += 1;
      let response: Response;
      try {
        response = await send(request);
      } catch (error) {
        fail("request_failed", error instanceof Error ? error.message : String(error), scenario);
        return;
      }
      const received = await response.arrayBuffer();
      const bytes = new Uint8Array(received);
      const text = new TextDecoder().decode(received);
      for (const { kind, detail } of checkAnswer(operation, response, text, bytes, resolve)) {
        fail(kind, detail, scenario);
      }
      if (response.status !== expected.status) {
        fail("unexpected_status", `answered ${String(response.status)}, expected ${String(expected.status)}`, scenario);
      }
      if (expected.code !== undefined) {
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = undefined;
        }
        const code = isRecord(body) ? body["code"] : undefined;
        if (code !== expected.code) {
          fail("wrong_code", `the problem code is ${JSON.stringify(code)}, expected ${expected.code}`, scenario);
        }
      }
    };

    const fixture = Object.hasOwn(fixtures, operation.operationId) ? fixtures[operation.operationId] : undefined;
    if (fixture === undefined) {
      fail("no_fixture", "no fixture for the operation: add one to the fixtures of its operation");
      continue;
    }

    const needsPrincipal = !UNAUTHENTICATED_EXEMPT.has(operation.auth);
    const success = fixture.status ?? successStatus(operation);
    if (success === undefined) {
      fail("no_success_response", "the operation declares no 2xx response and its fixture names no status");
    } else {
      await exercise("valid request", needsPrincipal ? hooks.authorized(operation) : undefined, fixture, { status: success });
    }
    if (!needsPrincipal) {
      continue;
    }

    await exercise("without credentials", undefined, fixture, { status: 401, code: "unauthenticated" });
    if (operation.reauth === true) {
      await exercise("without re-authentication", hooks.withoutReauth(operation), fixture, { status: 401, code: "reauth_required" });
    }

    // `account` and `partial` admit every signed-in session, so no principal is below them.
    if (operation.auth !== "account" && operation.auth !== "partial") {
      const below = hooks.tooLowRole(operation);
      if (below === undefined) {
        fail("hook_missing", `the policy ${operation.auth} has a role below it and the hooks give no principal for it`);
      } else {
        await exercise("too-low role", below, fixture, operation.auth === "member" ? { status: 404, code: "not_found" } : { status: 403, code: "forbidden" });
      }
    }
    if (operation.scope === "write") {
      await exercise("read-only token", hooks.readOnlyToken(operation), fixture, { status: 403, code: "token_scope" });
    }
    if (operation.entitlement !== undefined) {
      await exercise("without the entitlement", hooks.withoutEntitlement(operation), fixture, { status: 403, code: "entitlement_required" });
    }

    const tenant = classified.get(operation.operationId);
    if (tenant?.kind === "tenant-scoped" && (tenant.pathParameters.length > 0 || tenant.inputs.length > 0)) {
      if (fixture.foreign === undefined) {
        fail("no_foreign_fixture", "a tenant-scoped operation that takes an identifier needs the request naming a resource of workspace B (foreign)");
      } else {
        await exercise("resource of workspace B", hooks.workspaceA(operation), fixture.foreign, fixture.foreignAnswer ?? { status: 404, code: "not_found" });
      }
    }
  }
  return { operations: documented, calls, failures };
}
