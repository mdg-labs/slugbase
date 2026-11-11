import type { ErrorReportContext, ErrorReportPort, MonitoredRun, MonitoredRunOutcome } from "@slugbase/core";
import { LightNodeClient, Scope, defaultStackParser, makeNodeTransport } from "@sentry/node-core/light";
import { isRedactedKey, scrubEvent, scrubText } from "./scrub.ts";
import { isSampleRate, registerTracing } from "./tracing.ts";

const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

export interface CreateSentryErrorReportOptions {
  /** The operator's `ERROR_REPORT_DSN`; never derived from a request. */
  readonly dsn: string;
  readonly environment?: string;
  readonly release?: string;
  /** How long a capture waits for the event to leave the process; default 2000. */
  readonly flushTimeoutMs?: number;
  /**
   * Fixed tags on every event and transaction, such as which process sent it. Names and values are chosen by the
   * operator, never taken from a request, and are refused when the scrubber would change or drop them.
   */
  readonly tags?: Readonly<Record<string, string>>;
  /**
   * The share of requests, from 0 to 1, whose root span is sent as a transaction. Unset registers no tracer provider
   * and sends no transaction. It registers the process's one global tracer provider, so one adapter per process may set it.
   */
  readonly tracesSampleRate?: number;
  /** Offers monitored runs, which are sent as cron check-ins; default off. The monitors themselves are configured in the tracker. */
  readonly checkIns?: boolean;
}

const TAG_NAME = /^[A-Za-z0-9_.:-]{1,32}$/;
const TAG_VALUE = /^[^\p{Cc}]{1,200}$/u;
// Names the SDK or the adapter sets itself.
const RESERVED_TAG_NAMES: readonly string[] = ["request_id", "release", "environment", "server_name", "transaction", "level"];

// The scrubber runs over every event, so a tag it would change or drop is refused when the adapter is built
// rather than lost later. A message names the tag's name only: the value may be what the scrubber exists to remove.
function checkedTags(tags: Readonly<Record<string, string>>): Record<string, string> {
  for (const [name, value] of Object.entries(tags)) {
    if (!TAG_NAME.test(name)) {
      throw new Error("An error-report tag name must be 1 to 32 letters, digits, or . _ : -");
    }
    if (RESERVED_TAG_NAMES.includes(name) || isRedactedKey(name)) {
      throw new Error(`The error-report tag name ${name} is reserved or looks like a secret's name`);
    }
    if (!TAG_VALUE.test(value) || scrubText(value) !== value) {
      throw new Error(`The value of the error-report tag ${name} must be 1 to 200 characters of plain text, with no personal data`);
    }
  }
  return { ...tags };
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
 * output, breadcrumbs or process handlers. Tracing and check-ins are options
 * that are off unless set. Every event, an error or a transaction, passes the
 * scrubber last; an event that cannot be scrubbed is dropped. A check-in holds
 * only the monitor slug, the status, the duration, the environment, the release and a random trace identifier.
 */
export function createSentryErrorReport(options: CreateSentryErrorReportOptions): ErrorReportPort {
  if (!isDsn(options.dsn)) {
    throw new Error("ERROR_REPORT_DSN is not a valid Sentry DSN");
  }
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const tags = checkedTags(options.tags ?? {});
  const tracesSampleRate = options.tracesSampleRate;
  if (tracesSampleRate !== undefined && !isSampleRate(tracesSampleRate)) {
    throw new Error("tracesSampleRate must be a number from 0 to 1");
  }
  const scrubbed = <Event extends object>(event: Event): Event | null => {
    try {
      return scrubEvent(event, { release: options.release, environment: options.environment });
    } catch {
      return null;
    }
  };
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
    beforeSend: scrubbed,
    beforeSendTransaction: scrubbed,
  });
  client.init();
  // A check-in is not an event, so the scrubber does not see it; its header names the DSN's public key, which the events' header does not.
  client.on("beforeEnvelope", (envelope) => {
    const [header, items] = envelope;
    if (typeof header.trace === "object" && header.trace !== null && items.some(([itemHeader]) => itemHeader.type === "check_in")) {
      Reflect.deleteProperty(header.trace, "public_key");
    }
  });
  if (tracesSampleRate !== undefined) {
    registerTracing(client, { rate: tracesSampleRate, release: options.release, environment: options.environment }, tags);
  }

  const startMonitoredRun = (slug: string): Promise<MonitoredRun> => {
    const startedAt = performance.now();
    const scope = new Scope();
    scope.setClient(client);
    let checkInId: string | undefined;
    try {
      checkInId = client.captureCheckIn({ monitorSlug: slug, status: "in_progress" }, undefined, scope);
    } catch {
      // A check-in that cannot be sent is not part of the job.
    }
    return Promise.resolve({
      async finish(outcome: MonitoredRunOutcome): Promise<void> {
        try {
          client.captureCheckIn(
            {
              ...(checkInId === undefined ? {} : { checkInId }),
              monitorSlug: slug,
              status: outcome,
              duration: (performance.now() - startedAt) / 1000,
            },
            undefined,
            scope,
          );
          await client.flush(flushTimeoutMs);
        } catch {
          // As above.
        }
      },
    });
  };

  return {
    available: true,
    ...(options.checkIns === true ? { startMonitoredRun } : {}),
    async capture(error: unknown, context?: ErrorReportContext): Promise<void> {
      const scope = new Scope();
      scope.setClient(client);
      scope.setTags(tags);
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
