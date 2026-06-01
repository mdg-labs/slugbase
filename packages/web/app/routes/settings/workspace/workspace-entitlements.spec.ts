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

  it("hides SMTP and OIDC when operator-managed interfaces are active", () => {
    const hostedOperator = {
      mailAdminUi: false,
      oidcAdminUi: false,
      aiByoCredential: false,
      billingEnabled: true,
    };
    expect(isWorkspaceSectionVisible("general", hostedOperator)).toBe(true);
    expect(isWorkspaceSectionVisible("ai", hostedOperator)).toBe(true);
    expect(isWorkspaceSectionVisible("smtp", hostedOperator)).toBe(false);
    expect(isWorkspaceSectionVisible("oidc", hostedOperator)).toBe(false);
    expect(listVisibleWorkspaceSections(hostedOperator)).toEqual(["general", "ai"]);
  });

  it("shows all panels when admin UI sources are enabled", () => {
    const selfHosted = {
      mailAdminUi: true,
      oidcAdminUi: true,
      aiByoCredential: true,
      billingEnabled: false,
    };
    expect(listVisibleWorkspaceSections(selfHosted)).toEqual([
      "general",
      "smtp",
      "ai",
      "oidc",
    ]);
  });
});
