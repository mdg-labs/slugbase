import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((callback: (scope: { setUser: ReturnType<typeof vi.fn> }) => void) => {
    callback(scopeMock);
  }),
}));

const scopeMock = {
  setUser: vi.fn(),
};

vi.mock("@sentry/react", () => ({
  init: sentryMocks.init,
  captureException: sentryMocks.captureException,
  withScope: sentryMocks.withScope,
}));

describe("error-reporting-client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("initErrorReportingClient", () => {
    it("initializes Sentry when VITE_SENTRY_DSN is set", async () => {
      vi.stubEnv("VITE_SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
      vi.stubEnv("VITE_SENTRY_ENVIRONMENT", "staging");
      vi.stubEnv("VITE_SENTRY_RELEASE", "slugbase@0.1.0");

      const { initErrorReportingClient } = await import("./error-reporting-client");
      initErrorReportingClient();

      expect(sentryMocks.init).toHaveBeenCalledOnce();
      expect(sentryMocks.init).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
          environment: "staging",
          release: "slugbase@0.1.0",
        }),
      );
    });

    it("skips init when VITE_SENTRY_DSN is absent", async () => {
      vi.stubEnv("VITE_SENTRY_DSN", "");

      const { initErrorReportingClient } = await import("./error-reporting-client");
      initErrorReportingClient();

      expect(sentryMocks.init).not.toHaveBeenCalled();
    });

    it("uses MODE as fallback when VITE_SENTRY_ENVIRONMENT is absent", async () => {
      vi.stubEnv("VITE_SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
      vi.stubEnv("VITE_SENTRY_ENVIRONMENT", "");
      vi.stubEnv("MODE", "development");

      const { initErrorReportingClient } = await import("./error-reporting-client");
      initErrorReportingClient();

      expect(sentryMocks.init).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: "development",
        }),
      );
    });

    it("omits release when VITE_SENTRY_RELEASE is absent", async () => {
      vi.stubEnv("VITE_SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
      vi.stubEnv("VITE_SENTRY_RELEASE", "");

      const { initErrorReportingClient } = await import("./error-reporting-client");
      initErrorReportingClient();

      const initCall = sentryMocks.init.mock.calls[0] as [Record<string, unknown>];
      expect(initCall[0]).not.toHaveProperty("release");
    });
  });

  describe("captureClientException", () => {
    it("captures exceptions when initialized", async () => {
      vi.stubEnv("VITE_SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");

      const { captureClientException, initErrorReportingClient } = await import(
        "./error-reporting-client"
      );
      initErrorReportingClient();
      const error = new Error("test error");
      captureClientException(error);

      expect(sentryMocks.captureException).toHaveBeenCalledWith(error);
    });

    it("skips capture when consent is denied", async () => {
      vi.stubEnv("VITE_SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");

      const { captureClientException, initErrorReportingClient } = await import(
        "./error-reporting-client"
      );
      initErrorReportingClient();
      captureClientException(new Error("blocked"), { consentGranted: false });

      expect(sentryMocks.captureException).not.toHaveBeenCalled();
    });

    it("skips capture when not initialized", async () => {
      const { captureClientException } = await import("./error-reporting-client");
      captureClientException(new Error("no init"));

      expect(sentryMocks.captureException).not.toHaveBeenCalled();
    });
  });
});
