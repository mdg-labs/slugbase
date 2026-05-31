import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { BillingProfileService } from "../billing/billing-profile.service.js";
import { EntitlementsService, FREE_BOOKMARK_CAP } from "./entitlements.service.js";
import type { EntitlementCapability } from "./entitlements.service.js";

const freeWorkspace = { plan: "free" as const };
const personalWorkspace = { plan: "personal" as const };
const teamWorkspace = { plan: "team" as const };

const personalCapabilities: EntitlementCapability[] = [
  "unlimited-bookmarks",
  "custom-slug-rules",
];

const teamOnlyCapabilities: EntitlementCapability[] = [
  "team-sharing",
  "team-admin",
  "workspace-members",
  "audit-log",
];

const teamCapabilities: EntitlementCapability[] = [
  ...personalCapabilities,
  ...teamOnlyCapabilities,
];

function createService(planGatingEnabled: boolean): EntitlementsService {
  const billingProfile = {
    isPlanGatingEnabled: vi.fn(() => planGatingEnabled),
  } as unknown as BillingProfileService;
  return new EntitlementsService(billingProfile);
}

describe("EntitlementsService", () => {
  describe("hosted billing — plan gating enabled", () => {
    const service = createService(true);

    describe("FREE_BOOKMARK_CAP constant", () => {
      it("equals 50", () => {
        expect(FREE_BOOKMARK_CAP).toBe(50);
      });
    });

    describe("can()", () => {
      describe("free workspace", () => {
        it.each(teamCapabilities)(
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

        it.each(teamOnlyCapabilities)(
          "returns false for team-only capability %s",
          (capability) => {
            expect(service.can(personalWorkspace, capability)).toBe(false);
          },
        );
      });

      describe("team workspace", () => {
        it.each(teamCapabilities)(
          "returns true for capability %s",
          (capability) => {
            expect(service.can(teamWorkspace, capability)).toBe(true);
          },
        );
      });
    });

    describe("assertCan()", () => {
      it("throws ForbiddenException when personal workspace lacks team-sharing", () => {
        expect(() => {
          service.assertCan(personalWorkspace, "team-sharing");
        }).toThrow(ForbiddenException);
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

      it.each(personalCapabilities)(
        "does not throw for personal workspace capability %s",
        (capability) => {
          expect(() => {
            service.assertCan(personalWorkspace, capability);
          }).not.toThrow();
        },
      );

      it.each(teamOnlyCapabilities)(
        "throws ForbiddenException for personal workspace capability %s",
        (capability) => {
          expect(() => {
            service.assertCan(personalWorkspace, capability);
          }).toThrow(ForbiddenException);
        },
      );

      it.each(teamCapabilities)(
        "does not throw for team workspace capability %s",
        (capability) => {
          expect(() => {
            service.assertCan(teamWorkspace, capability);
          }).not.toThrow();
        },
      );

      it.each(teamCapabilities)(
        "throws ForbiddenException for free workspace capability %s",
        (capability) => {
          expect(() => {
            service.assertCan(freeWorkspace, capability);
          }).toThrow(ForbiddenException);
        },
      );

      it("includes Upgrade to Team in team-only capability errors", () => {
        let caught: unknown;
        try {
          service.assertCan(personalWorkspace, "audit-log");
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ForbiddenException);
        expect((caught as ForbiddenException).message).toContain("Upgrade to Team");
      });
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

      it("throws ForbiddenException for free workspace at cap", () => {
        expect(() => {
          service.assertCanCreateBookmark(freeWorkspace, 50);
        }).toThrow(ForbiddenException);
      });
    });
  });

  describe("self-host billing — plan gating disabled", () => {
    const service = createService(false);

    it.each(teamCapabilities)(
      "allows free workspace capability %s without plan upgrade",
      (capability) => {
        expect(service.can(freeWorkspace, capability)).toBe(true);
        expect(() => {
          service.assertCan(freeWorkspace, capability);
        }).not.toThrow();
      },
    );
  });
});
