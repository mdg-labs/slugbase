import type { LogLevel } from "@nestjs/common";
import { consoleLoggingIntegration } from "@sentry/nestjs";

export type SentryLogLevelFilter = "debug" | "info" | "warn" | "error";

type SentryLogSeverityLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal";

type ConsoleLevel = "debug" | "info" | "warn" | "error" | "log" | "assert" | "trace";

const MIN_LEVEL_RANK: Record<SentryLogLevelFilter, number> = {
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

function sentryLogRank(level: SentryLogSeverityLevel): number {
  switch (level) {
    case "trace":
      return 0;
    case "debug":
      return 1;
    case "info":
      return 2;
    case "warn":
      return 3;
    case "error":
      return 4;
    case "fatal":
      return 5;
  }
}

/** Parses env-style booleans; mirrors env.schema `parseEnvBoolean`. */
export function parseEnvBooleanFlag(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return defaultValue;
}

export function parseSentryLogLevel(
  value: string | undefined,
): SentryLogLevelFilter {
  if (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  ) {
    return value;
  }
  return "info";
}

export function shouldForwardSentryLog(
  level: SentryLogSeverityLevel,
  minLevel: SentryLogLevelFilter,
): boolean {
  if (level === "fatal") {
    return true;
  }
  return sentryLogRank(level) >= MIN_LEVEL_RANK[minLevel];
}

export function resolveConsoleLoggingLevels(
  minLevel: SentryLogLevelFilter,
): ConsoleLevel[] {
  switch (minLevel) {
    case "debug":
      return ["debug", "info", "warn", "error", "log", "trace", "assert"];
    case "info":
      return ["info", "warn", "error", "log", "assert"];
    case "warn":
      return ["warn", "error", "assert"];
    case "error":
      return ["error", "assert"];
  }
}

export function resolveNestLogLevels(params: {
  sentryLogLevel?: SentryLogLevelFilter;
  nodeEnv: "development" | "test" | "production";
}): LogLevel[] {
  if (params.nodeEnv !== "production") {
    return ["error", "warn", "log", "debug", "verbose"];
  }

  switch (params.sentryLogLevel ?? "info") {
    case "debug":
      return ["error", "warn", "log", "debug", "verbose"];
    case "info":
      return ["error", "warn", "log"];
    case "warn":
      return ["error", "warn"];
    case "error":
      return ["error"];
  }
}

export interface SentryLoggingEnv {
  SENTRY_LOG_LEVEL?: string;
  SENTRY_ENABLE_CONSOLE_LOGGING?: string;
}

export function buildSentryLoggingOptions(env: SentryLoggingEnv): {
  beforeSendLog: <T extends { level: SentryLogSeverityLevel }>(log: T) => T | null;
  integrations: ReturnType<typeof consoleLoggingIntegration>[];
} {
  const minLevel = parseSentryLogLevel(env.SENTRY_LOG_LEVEL);
  const enableConsoleLogging = parseEnvBooleanFlag(
    env.SENTRY_ENABLE_CONSOLE_LOGGING,
    false,
  );

  const integrations: ReturnType<typeof consoleLoggingIntegration>[] = [];
  if (enableConsoleLogging) {
    integrations.push(
      consoleLoggingIntegration({
        levels: resolveConsoleLoggingLevels(minLevel),
      }),
    );
  }

  return {
    beforeSendLog<T extends { level: SentryLogSeverityLevel }>(log: T) {
      return shouldForwardSentryLog(log.level, minLevel) ? log : null;
    },
    integrations,
  };
}
