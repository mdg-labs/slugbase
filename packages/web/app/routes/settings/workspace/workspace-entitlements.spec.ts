import { describe, expect, it, vi } from "vitest";

import {
  canManageWorkspaceSettings,
  hasAiSuggestionsEntitlement,
  isWorkspaceSectionVisible,
  listVisibleWorkspaceSections,
  resolveActiveWorkspaceRole,
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

  it("resolves active workspace role from workspace list", () => {
    const workspaces = [
      { id: "ws-1", name: "A", plan: "team" as const, role: "MEMBER" as const },
      { id: "ws-2", name: "B", plan: "free" as const, role: "OWNER" as const },
    ];
    expect(resolveActiveWorkspaceRole("ws-1", workspaces)).toBe("MEMBER");
    expect(resolveActiveWorkspaceRole("ws-2", workspaces)).toBe("OWNER");
    expect(resolveActiveWorkspaceRole("missing", workspaces)).toBe("MEMBER");
  });

  it("grants AI entitlement on paid plans when billing is enabled", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "true");
    expect(hasAiSuggestionsEntitlement("personal")).toBe(true);
    expect(hasAiSuggestionsEntitlement("team")).toBe(true);
    expect(hasAiSuggestionsEntitlement("free")).toBe(false);
  });
});
