import { afterEach, describe, expect, it, vi } from "vitest";

import { isBillingEnabled, isPlanGatingEnabled } from "./billing-config.js";

describe("billing-config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("disables billing when VITE_BILLING_ENABLED is false", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "false");
    expect(isBillingEnabled()).toBe(false);
    expect(isPlanGatingEnabled()).toBe(false);
  });

  it("defaults to enabled in vitest when env is unset", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "");
    expect(isBillingEnabled()).toBe(true);
    expect(isPlanGatingEnabled()).toBe(true);
  });

  it("enables billing when VITE_BILLING_ENABLED is true", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "true");
    expect(isBillingEnabled()).toBe(true);
    expect(isPlanGatingEnabled()).toBe(true);
  });
});
