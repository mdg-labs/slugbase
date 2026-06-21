import { describe, expect, it } from "vitest";

import { hasMinimumRole, isAdminRole } from "./admin-roles.js";

describe("admin roles", () => {
  it("orders viewer < operator < platform_admin", () => {
    expect(hasMinimumRole("viewer", "viewer")).toBe(true);
    expect(hasMinimumRole("viewer", "operator")).toBe(false);
    expect(hasMinimumRole("operator", "platform_admin")).toBe(false);
    expect(hasMinimumRole("platform_admin", "operator")).toBe(true);
    expect(hasMinimumRole("platform_admin", "platform_admin")).toBe(true);
  });

  it("validates known roles", () => {
    expect(isAdminRole("viewer")).toBe(true);
    expect(isAdminRole("workspace_admin")).toBe(false);
  });
});
