import { describe, expect, it } from "vitest";

import { parsePageMetadata } from "./metadata-parser.js";

describe("parsePageMetadata", () => {
  it("extracts Open Graph and fallback title fields", () => {
    const html = `<!doctype html>
<html>
  <head>
    <title>Fallback Title</title>
    <meta property="og:title" content="OG Title" />
    <meta property="og:description" content="A useful page" />
    <meta property="og:site_name" content="Example Site" />
    <link rel="icon" href="/assets/icon.png" />
  </head>
</html>`;

    const metadata = parsePageMetadata(html, "https://example.com/docs/page");

    expect(metadata.title).toBe("OG Title");
    expect(metadata.description).toBe("A useful page");
    expect(metadata.siteName).toBe("Example Site");
    expect(metadata.faviconUrl).toBe("https://example.com/assets/icon.png");
  });

  it("falls back to the title tag and default favicon path", () => {
    const html = "<html><head><title>Plain Title</title></head></html>";
    const metadata = parsePageMetadata(html, "https://example.org/");

    expect(metadata.title).toBe("Plain Title");
    expect(metadata.description).toBeNull();
    expect(metadata.faviconUrl).toBe("https://example.org/favicon.ico");
  });
});
