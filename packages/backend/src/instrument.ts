import * as Sentry from "@sentry/nestjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildSentryLoggingOptions } from "./logging/sentry-log-config.js";

const SENTRY_DSN = process.env.SENTRY_DSN;
const SENTRY_ENVIRONMENT =
  process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production";

const RELEASE_PREFIX = "slugbase@";

function readRootPackageVersion(): string | undefined {
  try {
    const rootPkg = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(rootPkg, "utf-8")) as {
      version?: string;
    };
    return pkg.version !== undefined
      ? `${RELEASE_PREFIX}${pkg.version}`
      : undefined;
  } catch {
    return undefined;
  }
}

const release = process.env.SENTRY_RELEASE ?? readRootPackageVersion();

const tracesSampleRate = Number.parseFloat(
  process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
);
const profileSessionSampleRate = Number.parseFloat(
  process.env.SENTRY_PROFILING_SAMPLE_RATE ?? "0.1",
);

if (SENTRY_DSN) {
  const loggingOptions = buildSentryLoggingOptions(process.env);

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,
    ...(release ? { release } : {}),
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 0.1,
    tracesSampler: (samplingContext) => {
      const samplingCtx = samplingContext as {
        request?: { url?: string };
        transactionContext?: { name?: string };
      };
      const url =
        typeof samplingCtx.request?.url === "string"
          ? samplingCtx.request.url
          : "";
      const name =
        typeof samplingCtx.transactionContext?.name === "string"
          ? samplingCtx.transactionContext.name
          : "";
      if (
        url.endsWith("/health") ||
        url.endsWith("/version") ||
        name.includes("/health") ||
        name.includes("/version")
      ) {
        return 0;
      }
      return Number.isFinite(tracesSampleRate) ? tracesSampleRate : 0.1;
    },
    profileSessionSampleRate: Number.isFinite(profileSessionSampleRate)
      ? profileSessionSampleRate
      : 0.1,
    profileLifecycle: "trace",
    enableLogs: true,
    beforeSendLog: loggingOptions.beforeSendLog,
    integrations: loggingOptions.integrations,
    beforeSend(event) {
      if (event.user) {
        delete event.user.email;
        delete event.user.ip_address;
        delete event.user.username;
      }
      if (event.request?.headers) {
        const headers = { ...event.request.headers };
        delete headers.authorization;
        delete headers.cookie;
        event.request.headers = headers;
      }
      return event;
    },
  });
}
