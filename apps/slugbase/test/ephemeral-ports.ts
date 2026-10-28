import { resolve } from "node:path";

// The tests that start the server or the worker need a port nothing else can take between choosing it and binding
// it. Probing for a free port and releasing it leaves that window open, so the child binds port 0 instead (the
// preload `bind-any-port.ts`) and the test reads the port it holds from the child's own log line.

/** Node options that make the child bind every numeric port it is given to port 0. */
export const BIND_ANY_PORT: readonly string[] = ["--import", resolve(import.meta.dirname, "bind-any-port.ts")];

/**
 * The configuration still has to name a port (the schema refuses 0), and the public and the metrics port have to
 * differ; neither number is ever bound while the preload is in place.
 */
export const PLACEHOLDER_PORTS = { PORT: "3000", METRICS_PORT: "3001" } as const;

/** The port a listener logged in `output` under `message`, or undefined while the line has not arrived whole. */
export function boundPort(output: string, message: "Listening" | "Metrics listening"): number | undefined {
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) {
      continue;
    }
    let entry: { msg?: unknown; port?: unknown };
    try {
      entry = JSON.parse(line) as { msg?: unknown; port?: unknown };
    } catch {
      continue;
    }
    if (entry.msg === message && typeof entry.port === "number") {
      return entry.port;
    }
  }
  return undefined;
}
