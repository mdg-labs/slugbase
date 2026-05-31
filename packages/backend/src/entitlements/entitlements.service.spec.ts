import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { EntitlementsService, FREE_BOOKMARK_CAP } from "./entitlements.service.js";
import type { EntitlementCapability } from "./entitlements.service.js";

const freeWorkspace = { plan: "free" as const };
const personalWorkspace = { plan: "personal" as const };
const teamWorkspace = { plan: "team" as const };

const personalCapabilities: EntitlementCapability[] = [
  "team-sharing",
  "unlimited-bookmarks",
  "custom-slug-rules",
  "workspace-members",
];

const allCapabilities: EntitlementCapability[] = [
  ...personalCapabilities,
  "audit-log",
];

describe("EntitlementsService", () => {
  const service = new EntitlementsService();

  describe("FREE_BOOKMARK_CAP constant", () => {
    it("equals 50", () => {
      expect(FREE_BOOKMARK_CAP).toBe(50);
    });
  });

  describe("can()", () => {
    describe("free workspace", () => {
      it.each(allCapabilities)(
        "returns false for capability %s",
        (capability) => {
          expect(service.can(freeWorkspace, capability)).toBe(false);
        },
      );
    });

    describe("personal workspace", () => {
      it.each(personalCapabilities)(
        "returns true for capability %s",
        (capability) => {
          expect(service.can(personalWorkspace, capability)).toBe(true);
        },
      );

      it("returns false for audit-log", () => {
        expect(service.can(personalWorkspace, "audit-log")).toBe(false);
      });
    });

    describe("team workspace", () => {
      it.each(allCapabilities)(
        "returns true for capability %s",
        (capability) => {
          expect(service.can(teamWorkspace, capability)).toBe(true);
        },
      );
    });

    it("returns false for free workspace team-sharing", () => {
      expect(service.can(freeWorkspace, "team-sharing")).toBe(false);
    });

    it("returns false for free workspace unlimited-bookmarks", () => {
      expect(service.can(freeWorkspace, "unlimited-bookmarks")).toBe(false);
    });

    it("returns false for free workspace custom-slug-rules", () => {
      expect(service.can(freeWorkspace, "custom-slug-rules")).toBe(false);
    });

    it("returns false for free workspace workspace-members", () => {
      expect(service.can(freeWorkspace, "workspace-members")).toBe(false);
    });

    it("returns true for personal workspace team-sharing", () => {
      expect(service.can(personalWorkspace, "team-sharing")).toBe(true);
    });

    it("returns true for personal workspace unlimited-bookmarks", () => {
      expect(service.can(personalWorkspace, "unlimited-bookmarks")).toBe(true);
    });

    it("returns true for personal workspace custom-slug-rules", () => {
      expect(service.can(personalWorkspace, "custom-slug-rules")).toBe(true);
    });

    it("returns true for personal workspace workspace-members", () => {
      expect(service.can(personalWorkspace, "workspace-members")).toBe(true);
    });
  });

  describe("assertCan()", () => {
    it("does not throw when personal workspace has capability", () => {
      expect(() => {
        service.assertCan(personalWorkspace, "team-sharing");
      }).not.toThrow();
    });

    it("throws ForbiddenException when free workspace lacks capability", () => {
      expect(() => {
        service.assertCan(freeWorkspace, "team-sharing");
      }).toThrow(ForbiddenException);
    });

    it("throws ForbiddenException with message containing plan name", () => {
      let caught: unknown;
      try {
        service.assertCan(freeWorkspace, "unlimited-bookmarks");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ForbiddenException);
      expect((caught as ForbiddenException).message).toContain("free");
    });

    it("throws ForbiddenException for free workspace custom-slug-rules", () => {
      expect(() => {
        service.assertCan(freeWorkspace, "custom-slug-rules");
      }).toThrow(ForbiddenException);
    });

    it("throws ForbiddenException for free workspace workspace-members", () => {
      expect(() => {
        service.assertCan(freeWorkspace, "workspace-members");
      }).toThrow(ForbiddenException);
    });

    it.each(personalCapabilities)(
      "does not throw for personal workspace capability %s",
      (capability) => {
        expect(() => {
          service.assertCan(personalWorkspace, capability);
        }).not.toThrow();
      },
    );

    it("throws ForbiddenException for personal workspace audit-log", () => {
      expect(() => {
        service.assertCan(personalWorkspace, "audit-log");
      }).toThrow(ForbiddenException);
    });

    it.each(allCapabilities)(
      "does not throw for team workspace capability %s",
      (capability) => {
        expect(() => {
          service.assertCan(teamWorkspace, capability);
        }).not.toThrow();
      },
    );

    it.each(allCapabilities)(
      "throws ForbiddenException for free workspace capability %s",
      (capability) => {
        expect(() => {
          service.assertCan(freeWorkspace, capability);
        }).toThrow(ForbiddenException);
      },
    );
  });

  describe("canCreateBookmark()", () => {
    it("returns true for personal workspace regardless of count", () => {
      expect(service.canCreateBookmark(personalWorkspace, 0)).toBe(true);
      expect(service.canCreateBookmark(personalWorkspace, 50)).toBe(true);
      expect(service.canCreateBookmark(personalWorkspace, 100)).toBe(true);
    });

    it("returns true for free workspace below cap", () => {
      expect(service.canCreateBookmark(freeWorkspace, 0)).toBe(true);
      expect(service.canCreateBookmark(freeWorkspace, 49)).toBe(true);
    });

    it("returns false for free workspace at or over cap", () => {
      expect(service.canCreateBookmark(freeWorkspace, 50)).toBe(false);
      expect(service.canCreateBookmark(freeWorkspace, 51)).toBe(false);
    });
  });

  describe("assertCanCreateBookmark()", () => {
    it("does not throw for personal workspace at high count", () => {
      expect(() => {
        service.assertCanCreateBookmark(personalWorkspace, 100);
      }).not.toThrow();
    });

    it("does not throw for free workspace below cap", () => {
      expect(() => {
        service.assertCanCreateBookmark(freeWorkspace, 49);
      }).not.toThrow();
    });

    it("throws ForbiddenException for free workspace at cap", () => {
      expect(() => {
        service.assertCanCreateBookmark(freeWorkspace, 50);
      }).toThrow(ForbiddenException);
    });

    it("throws ForbiddenException with cap value in message", () => {
      let caught: unknown;
      try {
        service.assertCanCreateBookmark(freeWorkspace, 50);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ForbiddenException);
      expect((caught as ForbiddenException).message).toContain("50");
      expect((caught as ForbiddenException).message).toContain("Upgrade");
    });
  });
});
