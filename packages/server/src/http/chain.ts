import type { OperationDefinition } from "@slugbase/contracts";
import type { ChallengePort, ErrorReportPort, RateLimitPort, TenantResolver } from "@slugbase/core";
import type { Database } from "@slugbase/db";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { RateLimitRegistry } from "../config/index.ts";
import type { Logger } from "../create-server.ts";
import type { HookDispatcher } from "../hooks/index.ts";
import type { Metrics } from "../metrics/index.ts";
import { createAuthentication, type Authenticator, type Principal } from "./authenticate.ts";
import { createAuthorization, type EntitlementCheck, type EntitlementUpgradeCheck, type SecondFactorCheck } from "./authorize.ts";
import { bodyLimits } from "./body-limits.ts";
import { createCrossSiteProtection } from "./cross-site.ts";
import { createSecurityHeaders } from "./headers.ts";
import { createIdempotency } from "./idempotency.ts";
import { failRequest, notFoundProblem, responseStage, type ResponseValidation } from "./problem.ts";
import { createRateLimiting, type RateLimitState, type TakeEmailLimit } from "./rate-limit.ts";
import { createRequestContext } from "./request-context.ts";
import { createTenantResolution, type RequestTenant } from "./tenant.ts";
import { validation } from "./validation.ts";

// The middleware chain of doc 01 section 4. The order is part of the security
// model (doc 10 section 3): it is fixed here, one stage at a time, and neither a
// module nor the composition root can reorder or remove a stage. A stage whose
// item is not merged yet is installed under its name as a pass-through, so the
// order is already enforced when its implementation lands.
//
// The request stages run in order and may answer on their own by returning a
// response. The handler runs the route a module registered for the operation.
// The response stages then see the final response, whichever stage produced it.

export const REQUEST_STAGES = [
  "request-context",
  "security-headers",
  "body-limits",
  "ip-rate-limiting",
  "authentication",
  "cross-site-protection",
  "rate-limiting",
  "tenant-resolution",
  "validation",
  "authorization",
  "idempotency",
] as const;

export const RESPONSE_STAGES = ["response", "audit-telemetry"] as const;

/** The stages of doc 01 section 4 in their documented order; the handler is stage 10. */
export const CHAIN_STAGES = [...REQUEST_STAGES, "handler", ...RESPONSE_STAGES] as const;

export type RequestStageName = (typeof REQUEST_STAGES)[number];
export type ResponseStageName = (typeof RESPONSE_STAGES)[number];
export type StageName = (typeof CHAIN_STAGES)[number];

export interface MatchedRoute {
  readonly operation: OperationDefinition;
  readonly handler: RouteHandler;
  /** Path parameters, decoded. */
  readonly params: Readonly<Record<string, string>>;
  /** From the binding: a `multipart/form-data` body is accepted by the cross-site stage. */
  readonly acceptsMultipart?: boolean;
  /** From the binding: the one origin a `marketing-form` route accepts. */
  readonly marketingOrigin?: string;
}

/**
 * What the validation stage parsed with the operation's schemas. A part the
 * operation does not declare is absent; a handler receives these values, never
 * the raw ones.
 */
export interface ValidatedInput {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
}

/** The variables the stages share through the request context. */
export interface ChainEnv {
  Variables: {
    /** Set by the request-context stage: the caller's `X-Request-Id` when it is safe, else generated. */
    requestId?: string;
    /** Set by the request-context stage: the client address across the trusted proxy hops; undefined without a socket. */
    clientIp?: string;
    /** Set by the request-context stage: the request's logger, every line carrying the request ID. */
    logger?: Logger;
    /** Set by the authentication stage; the request log reads `anonymous` while it is unset. */
    principalType?: "anonymous" | "session" | "api-token";
    /** Set by the authentication stage when an authenticator accepted the request's credential; absent for an anonymous request. */
    principal?: Principal;
    /** Set by the rate-limiting stages for a request they limited: what they took, for the `RateLimit` headers. */
    rateLimit?: RateLimitState;
    /**
     * Set by the rate-limiting stage for an operation whose bucket has a per-address
     * limit: the handler of such an operation takes it once it knows the address.
     */
    takeEmailLimit?: TakeEmailLimit;
    /**
     * Set with `takeEmailLimit`: the handler of an anonymous operation whose bucket has a per-account
     * limit takes it once it knows the request is a signed-in account's.
     */
    takeAccountLimit?: (context: ChainContext, accountId: string) => Promise<void>;
    /** Set by the tenant-resolution stage: the active workspace's internal UUID. */
    workspaceId?: string;
    /** Set by the tenant-resolution stage when the resolver found a workspace for the principal. */
    tenant?: RequestTenant;
    /**
     * Set when the handler stage starts, after authentication, tenant resolution
     * and authorization: no earlier stage can consult a hook (doc 01 section 13).
     */
    hooks?: HookDispatcher;
    /** The route of the request, resolved before the first stage; absent when no operation matches. */
    route?: MatchedRoute;
    /** Set by the validation stage for a matched route. */
    input?: ValidatedInput;
  };
}

