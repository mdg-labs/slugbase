import * as Sentry from "@sentry/react-router";

const dsn = process.env["SENTRY_DSN"];
const environment =
  process.env["SENTRY_ENVIRONMENT"] || process.env["NODE_ENV"] || "production";
const release = process.env["SENTRY_RELEASE"] || undefined;
const tracesSampleRate = Number(
  process.env["SENTRY_TRACES_SAMPLE_RATE"] ?? "0.1",
);

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    ...(release ? { release } : {}),
    enableLogs: true,
    tracesSampleRate,
    tracesSampler: (_samplingContext) => {
      const url =
        typeof _samplingContext === "object" && _samplingContext !== null
          ? ((
              _samplingContext as { location?: { pathname?: string } }
            ).location?.pathname as string | undefined)
          : undefined;
      if (url === "/health" || url === "/version") {
        return 0;
      }
      return tracesSampleRate;
    },
    beforeSend(event) {
      if (event.user) {
        delete event.user.email;
        delete event.user.ip_address;
        delete event.user.username;
      }
      return event;
    },
  });
}