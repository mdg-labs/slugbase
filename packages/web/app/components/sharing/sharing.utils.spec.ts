import { describe, expect, it } from "vitest";

import {
  buildBookmarkListQuery,
  parseSharingScope,
  resolveBookmarkSharingScope,
} from "./sharing.utils.js";

describe("sharing.utils", () => {
  it("parseSharingScope defaults to all for unknown values", () => {
    expect(parseSharingScope(undefined)).toBe("all");
    expect(parseSharingScope("invalid")).toBe("all");
  });

  it("buildBookmarkListQuery includes scope and search params", () => {
    expect(
      buildBookmarkListQuery({
        scope: "shared-with-me",
        q: "docs",
        page: 2,
        pageSize: 24,
        sort: "title-asc",
      }),
    ).toBe("?scope=shared-with-me&q=docs&page=2&pageSize=24&sort=title-asc");
  });

  it("resolveBookmarkSharingScope distinguishes mine, shared-with-me, and shared-by-me", () => {
    expect(resolveBookmarkSharingScope("owner", "owner", 0)).toBe("mine");
    expect(resolveBookmarkSharingScope("owner", "owner", 2)).toBe("shared-by-me");
    expect(resolveBookmarkSharingScope("owner", "other", 0)).toBe("shared-with-me");
  });
});
