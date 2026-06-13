import { describe, expect, it } from "vitest";

import {
  buildSentryLoggingOptions,
  parseEnvBooleanFlag,
  parseSentryLogLevel,
  resolveConsoleLoggingLevels,
  resolveNestLogLevels,
  shouldForwardSentryLog,
} from "./sentry-log-config.js";

describe("parseSentryLogLevel", () => {
  it("returns valid levels unchanged", () => {
    expect(parseSentryLogLevel("debug")).toBe("debug");
    expect(parseSentryLogLevel("warn")).toBe("warn");
  });

  it("defaults to info for unknown values", () => {
    expect(parseSentryLogLevel(undefined)).toBe("info");
    expect(parseSentryLogLevel("verbose")).toBe("info");
  });
});

describe("parseEnvBooleanFlag", () => {
  it("parses true/false strings", () => {
    expect(parseEnvBooleanFlag("true", false)).toBe(true);
    expect(parseEnvBooleanFlag("false", true)).toBe(false);
    expect(parseEnvBooleanFlag(undefined, true)).toBe(true);
  });
});

describe("shouldForwardSentryLog", () => {
  it("filters below the configured minimum", () => {
    expect(shouldForwardSentryLog("debug", "info")).toBe(false);
    expect(shouldForwardSentryLog("info", "info")).toBe(true);
    expect(shouldForwardSentryLog("warn", "info")).toBe(true);
    expect(shouldForwardSentryLog("fatal", "error")).toBe(true);
  });
});

describe("resolveConsoleLoggingLevels", () => {
  it("includes debug console levels when minimum is debug", () => {
    expect(resolveConsoleLoggingLevels("debug")).toContain("debug");
    expect(resolveConsoleLoggingLevels("error")).toEqual(["error", "assert"]);
  });
});

describe("resolveNestLogLevels", () => {
  it("enables verbose levels outside production", () => {
    expect(resolveNestLogLevels({ nodeEnv: "development" })).toContain("debug");
    expect(resolveNestLogLevels({ nodeEnv: "test" })).toContain("verbose");
  });

  it("maps production levels from SENTRY_LOG_LEVEL", () => {
    expect(
      resolveNestLogLevels({ nodeEnv: "production", sentryLogLevel: "warn" }),
    ).toEqual(["error", "warn"]);
    expect(
      resolveNestLogLevels({ nodeEnv: "production", sentryLogLevel: "debug" }),
    ).toContain("verbose");
  });
});

describe("buildSentryLoggingOptions", () => {
  it("adds console logging integration when enabled", () => {
    const options = buildSentryLoggingOptions({
      SENTRY_ENABLE_CONSOLE_LOGGING: "true",
      SENTRY_LOG_LEVEL: "warn",
    });

    expect(options.integrations).toHaveLength(1);
    expect(options.beforeSendLog({ level: "info", message: "x" })).toBeNull();
    expect(options.beforeSendLog({ level: "warn", message: "x" })).toEqual({
      level: "warn",
      message: "x",
    });
  });

  it("omits console integration when disabled", () => {
    const options = buildSentryLoggingOptions({
      SENTRY_ENABLE_CONSOLE_LOGGING: "false",
    });
    expect(options.integrations).toHaveLength(0);
  });
});
