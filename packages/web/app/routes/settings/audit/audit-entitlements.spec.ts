import { afterEach, describe, expect, it, vi } from "vitest";

import { canAccessAuditLog } from "./audit-entitlements.js";

describe("canAccessAuditLog", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("when plan gating is enabled", () => {
    it("allows Team plan workspaces", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "true");
      expect(canAccessAuditLog({ id: "ws-1", plan: "team" })).toBe(true);
    });

    it("blocks Free and Personal plans", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "true");
      expect(canAccessAuditLog({ id: "ws-1", plan: "free" })).toBe(false);
      expect(canAccessAuditLog({ id: "ws-1", plan: "personal" })).toBe(false);
    });
  });

  describe("when plan gating is disabled", () => {
    it("allows all plans", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "false");
      expect(canAccessAuditLog({ id: "ws-1", plan: "team" })).toBe(true);
      expect(canAccessAuditLog({ id: "ws-1", plan: "free" })).toBe(true);
      expect(canAccessAuditLog({ id: "ws-1", plan: "personal" })).toBe(true);
    });
  });
});
