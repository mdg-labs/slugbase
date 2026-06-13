import { afterEach, describe, expect, it, vi } from "vitest";

import { canUseEntitlement, canUseTeamSharing } from "./use-entitlements.js";

describe("use-entitlements", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("when plan gating is enabled", () => {
    it("grants team-sharing only on Team plan", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "true");
      expect(canUseTeamSharing("team")).toBe(true);
      expect(canUseTeamSharing("personal")).toBe(false);
      expect(canUseTeamSharing("free")).toBe(false);
    });

    it("checks capabilities via canUseEntitlement", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "true");
      expect(canUseEntitlement("team", "team-sharing")).toBe(true);
      expect(canUseEntitlement("free", "team-sharing")).toBe(false);
    });
  });

  describe("when plan gating is disabled", () => {
    it("grants team-sharing on all plans", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "false");
      expect(canUseTeamSharing("team")).toBe(true);
      expect(canUseTeamSharing("personal")).toBe(true);
      expect(canUseTeamSharing("free")).toBe(true);
    });
  });
});
