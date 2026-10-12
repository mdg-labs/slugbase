import type { OperationDefinition } from "@slugbase/contracts";
import type { ErrorReportPort } from "@slugbase/core";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Logger } from "../create-server.ts";
import type { HookDispatcher } from "../hooks/index.ts";
import type { Metrics } from "../metrics/index.ts";
import { bodyLimits } from "./body-limits.ts";
import { createSecurityHeaders } from "./headers.ts";
import { failRequest, notFoundProblem, responseStage, type ResponseValidation } from "./problem.ts";
import { createRequestContext } from "./request-context.ts";

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
  "authentication",
  "cross-site-protection",
  "rate-limiting",
  "tenant-resolution",
  "validation",
  "authorization",
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
    /** Set by the tenant-resolution stage: the active workspace's internal UUID. */
    workspaceId?: string;
    /**
     * Set when the handler stage starts, after authentication, tenant resolution
     * and authorization: no earlier stage can consult a hook (doc 01 section 13).
     */
    hooks?: HookDispatcher;
    /** The route of the request, resolved before the first stage; absent when no operation matches. */
    route?: MatchedRoute;
  };
}

export type ChainContext = Context<ChainEnv>;

/** A module's handler for one operation. */
export type RouteHandler = (context: ChainContext, route: MatchedRoute) => Response | Promise<Response>;

/** An operation declared in `@slugbase/contracts` together with the handler that serves it. */
export interface RouteBinding {
  readonly operation: OperationDefinition;
  readonly handler: RouteHandler;
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
  /** Receives every unexpected failure (stage 11). */
  readonly errors: ErrorReportPort;
  /** The hooks modules registered, consulted by the handlers of the core flows. */
  readonly hooks: HookDispatcher;
  /** How stage 11 treats a response that differs from its declared schema. */
  readonly responseValidation: ResponseValidation;
  /** Counts every request under its route template (doc 01 section 12). */
  readonly metrics?: Pick<Metrics, "recordRequest">;
}

interface CompiledRoute {
  readonly method: string;
  readonly segments: readonly string[];
  readonly parameters: number;
  readonly binding: RouteBinding;
}

const PARAMETER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function segmentsOf(path: string): string[] {
  return path.split("/").slice(1);
}

/** The routes of the composition, matched by the path template of their operation. */
export class RouteTable {
  readonly #routes: readonly CompiledRoute[];

  constructor(bindings: readonly RouteBinding[]) {
    this.#routes = bindings
      .map((binding) => {
        const segments = segmentsOf(binding.operation.path);
        return {
          method: binding.operation.method.toUpperCase(),
          segments,
          parameters: segments.filter((segment) => PARAMETER.test(segment)).length,
          binding,
        };
      })
      // A literal segment wins over a parameter at the same position.
      .sort((a, b) => a.parameters - b.parameters);
  }

  match(method: string, path: string): MatchedRoute | undefined {
    const requested = segmentsOf(path);
    const upper = method.toUpperCase();
    for (const route of this.#routes) {
      if (route.method !== upper || route.segments.length !== requested.length) {
        continue;
      }
      const params = matchSegments(route.segments, requested);
      if (params !== undefined) {
        return { operation: route.binding.operation, handler: route.binding.handler, params };
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
  const { logger, routes, trustedProxyHops, appOrigin, errors, hooks, responseValidation, metrics } = dependencies;
  const requestContext = createRequestContext({ logger, trustedProxyHops, ...(metrics === undefined ? {} : { metrics }) });
  const securityHeaders = createSecurityHeaders({ appOrigin });

  const implemented: StageImplementations = {
    "request-context": requestContext.stage,
    "security-headers": securityHeaders.stage,
    "body-limits": bodyLimits,
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
