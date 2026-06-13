import { describe, expect, it } from "vitest";

import {
  BOOKMARK_GLYPH_COLORS,
  bookmarkGlyphBorderRadius,
  bookmarkGlyphFontSize,
  getBookmarkGlyphColor,
  getBookmarkHostname,
  getBookmarkMonogramInitials,
} from "./bookmark-glyph.js";

describe("getBookmarkHostname", () => {
  it("strips www prefix from valid URLs", () => {
    expect(getBookmarkHostname("https://www.example.com/path")).toBe("example.com");
  });

  it("returns raw input when URL parsing fails", () => {
    expect(getBookmarkHostname("not-a-url")).toBe("not-a-url");
  });
});

describe("getBookmarkGlyphColor", () => {
  it("returns a deterministic color from the prototype palette", () => {
    const color = getBookmarkGlyphColor("https://react.dev");
    expect(BOOKMARK_GLYPH_COLORS).toContain(color);
    expect(getBookmarkGlyphColor("https://react.dev")).toBe(color);
  });

  it("hashes by hostname first character", () => {
    expect(getBookmarkGlyphColor("https://example.com")).toBe(
      BOOKMARK_GLYPH_COLORS["example.com".charCodeAt(0) % BOOKMARK_GLYPH_COLORS.length],
    );
  });
});

describe("getBookmarkMonogramInitials", () => {
  it("returns ? for empty titles", () => {
    expect(getBookmarkMonogramInitials("   ")).toBe("?");
  });

  it("uses first alphanumeric from first two words", () => {
    expect(getBookmarkMonogramInitials("React 19 — useOptimistic")).toBe("R1");
    expect(getBookmarkMonogramInitials("The Rust Performance Book")).toBe("TR");
  });

  it("adds a second letter from a single word when available", () => {
    expect(getBookmarkMonogramInitials("Excalidraw")).toBe("EX");
  });

  it("skips non-alphanumeric characters within words", () => {
    expect(getBookmarkMonogramInitials("— Lucide icons")).toBe("LI");
  });
});

describe("bookmark glyph sizing helpers", () => {
  it("uses larger radius for bigger badges", () => {
    expect(bookmarkGlyphBorderRadius(32)).toBe(6);
    expect(bookmarkGlyphBorderRadius(22)).toBe(4);
  });

  it("scales font size down for two-letter monograms", () => {
    expect(bookmarkGlyphFontSize(32, "EX")).toBeLessThan(bookmarkGlyphFontSize(32, "E"));
  });
});
