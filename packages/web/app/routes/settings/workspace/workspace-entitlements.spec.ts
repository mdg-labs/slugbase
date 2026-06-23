import { describe, expect, it } from "vitest";

import {
  canManageWorkspaceSettings,
  isWorkspaceSectionVisible,
  listVisibleWorkspaceSections,
} from "./workspace-entitlements.js";

describe("workspace-entitlements", () => {
  it("allows OWNER and ADMIN to manage workspace settings", () => {
    expect(canManageWorkspaceSettings("OWNER")).toBe(true);
    expect(canManageWorkspaceSettings("ADMIN")).toBe(true);
    expect(canManageWorkspaceSettings("MEMBER")).toBe(false);
  });

  it("exposes only general and ai workspace sections on hosted Cloud", () => {
    expect(isWorkspaceSectionVisible("general")).toBe(true);
    expect(isWorkspaceSectionVisible("ai")).toBe(true);
    expect(listVisibleWorkspaceSections()).toEqual(["general", "ai"]);
  });

  it("exposes only general and ai workspace sections on CE", () => {
    expect(listVisibleWorkspaceSections()).toEqual(["general", "ai"]);
  });
});