export type ChainContext = Context<ChainEnv>;

/** A module's handler for one operation. */
export type RouteHandler = (context: ChainContext, route: MatchedRoute) => Response | Promise<Response>;

/** An operation declared in `@slugbase/contracts` together with the handler that serves it. */
export interface RouteBinding {
  readonly operation: OperationDefinition;
  readonly handler: RouteHandler;
  /**
   * The route takes a `multipart/form-data` body; every other mutation must be
   * `application/json` (doc 04 section 5). Only the Netscape import upload sets it.
   */
  readonly acceptsMultipart?: boolean;
  /**
   * The origin of the marketing site whose proxy calls this route. Required on,
   * and only allowed on, an operation with `audience: 'marketing-form'`.
   */
  readonly marketingOrigin?: string;
}

export type RequestStage = MiddlewareHandler<ChainEnv>;
export type ResponseStage = (context: ChainContext) => void | Promise<void>;

export type StageImplementations = { readonly [Name in RequestStageName]?: RequestStage } & {
  readonly [Name in ResponseStageName]?: ResponseStage;
};

export interface ChainDependencies {
  readonly logger: Logger;
  readonly routes: RouteTable;
  /** `TRUSTED_PROXY_HOPS`: how many `X-Forwarded-For` entries from the right a trusted proxy wrote. */
  readonly trustedProxyHops: number;
  /** `APP_ORIGIN`: an `https` origin turns on `Strict-Transport-Security`. */
  readonly appOrigin: string;
  /** Verifies the bot-protection solution of a `marketing-form` request (stage 5). */
  readonly challenge: ChallengePort;
  /** Receives every unexpected failure (stage 11). */
  readonly errors: ErrorReportPort;
  /** The token buckets stage 6 takes from. */
  readonly rateLimit: RateLimitPort;
  /** The buckets of doc 04 section 7 with their configured limits (stage 6). */
  readonly rateLimits: RateLimitRegistry;
  /** Resolves credentials into principals (stage 4); without one every request is anonymous. */
  readonly authenticators?: readonly Authenticator[];
  /** Derives the active workspace, member and role of a principal (stage 7). */
  readonly tenantResolver: TenantResolver;
  /** The tenant transaction the handler's `tenant.withTenant` opens (stage 7). */
  readonly withTenant: Database["withTenant"];
  /** Decides the entitlement an operation declares (stage 9); by default every entitlement is refused. */
  readonly entitlements?: EntitlementCheck;
  /** Says whether a refused entitlement has a better plan to offer, for the problem stage 9 answers with; by default none has. */
  readonly upgradeAvailable?: EntitlementUpgradeCheck;
  /** Whether an account has a second factor enrolled, which an `instanceAdmin` operation needs (stage 9); by default no account has. */
  readonly secondFactor?: SecondFactorCheck;
  /** The instant, in milliseconds, stage 9 compares a session's re-authentication with; defaults to the system clock. */
  readonly now?: () => number;
  /** The hooks modules registered, consulted by the handlers of the core flows. */
  readonly hooks: HookDispatcher;
  /** How stage 11 treats a response that differs from its declared schema. */
  readonly responseValidation: ResponseValidation;
  /** Counts every request under its route template (doc 01 section 12). */
  readonly metrics?: Pick<Metrics, "recordRequest" | "recordRateLimitRejection">;
}

interface CompiledRoute {
  readonly method: string;
  /** The segments the template names; a trailing `*` is not among them. */
  readonly segments: readonly string[];
  readonly parameters: number;
  /** The template ends in `*`: it also matches any number of segments after `segments`, at least one. */
  readonly rest: boolean;
  readonly binding: RouteBinding;
}

const PARAMETER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const REST = "*";

function segmentsOf(path: string): string[] {
  return path.split("/").slice(1);
}

/**
 * The routes of the composition, matched by the path template of their operation. A template ends in `*` only for
 * a navigation that answers whatever lies below a path, such as `/go/*`; it matches at least one more segment, even
 * an empty one (a trailing slash), and loses to a template that names every segment of the path.
 */
export class RouteTable {
  readonly #routes: readonly CompiledRoute[];

  constructor(bindings: readonly RouteBinding[]) {
    this.#routes = bindings
      .map((binding) => {
        const template = segmentsOf(binding.operation.path);
        const rest = template.at(-1) === REST;
        const segments = rest ? template.slice(0, -1) : template;
        return {
          method: binding.operation.method.toUpperCase(),
          segments,
          parameters: segments.filter((segment) => PARAMETER.test(segment)).length,
          rest,
          binding,
        };
      })
      // A template that names every segment wins over one that ends in `*`, and a literal segment over a parameter at the same position.
      .sort((a, b) => Number(a.rest) - Number(b.rest) || a.parameters - b.parameters);
  }

