import { describe, expect, it } from "vitest";

import { formatDocumentTitle, formatDocumentTitleBrandOnly } from "./format-document-title.js";

describe("formatDocumentTitle", () => {
  it("formats en title with brand first and pipe separator", () => {
    expect(formatDocumentTitle("en", "app.shell.nav.bookmarks")).toBe("SlugBase | Bookmarks");
  });

  it("formats de title with localized page label", () => {
    expect(formatDocumentTitle("de", "app.shell.nav.bookmarks")).toBe("SlugBase | Lesezeichen");
  });

  it("returns brand-only title", () => {
    expect(formatDocumentTitleBrandOnly("en")).toBe("SlugBase");
    expect(formatDocumentTitleBrandOnly("de")).toBe("SlugBase");
  });
});
