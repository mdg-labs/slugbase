import { describe, expect, it } from "vitest";

import { msToIso } from "./product-read.service.js";

describe("ProductReadService", () => {
  it("converts epoch milliseconds to ISO-8601 strings", () => {
    const epochMs = Date.UTC(2026, 5, 15, 12, 0, 0);
    expect(msToIso(epochMs)).toBe("2026-06-15T12:00:00.000Z");
  });
});
