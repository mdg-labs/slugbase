import { describe, expect, it } from "vitest";
import {
  EntitlementSourceError,
  createBookmarkEntitlements,
  createEntitlementService,
  type AccountEntitlementValues,
  type EntitlementLimit,
  type WorkspaceEntitlementValues,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-aaaa-7000-8000-000000000001";
const ACCOUNT = "0192f3a0-cccc-7000-8000-000000000003";

function valuesWith(bookmarks: unknown): WorkspaceEntitlementValues {
  return {
    "bookmarks.max": bookmarks as EntitlementLimit,
    "seats.max": "unlimited",
    "ai.suggestions": true,
    "sharing.members": true,
    "sharing.teams": true,
    "members.invite": true,
    "teams.manage": true,
    "audit.log": true,
  };
}

function entitlements(bookmarks: unknown, version: number | null = 1) {
  const service = createEntitlementService({
    source: {
      available: true,
      forWorkspace: () => Promise.resolve({ values: valuesWith(bookmarks), upgradeAvailable: false }),
      forAccount: () => Promise.resolve({ "workspaces.ownMax": "unlimited" } as AccountEntitlementValues),
    },
    versions: { read: () => Promise.resolve(version ?? undefined) },
  });
  return createBookmarkEntitlements(service);
}

describe("createBookmarkEntitlements", () => {
  it("reads the workspace's bookmarks.max for a member", async () => {
    expect(await entitlements(2).limit(ACCOUNT, WORKSPACE, {})).toBe(2);
    expect(await entitlements("unlimited").limit(ACCOUNT, WORKSPACE, {})).toBe("unlimited");
    expect(await entitlements(0).limit(ACCOUNT, WORKSPACE, {})).toBe(0);
  });

  it("is undefined for a workspace the account cannot see", async () => {
    expect(await entitlements(2, null).limit(ACCOUNT, WORKSPACE, {})).toBeUndefined();
  });

  it("rejects when the source answers a ceiling outside the catalog, so no creation is granted without one", async () => {
    await expect(entitlements(-1).limit(ACCOUNT, WORKSPACE, {})).rejects.toThrow(EntitlementSourceError);
    await expect(entitlements("a lot").limit(ACCOUNT, WORKSPACE, {})).rejects.toThrow(EntitlementSourceError);
  });
});