  match(method: string, path: string): MatchedRoute | undefined {
    const requested = segmentsOf(path);
    const upper = method.toUpperCase();
    for (const route of this.#routes) {
      if (route.method !== upper || (route.rest ? requested.length <= route.segments.length : requested.length !== route.segments.length)) {
        continue;
      }
      const params = matchSegments(route.segments, requested);
      if (params !== undefined) {
        const { operation, handler, acceptsMultipart, marketingOrigin } = route.binding;
        return {
          operation,
          handler,
          params,
          ...(acceptsMultipart === undefined ? {} : { acceptsMultipart }),
          ...(marketingOrigin === undefined ? {} : { marketingOrigin }),
        };
      }
    }
    return undefined;
  }
}

function matchSegments(
  template: readonly string[],
  requested: readonly string[],
): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (const [index, expected] of template.entries()) {
    const raw = requested[index];
    if (raw === undefined || raw === "") {
      return undefined;
    }
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    const name = PARAMETER.exec(expected)?.[1];
    if (name === undefined) {
      if (value !== expected) {
        return undefined;
      }
    } else {
      params[name] = value;
    }
  }
  return params;
}

const passThrough: RequestStage = (_context, next) => next();
const passThroughResponse: ResponseStage = () => undefined;

/**
 * Installs the chain on `app` and returns the stage names in the order they run.
 * A stage without an entry in `stages` is a pass-through.
 */
export function installChain(
  app: Hono<ChainEnv>,
  dependencies: ChainDependencies,
  stages: StageImplementations = {},
): readonly StageName[] {
  const {
    logger,
    routes,
    trustedProxyHops,
    appOrigin,
    challenge,
    errors,
    rateLimit,
    rateLimits,
    hooks,
    responseValidation,
    metrics,
    authenticators = [],
    tenantResolver,
    withTenant,
    entitlements,
    upgradeAvailable,
    secondFactor,
    now,
  } = dependencies;
  const requestContext = createRequestContext({ logger, trustedProxyHops, ...(metrics === undefined ? {} : { metrics }) });
  const securityHeaders = createSecurityHeaders({ appOrigin });
  const rateLimiting = createRateLimiting({
    limiter: rateLimit,
    registry: rateLimits,
    logger,
    errors,
    ...(metrics === undefined ? {} : { recordRejection: (bucket: string) => { metrics.recordRateLimitRejection(bucket); } }),
  });

  const implemented: StageImplementations = {
    "request-context": requestContext.stage,
    "security-headers": securityHeaders.stage,
    "body-limits": bodyLimits,
    "ip-rate-limiting": rateLimiting.ipStage,
    authentication: createAuthentication({ authenticators }),
    "cross-site-protection": createCrossSiteProtection({ appOrigin, challenge, logger }),
    "rate-limiting": rateLimiting.stage,
    "tenant-resolution": createTenantResolution({ resolver: tenantResolver, withTenant }),
    validation,
    authorization: createAuthorization({
      ...(entitlements === undefined ? {} : { entitlements }),
      ...(upgradeAvailable === undefined ? {} : { upgradeAvailable }),
      ...(secondFactor === undefined ? {} : { secondFactor }),
      ...(now === undefined ? {} : { now }),
    }),
    idempotency: createIdempotency({ withTenant }),
  };
  const requestStages = REQUEST_STAGES.map((name) => ({
    name,
    run: stages[name] ?? implemented[name] ?? passThrough,
  }));
  const handler = {
    name: "handler" as const,
    run: (context: ChainContext): Response | Promise<Response> => {
      const route = context.get("route");
      context.set("hooks", hooks);
      return route === undefined ? notFoundProblem(context) : route.handler(context, route);
    },
  };
  const responseStages = RESPONSE_STAGES.map((name) => ({
    name,
    run: stages[name] ?? (name === "response" ? responseStage(responseValidation) : passThroughResponse),
  }));

  const fail = (context: ChainContext, error: unknown): void => {
    const problem = failRequest(context, error, { logger, errors });
    context.res = undefined;
    context.res = problem;
    // The replacement carries nothing of the response it replaces, so the security headers go on again.
    securityHeaders.apply(context);
  };

  app.all("*", async (context) => {
    let reached = -1;
    const dispatch = async (index: number): Promise<void> => {
      if (index <= reached) {
        throw new Error("a stage called next() more than once");
      }
      reached = index;
      const stage = requestStages[index];
      if (stage === undefined) {
        context.res = await handler.run(context);
        return;
      }
      const response = await stage.run(context, () => dispatch(index + 1));
      if (response instanceof Response) {
        context.res = response;
      }
    };

    try {
      const route = routes.match(context.req.method, new URL(context.req.url).pathname);
      if (route !== undefined) {
        context.set("route", route);
      }
      await dispatch(0);
    } catch (error) {
      fail(context, error);
    }
    // Whatever answered, the headers of the buckets the request took from go on it.
    rateLimiting.apply(context);
    for (const stage of responseStages) {
      try {
        await stage.run(context);
      } catch (error) {
        fail(context, error);
      }
    }
    requestContext.finish(context);
    return context.res;
  });

  return [...requestStages.map((stage) => stage.name), handler.name, ...responseStages.map((stage) => stage.name)];
}
