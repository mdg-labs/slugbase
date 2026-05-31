import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((callback: (scope: SentryScopeMock) => void) => {
    callback(scopeMock);
  }),
}));

const scopeMock = {
  setTags: vi.fn(),
  setExtras: vi.fn(),
  setUser: vi.fn(),
};

type SentryScopeMock = typeof scopeMock;

vi.mock("@sentry/node", () => ({
  init: sentryMocks.init,
  captureException: sentryMocks.captureException,
  captureMessage: sentryMocks.captureMessage,
  withScope: sentryMocks.withScope,
}));

import { ConfigService } from "../config/config.service.js";
import { validateEnvConfig } from "../config/env.schema.js";
import { validTestEnv } from "../test-utils/test-env.js";
import { SentryErrorReportingService } from "./sentry-error-reporting.service.js";

function buildConfig(overrides: NodeJS.ProcessEnv = {}): ConfigService {
  return new ConfigService(
    validateEnvConfig({
      ...validTestEnv,
      SENTRY_DSN: "https://example@o0.ingest.sentry.io/0",
      ...overrides,
    }),
  );
}

describe("SentryErrorReportingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes Sentry when DSN is configured", () => {
    const service = new SentryErrorReportingService(buildConfig());
    service.captureException(new Error("init probe"));

    expect(sentryMocks.init).toHaveBeenCalledOnce();
    expect(sentryMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://example@o0.ingest.sentry.io/0",
      }),
    );
  });

  it("skips init when DSN is absent", () => {
    const service = new SentryErrorReportingService(
      buildConfig({ SENTRY_DSN: undefined }),
    );
    service.captureException(new Error("noop probe"));

    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it("captures exceptions when configured", () => {
    const service = new SentryErrorReportingService(buildConfig());
    service.captureException(new Error("warmup"));

    const error = new Error("boom");
    service.captureException(error);

    expect(sentryMocks.captureException).toHaveBeenCalledWith(error);
  });

  it("skips capture when consent is denied", () => {
    const service = new SentryErrorReportingService(buildConfig());
    service.captureException(new Error("warmup"));
    sentryMocks.captureException.mockClear();

    service.captureException(new Error("blocked"), { consentGranted: false });

    expect(sentryMocks.captureException).not.toHaveBeenCalled();
  });

  it("does not attach user email without PII consent", () => {
    const service = new SentryErrorReportingService(buildConfig());
    service.captureException(new Error("warmup"));

    service.captureException(new Error("no pii"), {
      consentGranted: true,
      includePii: false,
      user: { id: "u1", email: "user@example.com" },
    });

    expect(scopeMock.setUser).toHaveBeenCalledWith({});
    expect(sentryMocks.captureException).toHaveBeenCalled();
  });

  it("attaches user when PII is explicitly allowed", () => {
    const service = new SentryErrorReportingService(buildConfig());
    service.captureException(new Error("warmup"));

    service.captureException(new Error("with pii"), {
      consentGranted: true,
      includePii: true,
      user: { id: "u1", email: "user@example.com" },
    });

    expect(scopeMock.setUser).toHaveBeenCalledWith({
      id: "u1",
      email: "user@example.com",
    });
  });
});
