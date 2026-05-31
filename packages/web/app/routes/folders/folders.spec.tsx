import { describe, expect, it } from "vitest";

import { buildFolderListSearch } from "./folders-loader.js";

describe("folders-loader scope queries", () => {
  it("buildFolderListSearch forwards scope filters to the API query string", () => {
    expect(
      buildFolderListSearch({
        scope: "shared-with-me",
        q: "reading",
        page: 1,
        pageSize: 12,
      }),
    ).toBe("?scope=shared-with-me&q=reading&page=1&pageSize=12");
  });
});
