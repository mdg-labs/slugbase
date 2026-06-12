import { afterEach, describe, expect, it, vi } from "vitest";

import { canAccessMembersSettings, seatUsage } from "./members-entitlements.js";

describe("canAccessMembersSettings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("when plan gating is enabled", () => {
    it("allows Team plan workspaces", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "true");
      expect(canAccessMembersSettings("team")).toBe(true);
    });

    it("blocks Free and Personal plans", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "true");
      expect(canAccessMembersSettings("free")).toBe(false);
      expect(canAccessMembersSettings("personal")).toBe(false);
    });
  });

  describe("when plan gating is disabled", () => {
    it("allows all plans", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "false");
      expect(canAccessMembersSettings("team")).toBe(true);
      expect(canAccessMembersSettings("free")).toBe(true);
      expect(canAccessMembersSettings("personal")).toBe(true);
    });
  });
});

describe("seatUsage", () => {
  it("marks seat limit when used equals plan seats", () => {
    expect(seatUsage(3, 2, 5)).toEqual({ used: 5, limit: 5, atLimit: true });
  });

  it("returns no limit when planSeats is null", () => {
    expect(seatUsage(2, 1, null)).toEqual({ used: 3, limit: null, atLimit: false });
  });
});
