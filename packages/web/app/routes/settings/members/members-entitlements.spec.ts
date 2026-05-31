import { describe, expect, it } from "vitest";

import { canAccessMembersSettings, seatUsage } from "./members-entitlements.js";

describe("canAccessMembersSettings", () => {
  it("allows Team plan workspaces", () => {
    expect(canAccessMembersSettings("team")).toBe(true);
  });

  it("blocks Free and Personal plans", () => {
    expect(canAccessMembersSettings("free")).toBe(false);
    expect(canAccessMembersSettings("personal")).toBe(false);
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
