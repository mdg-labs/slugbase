import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  withScope: vi.fn(
    (callback: (scope: { setUser: ReturnType<typeof vi.fn> }) => void) => {
      callback(scopeMock);
    },
  ),
}));

const scopeMock = {
  setUser: vi.fn(),
};

vi.mock("@sentry/react-router", () => ({
  captureException: sentryMocks.captureException,
  withScope: sentryMocks.withScope,
}));

describe("error-reporting-client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("captureClientException", () => {
    it("captures exceptions", async () => {
      const { captureClientException } = await import("./error-reporting-client");
      const error = new Error("test error");
      captureClientException(error);

      expect(sentryMocks.captureException).toHaveBeenCalledWith(error);
    });

    it("skips capture when consent is denied", async () => {
      const { captureClientException } = await import("./error-reporting-client");
      captureClientException(new Error("blocked"), { consentGranted: false });

      expect(sentryMocks.captureException).not.toHaveBeenCalled();
    });
  });
});
