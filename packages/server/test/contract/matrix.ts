import type { ApiCall, ApiResponse, MatrixPrincipal, RequestFunction, TokenRequestFunction, TokenScope } from "@slugbase/testing/tenancy";
import { buildRequest, type ContractFixtures, type Credentials, type RequestParts } from "./walker.ts";

// The request function of the cross-tenant matrix in API mode (doc 08 section
// 3.3): it sends each call of the matrix to an in-process server, so the
// matrix runs over the real middleware chain. The matrix puts the identifiers
// of workspace B at the inputs that carry one and nothing else; the rest of a
// valid request comes from the fixture of the operation.

export interface MatrixRequestOptions {
  readonly send: (request: Request) => Promise<Response>;
  readonly origin: string;
  readonly fixtures: ContractFixtures;
  /** What a principal of the fixture sends. */
  readonly credentialsOf: (principal: MatrixPrincipal) => Credentials;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `overlay` over `base`: objects merge by property and arrays by index; anything else is replaced. */
export function overlay(base: unknown, over: unknown): unknown {
  if (over === undefined) {
    return base;
  }
  if (Array.isArray(over) && Array.isArray(base)) {
    return over.map((item, index) => overlay(base[index], item)).concat(base.slice(over.length));
  }
  if (isRecord(over) && isRecord(base)) {
    return { ...base, ...Object.fromEntries(Object.entries(over).map(([name, value]) => [name, overlay(base[name], value)])) };
  }
  return over;
}

function withQuery(url: string, base: RequestParts["query"]): string {
  const target = new URL(url, "http://localhost");
  for (const [name, value] of Object.entries(base ?? {})) {
    if (!target.searchParams.has(name)) {
      for (const item of typeof value === "string" ? [value] : value) {
        target.searchParams.append(name, item);
      }
    }
  }
  return `${target.pathname}${target.search}`;
}

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function matrixRequest({ send, origin, fixtures, credentialsOf }: MatrixRequestOptions): RequestFunction {
  return async (call: ApiCall): Promise<ApiResponse> => {
    const fixture = Object.hasOwn(fixtures, call.operation.operationId) ? fixtures[call.operation.operationId] : undefined;
    if (fixture === undefined) {
      throw new Error(`no fixture for ${call.operation.operationId}: the matrix cannot complete its request`);
    }
    const base = fixture.foreign ?? fixture;
    const response = await send(
      buildRequest({
        method: call.operation.method,
        url: withQuery(call.url, base.query),
        body: overlay(base.body, call.body),
        credentials: credentialsOf(call.principal),
        origin,
      }),
    );
    return { status: response.status, body: await parse(response) };
  };
}

export interface TokenRequestOptions {
  readonly send: (request: Request) => Promise<Response>;
  readonly origin: string;
  readonly fixtures: ContractFixtures;
  /** What a bearer request of a token of the scope sends. */
  readonly credentialsOf: (scope: TokenScope) => Credentials;
}

/** A path parameter of an operation nobody wrote a fixture for: no row, which the refusal of a token does not look for. */
const UNKNOWN_ID = "0192f3a0-0000-7000-8000-00000000dead";

/**
 * The request function of the token mode: it sends the operation's own fixture
 * as a bearer request (or without a credential), and for an operation with no
 * fixture an empty request with placeholder identifiers, so that an operation
 * added to the contract is called before anyone writes its fixture. A refusal
 * of a token comes before the body and the handler are looked at; an operation
 * a token may call needs its fixture for the request to get past validation.
 */
export function tokenMatrixRequest({ send, origin, fixtures, credentialsOf }: TokenRequestOptions): TokenRequestFunction {
  return async ({ operation, scope }) => {
    const fixture = Object.hasOwn(fixtures, operation.operationId) ? fixtures[operation.operationId] : undefined;
    const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => encodeURIComponent(fixture?.path?.[name] ?? UNKNOWN_ID));
    const response = await send(
      buildRequest({
        method: operation.method,
        url: withQuery(path, fixture?.query),
        body: fixture?.body,
        credentials: scope === undefined ? undefined : credentialsOf(scope),
        origin,
      }),
    );
    return { status: response.status, body: await parse(response) };
  };
}
