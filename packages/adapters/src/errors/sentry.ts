import type { ErrorReportContext, ErrorReportPort } from "@slugbase/core";
import { LightNodeClient, Scope, defaultStackParser, makeNodeTransport } from "@sentry/node-core/light";
import { scrubEvent } from "./scrub.ts";

const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

export interface CreateSentryErrorReportOptions {
  /** The operator's `ERROR_REPORT_DSN`; never derived from a request. */
  readonly dsn: string;
  readonly environment?: string;
  readonly release?: string;
  /** How long a capture waits for the event to leave the process; default 2000. */
  readonly flushTimeoutMs?: number;
}

// Checked here, before the SDK sees it: the SDK reports an invalid DSN by logging the value.
function isDsn(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname !== "" &&
    url.username !== "" &&
    /^(?:\/[^/]+)*\/\d+$/.test(url.pathname)
  );
}

/**
 * The Sentry-protocol adapter of `ErrorReportPort` (doc 01 section 6). The
 * client is built directly rather than through `init`, so it is not global
 * state and has none of the default integrations: no request data, console
 * output, breadcrumbs, process handlers or tracing. Every event passes the
 * scrubber last; an event that cannot be scrubbed is dropped.
 */
export function createSentryErrorReport(options: CreateSentryErrorReportOptions): ErrorReportPort {
  if (!isDsn(options.dsn)) {
    throw new Error("ERROR_REPORT_DSN is not a valid Sentry DSN");
  }
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const client = new LightNodeClient({
    dsn: options.dsn,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.release === undefined ? {} : { release: options.release }),
    integrations: [],
    transport: makeNodeTransport,
    stackParser: defaultStackParser,
    sendDefaultPii: false,
    includeServerName: false,
    maxBreadcrumbs: 0,
    sendClientReports: false,
    beforeSend: (event) => {
      try {
        return scrubEvent(event);
      } catch {
        return null;
      }
    },
  });
  client.init();

  return {
    available: true,
    async capture(error: unknown, context?: ErrorReportContext): Promise<void> {
      const scope = new Scope();
      scope.setClient(client);
      if (context?.route !== undefined) {
        scope.setTransactionName(context.route);
      }
      if (context?.requestId !== undefined) {
        scope.setTag("request_id", context.requestId);
      }
      scope.captureException(error);
      await client.flush(flushTimeoutMs);
    },
  };
}
