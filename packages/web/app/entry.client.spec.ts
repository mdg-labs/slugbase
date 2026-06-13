import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  sentryOnError: vi.fn(),
  reactRouterTracingIntegration: vi.fn(() => ({})),
  replayIntegration: vi.fn(() => ({})),
  feedbackIntegration: vi.fn(() => ({})),
}));

const hydrateRootMock = vi.fn();
let hydratedRouterOnError: unknown;

vi.mock("@sentry/react-router", () => sentryMocks);
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    startTransition: (callback: () => void) => {
      callback();
    },
  };
});
vi.mock("react-dom/client", () => ({
  hydrateRoot: (...args: unknown[]) => {
    hydrateRootMock(...args);
  },
}));
vi.mock("react-router/dom", () => ({
  HydratedRouter: (props: { onError?: unknown }) => {
    hydratedRouterOnError = props.onError;
    return null;
  },
}));

describe("entry.client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    hydratedRouterOnError = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not init Sentry or wire sentryOnError when DSN is absent", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    await import("./entry.client");

    expect(sentryMocks.init).not.toHaveBeenCalled();
    expect(hydratedRouterOnError).toBeUndefined();
    expect(hydrateRootMock).toHaveBeenCalled();
  });

  it("inits Sentry when DSN is set", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://example@o0.ingest.sentry.io/0");
    await import("./entry.client");

    expect(sentryMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://example@o0.ingest.sentry.io/0",
      }),
    );
    expect(hydrateRootMock).toHaveBeenCalled();
  });
});

describe("self-host GHCR build", () => {
  it("build-push-ghcr.sh omits VITE_SENTRY_* from docker build-args", () => {
    const script = readFileSync(
      join(__dirname, "../../../.github/scripts/build-push-ghcr.sh"),
      "utf-8",
    );

    expect(script).toContain("Never pass VITE_SENTRY_*");
    expect(script).toContain("SELF_HOST_VITE_BUILD_ARGS");
    expect(script).not.toMatch(
      /env \| grep '\^VITE_'/,
    );
  });
});
