import type { EmptyResponse, JsonResponse, OperationDefinition, ProblemResponse, ResponseHeader } from "@slugbase/contracts";
import { z } from "zod";
import type { ChainContext, RequestStage } from "./chain.ts";

// Stage 2 of the chain (doc 01 section 4): the response headers that keep the
// app from being framed, from running injected script and from being cached
// where it must not be (doc 10, T5 and T14). They are set on the answer of every
// stage, whichever produced it, and again on the problem document that replaces
// a response when a stage fails, because that replacement carries none of the
// headers of the response it replaces.

const NO_STORE = "no-store";
const PROBLEM_CONTENT_TYPE = "application/problem+json";
const CORS_HEADER_PREFIX = "access-control-";

// Scripts load from the app's own origin only; no source allows an inline script
// or `eval`, and a page that needs an inline script takes a hash or a nonce
// (doc 01 section 4 step 2). Favicons come from the app's own proxy.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** What every response carries. */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const STRICT_TRANSPORT_SECURITY = "max-age=31536000";

/** Headers a class of paths adds to, or changes in, the base set. */
export interface HeaderRule {
  readonly name: string;
  readonly applies: (path: string) => boolean;
  readonly headers: Readonly<Record<string, string>>;
}

function under(prefix: string): (path: string) => boolean {
  return (path) => path === prefix || path.startsWith(`${prefix}/`);
}

const PROBE_PATHS: ReadonlySet<string> = new Set(["/health", "/ready", "/version"]);

/**
 * The per-path headers, as data: a later rule overrides an earlier one. A route
 * that needs its own headers is a rule here, not code in a handler. A cache
 * policy in a rule is the default; an operation may declare its own.
 */
export const HEADER_RULES: readonly HeaderRule[] = [
  { name: "api", applies: under("/api"), headers: { "cache-control": NO_STORE } },
  { name: "probe", applies: (path) => PROBE_PATHS.has(path), headers: { "cache-control": NO_STORE } },
  { name: "go", applies: under("/go"), headers: { "cache-control": NO_STORE, "referrer-policy": "no-referrer" } },
];

const declaredValues = new WeakMap<z.ZodType, string | undefined>();

// A header schema that is one string literal states the value; any other schema
// does not, and the operation then gets the default rather than a guessed value.
function literalOf(header: ResponseHeader): string | undefined {
  if (declaredValues.has(header.schema)) {
    return declaredValues.get(header.schema);
  }
  let value: string | undefined;
  try {
    const schema = z.toJSONSchema(header.schema, { target: "draft-2020-12", unrepresentable: "any" }) as { const?: unknown };
    value = typeof schema.const === "string" ? schema.const : undefined;
  } catch {
    value = undefined;
  }
  declaredValues.set(header.schema, value);
  return value;
}

/** The `Cache-Control` value the operation declares for the status, if it declares one. */
export function declaredCachePolicy(operation: OperationDefinition, status: number): string | undefined {
  const responses: Readonly<Partial<Record<number, JsonResponse | EmptyResponse | ProblemResponse>>> = operation.responses;
  const declared = responses[status];
  if (declared?.kind !== "json" || declared.headers === undefined) {
    return undefined;
  }
  const entry = Object.entries(declared.headers).find(([name]) => name.toLowerCase() === "cache-control");
  return entry === undefined ? undefined : literalOf(entry[1]);
}

export interface SecurityHeadersOptions {
  /** `APP_ORIGIN`: the scheme decides whether `Strict-Transport-Security` is sent. */
  readonly appOrigin: string;
}

export interface SecurityHeaders {
  /** Stage 2: sets the headers on whatever the later stages answer with. */
  readonly stage: RequestStage;
  /** Sets the headers on `context.res`; safe to run more than once. */
  apply(context: ChainContext): void;
}

export function createSecurityHeaders({ appOrigin }: SecurityHeadersOptions): SecurityHeaders {
  const transport: Readonly<Record<string, string>> =
    new URL(appOrigin).protocol === "https:" ? { "strict-transport-security": STRICT_TRANSPORT_SECURITY } : {};

  const apply = (context: ChainContext): void => {
    const response = context.res;
    const path = new URL(context.req.url).pathname;
    const isProblem = (response.headers.get("content-type") ?? "").toLowerCase().startsWith(PROBLEM_CONTENT_TYPE);

    const headers = new Headers(response.headers);
    for (const name of [...headers.keys()]) {
      if (name.startsWith(CORS_HEADER_PREFIX)) {
        headers.delete(name);
      }
    }

    const wanted: Record<string, string> = { ...BASE_HEADERS, ...transport };
    for (const rule of HEADER_RULES) {
      if (rule.applies(path)) {
        Object.assign(wanted, rule.headers);
      }
    }
    // An error answer is never cached, whatever the operation declares for its other statuses.
    if (isProblem) {
      wanted["cache-control"] = NO_STORE;
    } else {
      const operation = context.get("route")?.operation;
      const declared = operation === undefined ? undefined : declaredCachePolicy(operation, response.status);
      if (declared !== undefined) {
        wanted["cache-control"] = declared;
      }
    }
    for (const [name, value] of Object.entries(wanted)) {
      headers.set(name, value);
    }

    context.res = undefined;
    context.res = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };

  const stage: RequestStage = async (context, next) => {
    await next();
    apply(context);
  };

  return { stage, apply };
}
