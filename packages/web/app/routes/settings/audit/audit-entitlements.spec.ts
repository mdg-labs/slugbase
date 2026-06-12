import { afterEach, describe, expect, it, vi } from "vitest";

import { canAccessAuditLog } from "./audit-entitlements.js";

describe("canAccessAuditLog", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("when plan gating is enabled", () => {
    it("allows Team plan workspaces", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "true");
      expect(canAccessAuditLog({ plan: "team" })).toBe(true);
    });

    it("blocks Free and Personal plans", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "true");
      expect(canAccessAuditLog({ plan: "free" })).toBe(false);
      expect(canAccessAuditLog({ plan: "personal" })).toBe(false);
    });
  });

  describe("when plan gating is disabled", () => {
    it("allows all plans", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "false");
      expect(canAccessAuditLog({ plan: "team" })).toBe(true);
      expect(canAccessAuditLog({ plan: "free" })).toBe(true);
      expect(canAccessAuditLog({ plan: "personal" })).toBe(true);
    });
  });
});
