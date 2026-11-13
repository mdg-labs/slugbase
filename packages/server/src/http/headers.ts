import type { BinaryResponse, EmptyResponse, JsonResponse, OperationDefinition, ProblemResponse, ResponseHeader } from "@slugbase/contracts";
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

// Scripts load from the app's own origin only, and so do connections (`default-src`);
// no source allows an inline script or `eval`, and a page that needs an inline script
// takes a hash or a nonce (doc 01 section 4 step 2). Styles load from the app's own
// origin too: there is no `style-src`, so no inline `<style>` element and no `style`
// attribute. Favicons come from the app's own proxy. A composition may add `https`
// origins to `script-src` and `connect-src` (`ContentSecurityOptions`) and nothing else.
const SELF = "'self'";

/** The `https` origins a composition adds to the policy; each is a bare origin, as `new URL(entry).origin` writes it. */
export interface ContentSecurityOptions {
  /** Origins script may load from, after `'self'`. */
  readonly scriptSources?: readonly string[];
  /** Origins script may connect to (fetch, XHR, WebSocket, beacons), after `'self'`: a `connect-src` directive is added. */
  readonly connectSources?: readonly string[];
}

// What a CSP host source is made of, once the entry has round-tripped through `URL`:
// the serialiser also leaves `*`, quotes, `;` and `,` in a host, and each would end or extend the directive.
const SOURCE_SHAPE = /^https:\/\/[a-z0-9.:[\]-]+$/;

function sourceProblem(entry: unknown, seen: ReadonlySet<string>): string | undefined {
  if (typeof entry !== "string") {
    return "is not a string";
  }
  let origin: string | undefined;
  try {
    const url = new URL(entry);
    origin = url.protocol === "https:" && url.origin === entry ? entry : undefined;
  } catch {
    origin = undefined;
  }
  if (origin === undefined || !SOURCE_SHAPE.test(origin)) {
    return "is not a bare https origin (scheme, host and optional non-default port, lower case, with no path, query, fragment, userinfo or wildcard)";
  }
  return seen.has(origin) ? "is listed twice" : undefined;
}

/** What is wrong with the options, naming the entry, or `undefined` when they hold only distinct `https` origins. */
export function contentSecurityProblem(options: ContentSecurityOptions): string | undefined {
  for (const name of ["scriptSources", "connectSources"] as const) {
    const list: unknown = options[name];
    if (list === undefined) {
      continue;
    }
    if (!Array.isArray(list)) {
      return `contentSecurity.${name} must be a list of https origins`;
    }
    const seen = new Set<string>();
    for (const entry of list as unknown[]) {
      const problem = sourceProblem(entry, seen);
      if (problem !== undefined) {
        return `contentSecurity.${name} entry ${JSON.stringify(entry)} ${problem}`;
      }
      seen.add(entry as string);
    }
  }
  return undefined;
}

function contentSecurityPolicy(options: ContentSecurityOptions): string {
  const problem = contentSecurityProblem(options);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  const connect = options.connectSources ?? [];
  return [
    "default-src 'self'",
    ["script-src", SELF, ...(options.scriptSources ?? [])].join(" "),
    "img-src 'self' data:",
    ...(connect.length === 0 ? [] : [["connect-src", SELF, ...connect].join(" ")]),
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** What every response carries besides the `Content-Security-Policy`. */
const BASE_HEADERS: Readonly<Record<string, string>> = {
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
  const responses: Readonly<Partial<Record<number, JsonResponse | EmptyResponse | ProblemResponse | BinaryResponse>>> = operation.responses;
  const declared = responses[status];
  if ((declared?.kind !== "json" && declared?.kind !== "binary") || declared.headers === undefined) {
    return undefined;
  }
  const entry = Object.entries(declared.headers).find(([name]) => name.toLowerCase() === "cache-control");
  return entry === undefined ? undefined : literalOf(entry[1]);
}

/**
 * The rules judge the path as the router reads it too: a segment is matched decoded, so `/%67o/slug` reaches the route of `/go/slug`, and a rule that read
 * only the path as sent would leave that answer without the headers of its class.
 */
function appliesTo(rule: HeaderRule, path: string): boolean {
  if (rule.applies(path)) {
    return true;
  }
  try {
    return rule.applies(decodeURIComponent(path));
  } catch {
    return false;
  }
}

export interface SecurityHeadersOptions {
  /** `APP_ORIGIN`: the scheme decides whether `Strict-Transport-Security` is sent. */
  readonly appOrigin: string;
  /** Origins added to the `Content-Security-Policy`; by default none. */
  readonly contentSecurity?: ContentSecurityOptions;
}

export interface SecurityHeaders {
  /** Stage 2: sets the headers on whatever the later stages answer with. */
  readonly stage: RequestStage;
  /** Sets the headers on `context.res`; safe to run more than once. */
  apply(context: ChainContext): void;
}

export function createSecurityHeaders({ appOrigin, contentSecurity = {} }: SecurityHeadersOptions): SecurityHeaders {
  const policy = contentSecurityPolicy(contentSecurity);
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

    const wanted: Record<string, string> = { ...BASE_HEADERS, "content-security-policy": policy, ...transport };
    for (const rule of HEADER_RULES) {
      if (appliesTo(rule, path)) {
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
