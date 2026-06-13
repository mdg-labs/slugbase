import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryLoggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@sentry/nestjs", () => ({
  isInitialized: vi.fn(() => true),
  logger: sentryLoggerMocks,
}));

import * as Sentry from "@sentry/nestjs";

import { SentryLoggerService } from "./sentry-logger.service.js";

describe("SentryLoggerService", () => {
  let logger: SentryLoggerService;

  beforeEach(() => {
    logger = new SentryLoggerService();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    sentryLoggerMocks.debug.mockClear();
    sentryLoggerMocks.info.mockClear();
    sentryLoggerMocks.warn.mockClear();
    sentryLoggerMocks.error.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards info logs to Sentry.logger.info", () => {
    logger.log("user signed in", { userId: "u-1" });

    expect(sentryLoggerMocks.info).toHaveBeenCalledWith("user signed in", {
      userId: "u-1",
    });
    expect(process.stdout.write).toHaveBeenCalled();
  });

  it("forwards error logs to Sentry.logger.error", () => {
    logger.error("payment failed", { orderId: "o-1" });

    expect(sentryLoggerMocks.error).toHaveBeenCalledWith("payment failed", {
      orderId: "o-1",
    });
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it("scrubs PII fields from structured attributes", () => {
    logger.warn("invitation failed", {
      workspaceId: "ws-1",
      invitedEmail: "user@example.com",
    });

    expect(sentryLoggerMocks.warn).toHaveBeenCalledWith("invitation failed", {
      workspaceId: "ws-1",
    });
  });

  it("respects configured Nest log levels", () => {
    logger.setLogLevels(["error"]);

    logger.log("hidden");
    logger.error("visible");

    expect(sentryLoggerMocks.info).not.toHaveBeenCalled();
    expect(sentryLoggerMocks.error).toHaveBeenCalledOnce();
  });

  it("skips Sentry forwarding when SDK is not initialized", () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);

    logger.log("local only");

    expect(sentryLoggerMocks.info).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalled();
  });
});
