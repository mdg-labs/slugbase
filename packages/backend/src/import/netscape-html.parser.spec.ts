import { describe, expect, it } from "vitest";

import { parseNetscapeHtml } from "./netscape-html.parser.js";

describe("parseNetscapeHtml", () => {
  it("extracts bookmarks with folder names from nested DL structure", () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3>Work</H3>
  <DL><p>
    <DT><A HREF="https://example.com/docs">Docs</A>
    <DT><A HREF="https://example.com/wiki">Wiki</A>
  </DL><p>
  <DT><A HREF="https://example.com/root">Root Link</A>
</DL><p>`;

    const entries = parseNetscapeHtml(html);
    expect(entries).toEqual([
      {
        title: "Docs",
        url: "https://example.com/docs",
        folders: ["Work"],
      },
      {
        title: "Wiki",
        url: "https://example.com/wiki",
        folders: ["Work"],
      },
      {
        title: "Root Link",
        url: "https://example.com/root",
      },
    ]);
  });

  it("decodes HTML entities in titles and folder names", () => {
    const html = `<DL><p>
  <DT><H3>Dev &amp; Ops</H3>
  <DL><p>
    <DT><A HREF="https://example.com">A &lt;B&gt;</A>
  </DL><p>
</DL><p>`;

    const entries = parseNetscapeHtml(html);
    expect(entries[0]?.title).toBe("A <B>");
    expect(entries[0]?.folders).toEqual(["Dev & Ops"]);
  });

  it("skips anchors without title or url", () => {
    const html = `<DL><p>
  <DT><A HREF="">Empty URL</A>
  <DT><A HREF="https://ok.example.com"></A>
  <DT><A HREF="https://valid.example.com">Valid</A>
</DL><p>`;

    const entries = parseNetscapeHtml(html);
    expect(entries).toEqual([
      {
        title: "Valid",
        url: "https://valid.example.com",
      },
    ]);
  });
});
