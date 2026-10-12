import { createAdaptorServer, type ServerType } from "@hono/node-server";
import type { Logger } from "../create-server.ts";
import type { Metrics } from "./metrics.ts";
import { PROMETHEUS_CONTENT_TYPE } from "./registry.ts";

// The internal listener of doc 01 section 3: `/metrics` on its own port, never
// on the public one. It serves nothing else, and nothing scrapes it unless an
// operator points a scraper at it (D27).

export interface MetricsListener {
  readonly port: number;
  /** Stops listening and cuts open connections; a scrape is a single short request. */
  close(): Promise<void>;
}

function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", ...headers } });
}

export async function startMetricsListener(options: {
  readonly metrics: Metrics;
  readonly port: number;
  readonly logger: Logger;
}): Promise<MetricsListener> {
  const { metrics, port: requested, logger } = options;

  const listener: ServerType = createAdaptorServer({
    overrideGlobalObjects: false,
    fetch: async (request) => {
      if (new URL(request.url).pathname !== "/metrics") {
        return plain(404, "not found\n");
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return plain(405, "method not allowed\n", { allow: "GET, HEAD" });
      }
      try {
        const body = await metrics.registry.render();
        return new Response(request.method === "HEAD" ? null : body, {
          headers: { "cache-control": "no-store", "content-type": PROMETHEUS_CONTENT_TYPE },
        });
      } catch (error) {
        logger.error("Rendering the metrics failed", { error: error instanceof Error ? error.name : typeof error });
        return plain(500, "metrics unavailable\n");
      }
    },
  });

  const port = await new Promise<number>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(requested, () => {
      listener.off("error", reject);
      const address = listener.address();
      resolve(typeof address === "object" && address !== null ? address.port : requested);
    });
  });
  logger.info("Metrics listening", { port });

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
        if ("closeAllConnections" in listener && typeof listener.closeAllConnections === "function") {
          listener.closeAllConnections();
        }
      }),
  };
}
