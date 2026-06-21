import { describe, expect, it } from "vitest";

import { FREE_BOOKMARK_CAP } from "./constants.js";

describe("FREE_BOOKMARK_CAP (spec §12.1)", () => {
  it("matches the product free bookmark cap of 50", () => {
    expect(FREE_BOOKMARK_CAP).toBe(50);
  });
});
