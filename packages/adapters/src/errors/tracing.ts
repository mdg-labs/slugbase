import { SpanKind, SpanStatusCode, trace, type HrTime } from "@opentelemetry/api";
import { TraceIdRatioBasedSampler, TracerProvider, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { Scope, getSpanStatusFromHttpCode, type Event, type LightNodeClient } from "@sentry/node-core/light";

// Sampled request traces (doc 01 section 12). The request context opens one SERVER span per request through
// the global OpenTelemetry tracer; without a provider those spans are dropped. This registers one that keeps
// a `tracesSampleRate` share of them and turns each finished root span into a Sentry transaction. A
// transaction is built from a short list of what the span holds, not from the span: an attribute that is not
// listed, an event or a link never reaches it. The client's `beforeSendTransaction` scrubs what is left.

// The request context's tracer scope. Every other library that opens spans through the global provider (pg-boss does,
// for the jobs of a worker that shares the process) has its own scope and is not a request.
const REQUEST_SCOPE = "@slugbase/server";

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const REQUEST_METHOD = /^[A-Z_]{3,7}$/;

function seconds([whole, nanos]: HrTime): number {
  return whole + nanos / 1e9;
}

function stringAttribute(span: ReadableSpan, name: string): string | undefined {
  const value = span.attributes[name];
  return typeof value === "string" ? value : undefined;
}

function statusOf(span: ReadableSpan): string {
  if (span.status.code === SpanStatusCode.ERROR) {
    return "internal_error";
  }
  const code = span.attributes["http.response.status_code"];
  return typeof code === "number" ? (getSpanStatusFromHttpCode(code).message ?? "ok") : "ok";
}

/** What the envelope header says about how the trace was sampled; the adapter's own release and environment travel with it. */
export interface Sampling {
  readonly rate: number;
  readonly release?: string | undefined;
  readonly environment?: string | undefined;
}

/**
 * The transaction a request's span stands for. Only a root span of kind SERVER from the request context's own tracer
 * is a request; a span that has a parent, or that another tracer opened, gives none.
 */
export function transactionOf(span: ReadableSpan, tags: Readonly<Record<string, string>>, sampling: Sampling): Event | undefined {
  if (span.parentSpanContext !== undefined || span.kind !== SpanKind.SERVER || span.instrumentationScope.name !== REQUEST_SCOPE) {
    return undefined;
  }
  const { traceId, spanId } = span.spanContext();
  const method = stringAttribute(span, "http.request.method");
  const route = stringAttribute(span, "http.route");
  const requestId = stringAttribute(span, "slugbase.request_id");
  const data: Record<string, string> = {
    ...(method !== undefined && REQUEST_METHOD.test(method) ? { "http.request.method": method } : {}),
    ...(route === undefined ? {} : { "http.route": route }),
  };
  return {
    type: "transaction",
    transaction: span.name,
    transaction_info: { source: "route" },
    start_timestamp: seconds(span.startTime),
    timestamp: seconds(span.endTime),
    platform: "node",
    contexts: { trace: { trace_id: traceId, span_id: spanId, op: "http.server", origin: "manual", status: statusOf(span), data } },
    spans: [],
    // The header of the envelope names the trace of the transaction, not the random one the client would make.
    sdkProcessingMetadata: {
      dynamicSamplingContext: {
        trace_id: traceId,
        sampled: "true",
        sample_rate: String(sampling.rate),
        ...(sampling.release === undefined ? {} : { release: sampling.release }),
        ...(sampling.environment === undefined ? {} : { environment: sampling.environment }),
      },
    },
    tags: { ...tags, ...(requestId !== undefined && REQUEST_ID.test(requestId) ? { request_id: requestId } : {}) },
  };
}

class TransactionProcessor implements SpanProcessor {
  constructor(
    private readonly client: LightNodeClient,
    private readonly tags: Readonly<Record<string, string>>,
    private readonly sampling: Sampling,
  ) {}

  onStart(): void {
    // Nothing is read before the span ends.
  }

  onEnd(span: ReadableSpan): void {
    try {
      const transaction = transactionOf(span, this.tags, this.sampling);
      if (transaction !== undefined) {
        const scope = new Scope();
        scope.setClient(this.client);
        this.client.captureEvent(transaction, undefined, scope);
      }
    } catch {
      // A trace that cannot be built is dropped; the request it describes is not affected.
    }
  }

  async forceFlush(): Promise<void> {
    await this.client.flush();
  }

  async shutdown(): Promise<void> {
    await this.client.flush();
  }
}

/** Whether `rate` is a probability: a number from 0 to 1. */
export function isSampleRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= 0 && rate <= 1;
}

/**
 * Registers the process's tracer provider, which keeps `sampling.rate` of the root spans and sends them through `client`
 * as transactions that carry `tags`. It throws when a provider is registered already, because the spans would
 * then go to the other one.
 */
export function registerTracing(
  client: LightNodeClient,
  sampling: Sampling,
  tags: Readonly<Record<string, string>>,
): void {
  const provider = new TracerProvider({
    sampler: new TraceIdRatioBasedSampler(sampling.rate),
    spanProcessors: [new TransactionProcessor(client, tags, sampling)],
  });
  if (!trace.setGlobalTracerProvider(provider)) {
    throw new Error("A tracer provider is already registered, so the error-report adapter cannot register its own");
  }
}
