import { describe, expect, it } from "vitest";
import { normalizeEmail } from "../../src/index.ts";

describe("normalizeEmail", () => {
  it("trims the address and keeps its case", () => {
    expect(normalizeEmail("  Ada@Example.Test \n")).toBe("Ada@Example.Test");
  });

  it("applies Unicode NFKC, so full-width and compatibility characters name the same address", () => {
    expect(normalizeEmail("ａｄａ＠Example.test")).toBe("ada@Example.test");
    expect(normalizeEmail("ada@example.test")).toBe("ada@example.test");
    // U+FB01 (the "fi" ligature) decomposes under NFKC and not under NFC.
    expect(normalizeEmail("ﬁona@example.test")).toBe("fiona@example.test");
    expect(normalizeEmail("ﬁona@example.test")).not.toBe("ﬁona@example.test".normalize("NFC"));
  });

  it("trims whitespace that only NFKC produces", () => {
    expect(normalizeEmail("ada@example.test　")).toBe("ada@example.test");
  });
});
