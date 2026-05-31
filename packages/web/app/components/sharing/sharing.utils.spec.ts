import { describe, expect, it } from "vitest";

import {
  buildScopedListQuery,
  parseSharingScope,
  resolveResourceSharingScope,
} from "./sharing.utils.js";

describe("sharing.utils", () => {
  it("parseSharingScope defaults to all for unknown values", () => {
    expect(parseSharingScope(undefined)).toBe("all");
    expect(parseSharingScope("invalid")).toBe("all");
  });

  it("buildScopedListQuery includes scope and search params", () => {
    expect(
      buildScopedListQuery({
        scope: "shared-with-me",
        q: "docs",
        page: 2,
        pageSize: 24,
        sort: "title-asc",
      }),
    ).toBe("?scope=shared-with-me&q=docs&page=2&pageSize=24&sort=title-asc");
  });

  it("resolveResourceSharingScope distinguishes mine, shared-with-me, and shared-by-me", () => {
    expect(resolveResourceSharingScope("owner", "owner", 0)).toBe("mine");
    expect(resolveResourceSharingScope("owner", "owner", 2)).toBe("shared-by-me");
    expect(resolveResourceSharingScope("owner", "other", 0)).toBe("shared-with-me");
  });
});
