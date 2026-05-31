import { describe, expect, it } from "vitest";

import { buildBookmarkListSearch } from "./bookmarks-loader.js";

describe("bookmarks-loader scope queries", () => {
  it("buildBookmarkListSearch forwards scope filters to the API query string", () => {
    expect(
      buildBookmarkListSearch({
        scope: "shared-by-me",
        q: "rust",
        page: 1,
        pageSize: 12,
      }),
    ).toBe("?scope=shared-by-me&q=rust&page=1&pageSize=12");
  });
});
