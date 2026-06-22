import { describe, expect, it } from "vitest";

import {
  canManageWorkspaceSettings,
  isOperatorManagedWorkspaceSection,
  isWorkspaceSectionVisible,
  listVisibleWorkspaceSections,
} from "./workspace-entitlements.js";

describe("workspace-entitlements", () => {
  it("allows OWNER and ADMIN to manage workspace settings", () => {
    expect(canManageWorkspaceSettings("OWNER")).toBe(true);
    expect(canManageWorkspaceSettings("ADMIN")).toBe(true);
    expect(canManageWorkspaceSettings("MEMBER")).toBe(false);
  });

  it("hides SMTP and OIDC on hosted Cloud when operator-managed", () => {
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
    expect(isOperatorManagedWorkspaceSection("smtp", hostedOperator)).toBe(true);
    expect(isOperatorManagedWorkspaceSection("oidc", hostedOperator)).toBe(true);
  });

  it("shows gate-only SMTP and OIDC sections on CE when operator-managed", () => {
    const ceOperator = {
      mailAdminUi: false,
      oidcAdminUi: false,
      aiByoCredential: false,
      billingEnabled: false,
    };
    expect(isWorkspaceSectionVisible("smtp", ceOperator)).toBe(true);
    expect(isWorkspaceSectionVisible("oidc", ceOperator)).toBe(true);
    expect(listVisibleWorkspaceSections(ceOperator)).toEqual([
      "general",
      "smtp",
      "ai",
      "oidc",
    ]);
    expect(isOperatorManagedWorkspaceSection("smtp", ceOperator)).toBe(true);
    expect(isOperatorManagedWorkspaceSection("oidc", ceOperator)).toBe(true);
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
    expect(isOperatorManagedWorkspaceSection("smtp", selfHosted)).toBe(false);
    expect(isOperatorManagedWorkspaceSection("oidc", selfHosted)).toBe(false);
  });
});
