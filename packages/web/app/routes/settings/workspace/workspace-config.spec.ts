import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadWorkspaceInterfaceConfig,
  readEditionAwareViteBoolean,
} from "./workspace-config.js";

describe("readEditionAwareViteBoolean", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("derives ce defaults when VITE flags are unset", () => {
    vi.stubEnv("SLUGBASE_EDITION", "ce");
    vi.stubEnv("VITE_AI_BYO_CREDENTIAL", "");
    vi.stubEnv("VITE_BILLING_ENABLED", "");

    expect(readEditionAwareViteBoolean("VITE_AI_BYO_CREDENTIAL")).toBe(false);
    expect(readEditionAwareViteBoolean("VITE_BILLING_ENABLED")).toBe(false);
  });

  it("derives cloud defaults when VITE flags are unset", () => {
    vi.stubEnv("SLUGBASE_EDITION", "cloud");
    vi.stubEnv("VITE_AI_BYO_CREDENTIAL", "");
    vi.stubEnv("VITE_BILLING_ENABLED", "");

    expect(readEditionAwareViteBoolean("VITE_AI_BYO_CREDENTIAL")).toBe(false);
    expect(readEditionAwareViteBoolean("VITE_BILLING_ENABLED")).toBe(true);
  });
});

describe("loadWorkspaceInterfaceConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads ce operator-managed AI when edition presets apply", async () => {
    vi.stubEnv("SLUGBASE_EDITION", "ce");
    vi.stubEnv("VITE_BILLING_ENABLED", "false");
    vi.stubEnv("VITE_AI_BYO_CREDENTIAL", "false");

    const config = await loadWorkspaceInterfaceConfig();

    expect(config).toEqual({
      aiByoCredential: false,
      billingEnabled: false,
    });
  });

  it("loads cloud operator-managed AI when edition presets apply", async () => {
    vi.stubEnv("SLUGBASE_EDITION", "cloud");
    vi.stubEnv("VITE_BILLING_ENABLED", "true");
    vi.stubEnv("VITE_AI_BYO_CREDENTIAL", "false");

    const config = await loadWorkspaceInterfaceConfig();

    expect(config).toEqual({
      aiByoCredential: false,
      billingEnabled: true,
    });
  });
});
