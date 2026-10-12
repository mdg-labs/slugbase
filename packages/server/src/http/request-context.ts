import { randomUUID } from "node:crypto";
import { SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { Logger } from "../create-server.ts";
import type { ChainContext, RequestStage } from "./chain.ts";
import { childLogger } from "./logger.ts";
import { clientIpOf } from "./trusted-proxy.ts";

// Stage 1 of the chain (doc 01 section 4): the request ID, the per-request
// logger, the span and the client IP. The stage starts them; `finish` runs once
// every other stage has produced the final response, so the log line and the
// span carry the status that is actually sent. A line or a span carries the
// route template of the matched operation and never the raw path, query string,
// header or body (doc 10 T7): what they hold is chosen here, field by field.

const REQUEST_ID_HEADER = "x-request-id";

// A request ID the caller may choose is one that cannot carry markup, spaces,
// separators or a log-forging newline, and is long enough to be unique.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** The request ID: the caller's `X-Request-Id` when it is safe, else a fresh one. */
export function requestIdFrom(header: string | undefined): string {
  return header !== undefined && SAFE_REQUEST_ID.test(header) ? header : randomUUID();
}

const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

// An arbitrary method token is client-chosen, so it is not a span name or a log value.
function methodOf(method: string): string {
  const upper = method.toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : "_OTHER";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UNMATCHED_ROUTE = "unmatched";

interface RequestScope {
  readonly startedAt: number;
  readonly span: Span;
  readonly logger: Logger;
  readonly method: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The Node adapter hands the connection over as `env.incoming` (or, nested,
// `env.server.incoming`); a request served without a socket, as in a test,
// has none.
function socketAddressOf(context: ChainContext): string | undefined {
  const env: unknown = context.env;
  if (!isRecord(env)) {
    return undefined;
  }
  const bindings = isRecord(env["server"]) ? env["server"] : env;
  const incoming = bindings["incoming"];
  const socket = isRecord(incoming) ? incoming["socket"] : undefined;
  const address = isRecord(socket) ? socket["remoteAddress"] : undefined;
  return typeof address === "string" ? address : undefined;
}

export interface RequestContextOptions {
  readonly logger: Logger;
  /** `TRUSTED_PROXY_HOPS`. */
  readonly trustedProxyHops: number;
}

export interface RequestContext {
  /** Stage 1. */
  readonly stage: RequestStage;
  /**
   * Run after the response stages: sets `X-Request-Id` on the response, writes
   * the request's log line and ends its span. A failure to log never changes the response.
   */
  finish(context: ChainContext): void;
}

export function createRequestContext({ logger, trustedProxyHops }: RequestContextOptions): RequestContext {
  const tracer = trace.getTracer("@slugbase/server");
  const scopes = new WeakMap<ChainContext, RequestScope>();

  const stage: RequestStage = async (context, next) => {
    const startedAt = performance.now();
    const requestId = requestIdFrom(context.req.header(REQUEST_ID_HEADER));
    const method = methodOf(context.req.method);
    const template = context.get("route")?.operation.path;

    const span = tracer.startSpan(template === undefined ? method : `${method} ${template}`, {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": method,
        ...(template === undefined ? {} : { "http.route": template }),
        "slugbase.request_id": requestId,
      },
    });

    context.set("requestId", requestId);
    context.set(
      "clientIp",
      clientIpOf({
        socketAddress: socketAddressOf(context),
        forwardedFor: context.req.header("x-forwarded-for"),
        trustedHops: trustedProxyHops,
      }),
    );
    const requestLogger = childLogger(logger, { requestId });
    context.set("logger", requestLogger);
    scopes.set(context, { startedAt, span, logger: requestLogger, method });

    await next();
  };

  const finish = (context: ChainContext): void => {
    const scope = scopes.get(context);
    if (scope === undefined) {
      return;
    }
    scopes.delete(context);

    const requestId = context.get("requestId");
    const response = context.res;
    if (requestId !== undefined && response.headers.get(REQUEST_ID_HEADER) !== requestId) {
      const headers = new Headers(response.headers);
      headers.set(REQUEST_ID_HEADER, requestId);
      context.res = undefined;
      context.res = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    const { span, logger: requestLogger, startedAt, method } = scope;
    try {
      const status = context.res.status;
      const route = context.get("route")?.operation.path;
      const workspaceId = context.get("workspaceId");
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      requestLogger.info("Request completed", {
        method,
        route: route ?? UNMATCHED_ROUTE,
        status,
        latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
        principalType: context.get("principalType") ?? "anonymous",
        ...(workspaceId !== undefined && UUID.test(workspaceId) ? { workspaceId } : {}),
      });
    } catch {
      // Telemetry is not part of the answer: a broken log destination must not turn a response into an error.
    } finally {
      span.end();
    }
  };

  return { stage, finish };
}
