import { afterEach, describe, expect, it, vi } from "vitest";

import { FREE_BOOKMARK_CAP } from "./dashboard.constants.js";
import {
  deriveChecklistCompletion,
  resolveEntitlementBanner,
  sortTagsByUsage,
} from "./dashboard.utils.js";
import type { DashboardData } from "./dashboard.types.js";

const baseData: DashboardData = {
  workspace: { id: "ws-1", name: "Personal", plan: "free" },
  counts: {
    bookmarks: 12,
    folders: 2,
    tags: 3,
    sharedWithMe: 1,
    sharedByMe: 0,
  },
  quickAccess: [],
  pinned: [],
  recent: [],
  folders: [],
  tags: [],
};

describe("resolveEntitlementBanner", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("when plan gating is enabled", () => {
    it("returns null for Personal plan workspaces", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "true");
      expect(
        resolveEntitlementBanner("personal", FREE_BOOKMARK_CAP),
      ).toBeNull();
    });

    it("returns null for Free workspaces well below the cap", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "true");
      expect(resolveEntitlementBanner("free", 10)).toBeNull();
    });

    it("returns approaching variant near the Free cap", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "true");
      const banner = resolveEntitlementBanner("free", 46);
      expect(banner).toEqual({
        variant: "approaching",
        used: 46,
        cap: FREE_BOOKMARK_CAP,
        remaining: 4,
      });
    });

    it("returns at-cap variant when the Free cap is reached", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "true");
      const banner = resolveEntitlementBanner("free", FREE_BOOKMARK_CAP);
      expect(banner).toEqual({
        variant: "at-cap",
        used: FREE_BOOKMARK_CAP,
        cap: FREE_BOOKMARK_CAP,
        remaining: 0,
      });
    });
  });

  describe("when plan gating is disabled", () => {
    it("returns null for Free workspaces regardless of bookmark count", () => {
      vi.stubEnv("VITE_BILLING_ENABLED", "false");
      expect(resolveEntitlementBanner("free", FREE_BOOKMARK_CAP)).toBeNull();
      expect(resolveEntitlementBanner("free", 46)).toBeNull();
    });
  });
});

describe("deriveChecklistCompletion", () => {
  it("marks folder and tag items complete from workspace counts", () => {
    expect(deriveChecklistCompletion(baseData)).toEqual({
      folder: true,
      tag: true,
    });
  });
});

describe("sortTagsByUsage", () => {
  it("orders tags by bookmark count descending", () => {
    const sorted = sortTagsByUsage([
      { id: "1", name: "docs", color: null, bookmarkCount: 2 },
      { id: "2", name: "tools", color: null, bookmarkCount: 8 },
      { id: "3", name: "ai", color: null, bookmarkCount: 5 },
    ]);

    expect(sorted.map((tag) => tag.name)).toEqual(["tools", "ai", "docs"]);
  });
});
