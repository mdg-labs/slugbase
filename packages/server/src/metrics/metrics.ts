import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "@slugbase/db";
import { MetricsRegistry } from "./registry.ts";

// The metrics of doc 01 section 12. Every label value is chosen here from a
// closed set or from a template the code declared: the method is one of the
// known verbs, the route is the matched operation's path template (or
// `unmatched`), the status is the response's own. No call takes a raw path,
// slug, identifier, email or header, so none can reach a label (doc 10 T7).

export const UNMATCHED_ROUTE = "unmatched";

const LATENCY_BOUNDS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface RequestSample {
  /** One of the known verbs, or `_OTHER`. */
  readonly method: string;
  /** The path template of the matched operation, or `unmatched`. */
  readonly route: string;
  readonly status: number;
  readonly durationSeconds: number;
}

/** A queue's counts at one moment, as the job runtime reports them. */
export interface QueueSnapshot {
  readonly queue: string;
  readonly deferred: number;
  readonly ready: number;
  readonly active: number;
  /** How long the oldest ready job has waited; null where the runtime does not report it. */
  readonly oldestReadySeconds: number | null;
}

export type QueueSource = () => Promise<readonly QueueSnapshot[]>;

export interface Metrics {
  readonly registry: MetricsRegistry;
  /** Counts the request and records its latency under its route template. */
  recordRequest(sample: RequestSample): void;
  /** Counts a request the rate limiter refused, under the bucket that refused it. */
  recordRateLimitRejection(bucket: string): void;
  /** Reports the size of the pool the tenant database was opened with. */
  setPoolSize(connections: number): void;
  /**
   * Wraps the tenant transaction entry point to count the transactions in
   * flight. A call nested in another one joins its transaction and is not
   * counted again.
   */
  instrumentTenant(withTenant: Database["withTenant"]): Database["withTenant"];
  /** Reads the job queues at each scrape; the worker is the only process that has a source. */
  observeJobQueues(source: QueueSource): void;
}

export function createMetrics(): Metrics {
  const registry = new MetricsRegistry();

  const requests = registry.counter("slugbase_http_requests_total", "Requests served, by method, route template and status.", [
    "method",
    "route",
    "status",
  ]);
  const latency = registry.histogram(
    "slugbase_http_request_duration_seconds",
    "Request latency in seconds, by method and route template.",
    ["method", "route"],
    LATENCY_BOUNDS_SECONDS,
  );
  const rejections = registry.counter(
    "slugbase_rate_limit_rejections_total",
    "Requests the rate limiter refused, by bucket.",
    ["bucket"],
  );

  const poolSize = registry.gauge("slugbase_db_pool_size", "Connections the tenant database pool may open.");
  const inFlight = registry.gauge(
    "slugbase_db_tenant_transactions_in_flight",
    "Tenant transactions open or waiting for a connection; above the pool size, transactions are queueing.",
  );
  let transactions = 0;
  registry.onCollect(() => {
    inFlight.set({}, transactions);
  });

  const queueDepth = registry.gauge("slugbase_job_queue_depth", "Jobs in a queue, by queue and state (deferred, ready, active), as of the runtime's last count, at most a minute old.", [
    "queue",
    "state",
  ]);
  const queueAge = registry.gauge(
    "slugbase_job_queue_oldest_ready_age_seconds",
    "How long the oldest ready job in a queue has waited; a queue the runtime reports no age for has no sample.",
    ["queue"],
  );

  const nested = new AsyncLocalStorage<true>();

  return {
    registry,

    recordRequest({ method, route, status, durationSeconds }) {
      requests.increment({ method, route, status: String(status) });
      latency.observe({ method, route }, durationSeconds);
    },

    recordRateLimitRejection(bucket) {
      rejections.increment({ bucket });
    },

    setPoolSize(connections) {
      poolSize.set({}, connections);
    },

    instrumentTenant(withTenant) {
      return async (context, fn) => {
        if (nested.getStore() === true) {
          return withTenant(context, fn);
        }
        transactions += 1;
        try {
          return await nested.run(true, () => withTenant(context, fn));
        } finally {
          transactions -= 1;
        }
      };
    },

    observeJobQueues(source) {
      registry.onCollect(async () => {
        const snapshots = await source();
        queueDepth.clear();
        queueAge.clear();
        for (const snapshot of snapshots) {
          queueDepth.set({ queue: snapshot.queue, state: "deferred" }, snapshot.deferred);
          queueDepth.set({ queue: snapshot.queue, state: "ready" }, snapshot.ready);
          queueDepth.set({ queue: snapshot.queue, state: "active" }, snapshot.active);
          if (snapshot.oldestReadySeconds !== null) {
            queueAge.set({ queue: snapshot.queue }, snapshot.oldestReadySeconds);
          }
        }
      });
    },
  };
}
