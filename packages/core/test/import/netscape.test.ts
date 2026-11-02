import { readFileSync } from "node:fs";
import { IMPORT_MAX_BOOKMARKS, type ImportFileBookmark } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import { parseNetscapeBookmarks, previewImport, readImportBookmark, type ImportPreviewStore } from "../../src/index.ts";

// The reader of a browser's bookmark file (doc 02 section 13.1, doc 10 T13): the structure each browser writes, and the files that are meant to hurt it. The failure scenario: a file the reader
// must not trust (unclosed and nested tags, a 5 MiB line, a million nested lists, entity bombs, NUL bytes, scripts and bookmarklets) is read in bounded time and memory, to the bookmarks it
// really lists as plain text, and never throws.

const encode = (html: string): Uint8Array => new TextEncoder().encode(html);
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../fixtures/import/netscape/${name}.html`, import.meta.url)));

function parsed(html: string | Uint8Array): readonly ImportFileBookmark[] {
  const outcome = parseNetscapeBookmarks(typeof html === "string" ? encode(html) : html);
  if (outcome.kind !== "parsed") {
    throw new Error(`the file was ${outcome.kind}`);
  }
  return outcome.bookmarks;
}

/** A store that has nothing, with the names told apart by case as the database's `citext` columns do. */
const empty: ImportPreviewStore = {
  bookmarkCount: () => Promise.resolve(0),
  existingCanonicalUrls: () => Promise.resolve(new Set()),
  existingSlugs: () => Promise.resolve(new Set()),
  existingFolderNames: () => Promise.resolve(new Set()),
  existingTagNames: () => Promise.resolve(new Set()),
  firstSameNames: (names) => {
    const firsts = new Map<string, number>();
    return Promise.resolve(names.map((name, index) => firsts.get(name.toLowerCase()) ?? (firsts.set(name.toLowerCase(), index), index)));
  },
};

async function previewed(bookmarks: readonly ImportFileBookmark[]) {
  const outcome = await previewImport({ store: empty }, { file: [...bookmarks], skipDuplicates: true, ceiling: "unlimited" });
  if (outcome.kind !== "previewed") {
    throw new Error(`the preview was ${outcome.kind}`);
  }
  return outcome.result;
}

const MIB = 1024 * 1024;

describe("the file of each browser", () => {
  it("reads Chrome's: the bookmarks bar and its folders, a bookmarklet that is failed, and an empty title that takes the host", async () => {
    const bookmarks = parsed(fixture("chrome"));

    expect(bookmarks).toEqual([
      { url: "https://example.com/chrome/one", title: "Chrome One", folders: ["Bookmarks bar"], tags: [] },
      { url: "https://example.com/chrome/two?a=1&b=2", title: "Chrome & Two", folders: ["Reading"], tags: [] },
      { url: "javascript:void(window.open('https://example.com/'))", title: "A bookmarklet", folders: ["Reading"], tags: [] },
      { url: "https://example.com/chrome/three", title: "", folders: ["Other bookmarks"], tags: [] },
    ]);
    expect(readImportBookmark(bookmarks[3] ?? { url: "" }, 4)).toMatchObject({ title: "example.com" });
    const result = await previewed(bookmarks);
    expect(result.detected).toEqual({ bookmarks: 4, folders: 3, tags: 0 });
    expect(result.created).toBe(3);
    expect(result.failed).toEqual([{ position: 3, title: "A bookmarklet", url: "javascript:void(window.open('https://example.com/'))", reason: "url_not_allowed" }]);
  });

  it("reads Edge's: the favorites bar, folders inside folders by their own name, an empty folder that is not a folder of any bookmark, and a browser address that is failed", async () => {
    const bookmarks = parsed(fixture("edge"));

    expect(bookmarks.map((bookmark) => [bookmark.url, bookmark.folders])).toEqual([
      ["https://example.com/edge/one", ["Favorites bar"]],
      ["https://example.com/edge/two", ["Projects"]],
      ["https://example.com/edge/three", ["Projects"]],
      ["edge://settings/", ["Other favorites"]],
    ]);
    const result = await previewed(bookmarks);
    expect(result.detected).toEqual({ bookmarks: 4, folders: 3, tags: 0 });
    expect(result.failed.map((entry) => [entry.position, entry.reason])).toEqual([[4, "url_not_allowed"]]);
    // The folder of a link that is failed is not made.
    expect(result.foldersCreated).toBe(2);
  });

  it("reads Firefox's: TAGS split at commas, SHORTCUTURL and the descriptions in DD left alone, a rule, and a place: query that is failed", async () => {
    const bookmarks = parsed(fixture("firefox"));

    expect(bookmarks).toEqual([
      { url: "https://example.com/firefox/one", title: "Firefox One", folders: ["Bookmarks Toolbar"], tags: ["news", "tech"] },
      { url: "place:parent=1234&queryType=1&sort=12&maxResults=10&excludeQueries=1", title: "Recent Tags", folders: ["Bookmarks Toolbar"], tags: [] },
      { url: "https://example.com/firefox/two", title: "Firefox Two", folders: ["Other Bookmarks"], tags: ["news"] },
      { url: "https://example.com/firefox/three", title: "Firefox Three", folders: ["Other Bookmarks"], tags: [] },
    ]);
    const result = await previewed(bookmarks);
    expect(result.detected).toEqual({ bookmarks: 4, folders: 2, tags: 2 });
    expect(result.failed.map((entry) => [entry.position, entry.reason])).toEqual([[2, "url_not_allowed"]]);
    expect(result.tagsCreated).toBe(2);
  });

  it("reads Safari's: FOLDED and ID attributes, and folders inside a folder that has no link of its own", async () => {
    const bookmarks = parsed(fixture("safari"));

    expect(bookmarks).toEqual([
      { url: "https://example.com/safari/one", title: "Safari One", folders: ["Favorites"], tags: [] },
      { url: "https://example.com/safari/two", title: "Safari Two", folders: ["Favorites"], tags: [] },
      { url: "https://example.com/safari/three", title: "Safari Three", folders: ["Recipes"], tags: [] },
    ]);
    const result = await previewed(bookmarks);
    expect(result.detected).toEqual({ bookmarks: 3, folders: 2, tags: 0 });
    expect(result.failed).toEqual([]);
    expect(result.created).toBe(3);
  });
});

describe("what a link and a folder are", () => {
  it("files a link by the innermost folder that names its list, a link outside any folder by none, and a list nobody names by the folder around it", () => {
    const bookmarks = parsed(
      '<DL><DT><A HREF="https://e.test/root">Root</A><DT><H3>A</H3><DL><DT><A HREF="https://e.test/a">In A</A><DT><H3>B</H3><DL><DT><A HREF="https://e.test/b">In B</A></DL>' +
        '<DL><DT><A HREF="https://e.test/anonymous">Anonymous list</A></DL><DT><A HREF="https://e.test/a2">Back in A</A></DL><DT><A HREF="https://e.test/root2">Root again</A></DL>',
    );

    expect(bookmarks.map((bookmark) => [bookmark.title, bookmark.folders])).toEqual([
      ["Root", []],
      ["In A", ["A"]],
      ["In B", ["B"]],
      ["Anonymous list", ["A"]],
      ["Back in A", ["A"]],
      ["Root again", []],
    ]);
  });

  it("takes the text of a title and a folder name as plain text: references decoded once, whitespace made one space, markup left out", () => {
    const [bookmark] = parsed(
      '<DL><DT><H3>  Tom &amp;\n  Jerry &amp;amp; Co  </H3><DL><DT><A HREF="https://e.test/?a=1&amp;b=2&#x26;c=3">Line one\r\n   line two <B>bold</B> &lt;i&gt;x&lt;/i&gt; &#65;&nbsp;&bogus;</A></DL></DL>',
    );

    expect(bookmark).toEqual({ url: "https://e.test/?a=1&b=2&c=3", title: "Line one line two bold <i>x</i> A &bogus;", folders: ["Tom & Jerry &amp; Co"], tags: [] });
  });

  it("splits TAGS at commas, trims each, drops the empty ones, and keeps at most 1 000 of them", () => {
    const [bookmark] = parsed('<DL><DT><A HREF="https://e.test/" TAGS=" a ,b,, c d ,&amp;">x</A></DL>');
    const [many] = parsed(`<DL><DT><A HREF="https://e.test/" TAGS="${Array.from({ length: 5000 }, (_value, index) => `t${String(index)}`).join(",")}">x</A></DL>`);

    expect(bookmark?.tags).toEqual(["a", "b", "c d", "&"]);
    expect(many?.tags).toHaveLength(1000);
    expect(many?.tags?.[999]).toBe("t999");
  });

  it("ends a title where the next entry begins, so a link whose end tag is missing does not take the entries after it", () => {
    const bookmarks = parsed('<DL><DT><A HREF="https://e.test/1">One<DT><A HREF="https://e.test/2">Two<DD>A description<DT><A HREF="https://e.test/3">Three</DL>');

    expect(bookmarks.map((bookmark) => bookmark.title)).toEqual(["One", "Two", "Three"]);
  });

  it("keeps the title of a link the file ends in, and a link with an HREF of any case, quoted or not; an anchor with no HREF is no bookmark", () => {
    const bookmarks = parsed('<dl><dt><a name="x">An anchor</a><dt><a href=https://e.test/bare>Bare</a><dt><A HrEf=\'https://e.test/single\'>Single</A><dt><A HREF="">Empty</A><dt><A HREF="https://e.test/last">Last');

    expect(bookmarks.map((bookmark) => [bookmark.url, bookmark.title])).toEqual([
      ["https://e.test/bare", "Bare"],
      ["https://e.test/single", "Single"],
      ["", "Empty"],
      ["https://e.test/last", "Last"],
    ]);
    expect(readImportBookmark(bookmarks[2] ?? { url: "x" }, 3)).toMatchObject({ reason: "url_invalid" });
  });

  it("reads a quoted attribute that holds a > and an A that is the first thing in the file", () => {
    expect(parsed('<A HREF="https://e.test/?q=a>b" TAGS="x>y">T</A>')).toEqual([{ url: "https://e.test/?q=a>b", title: "T", folders: [], tags: ["x>y"] }]);
  });

  it("reads a file with no bookmarks, an empty file and bytes that are not UTF-8 without failing", () => {
    expect(parsed("")).toEqual([]);
    expect(parsed("<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p></DL><p>")).toEqual([]);
    expect(parsed(new Uint8Array([0xff, 0xfe, 0x3c, 0x41, 0x20, 0x48, 0x52, 0x45, 0x46, 0x3d, 0x22, 0x78, 0x22, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x41, 0x3e]))).toEqual([
      { url: "x", title: "�(", folders: [], tags: [] },
    ]);
    expect(parsed(new Uint8Array([0xef, 0xbb, 0xbf, ...encode('<A HREF="https://e.test/">BOM</A>')]))).toEqual([{ url: "https://e.test/", title: "BOM", folders: [], tags: [] }]);
  });
});

describe("a file that is meant to hurt", () => {
  it("never reads what a comment, a script, a style or a title element holds as a link, and never runs it", () => {
    const bookmarks = parsed(
      '<TITLE><A HREF="https://e.test/title">no</A></TITLE><!-- <A HREF="https://e.test/comment">no</A> -->' +
        '<SCRIPT>document.write(\'<A HREF="https://e.test/script">no</A>\')</SCRIPT><STYLE><A HREF="https://e.test/style">no</A></STYLE>' +
        '<DL><DT><A HREF="https://e.test/yes">Yes<SCRIPT>alert(1)</SCRIPT> really</A></DL>',
    );

    expect(bookmarks).toEqual([{ url: "https://e.test/yes", title: "Yes really", folders: [], tags: [] }]);
  });

  it("keeps a script-laden title as the text it is, and fails a javascript, data, vbscript or file link however its scheme is spelled", async () => {
    const hrefs = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "&#106;avascript:alert(1)", "jav&#x09;ascript:alert(1)", " java\u0000script:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "file:///etc/passwd", "ftp://e.test/"];
    const bookmarks = parsed(
      `<DL><DT><A HREF="https://e.test/ok">&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;</A>${hrefs.map((href, index) => `<DT><A HREF="${href}">${String(index)}</A>`).join("")}</DL>`,
    );
    const result = await previewed(bookmarks);

    expect(bookmarks[0]?.title).toBe("<script>alert(1)</script><img src=x onerror=alert(1)>");
    expect(result.created).toBe(1);
    expect(result.failed.map((entry) => entry.reason)).toEqual(hrefs.map(() => "url_not_allowed"));
  });

  it("ends bounded on unclosed and nested tags: an unclosed quote, comment, tag, title and link, and every link inside the last", () => {
    const [kept] = parsed('<DL><DT><A HREF="https://e.test/kept">Kept</A>');

    expect(kept?.url).toBe("https://e.test/kept");
    for (const tail of ['<A HREF="https://e.test/x', "<!-- never closed", "<A HREF=", "<TITLE>never closed", "<SCRIPT>never closed", "<", "</", "<!", "<A", '<A HREF="a" TAGS=\'b']) {
      expect(parsed(`<DL><DT><A HREF="https://e.test/kept">Kept</A>${tail}`).map((bookmark) => bookmark.url)).toContain("https://e.test/kept");
    }
    expect(parsed('<A HREF="https://e.test/1"><A HREF="https://e.test/2"><A HREF="https://e.test/3"><B><B><B>').map((bookmark) => bookmark.url)).toEqual(["https://e.test/1", "https://e.test/2", "https://e.test/3"]);
  });

  it("reads a million nested lists without recursion, files the links under the deepest name it keeps, and ends with the stack as it began", () => {
    const depth = 1_000_000;
    const bookmarks = parsed(`<DL><DT><H3>Top</H3>${"<DL>".repeat(depth)}<DT><A HREF="https://e.test/deep">Deep</A>${"</DL>".repeat(depth)}</DL><DT><A HREF="https://e.test/after">After</A>`);

    expect(bookmarks.map((bookmark) => [bookmark.url, bookmark.folders])).toEqual([
      ["https://e.test/deep", ["Top"]],
      ["https://e.test/after", []],
    ]);
  }, 20_000);

  it("reads 100 000 nested folders, each with its own name, and 100 000 lists that are never closed", () => {
    const nested = parsed(`${Array.from({ length: 100_000 }, (_value, index) => `<DT><H3>F${String(index)}</H3><DL>`).join("")}<DT><A HREF="https://e.test/leaf">Leaf</A>`);
    const unclosed = parsed(`${"<DL><DT><H3>x</H3>".repeat(100_000)}<DT><A HREF="https://e.test/x">x</A>`);

    expect(nested).toHaveLength(1);
    expect(nested[0]?.folders?.[0]).toMatch(/^F\d+$/);
    expect(unclosed).toEqual([{ url: "https://e.test/x", title: "x", folders: ["x"], tags: [] }]);
  }, 30_000);

  it("reads a 5 MiB single line: one huge title, one huge address, one huge folder name and 5 MiB of text with no tag, to values that are bounded", () => {
    const title = parsed(`<DL><DT><A HREF="https://e.test/">${"a".repeat(5 * MIB)}</A></DL>`);
    const address = parsed(`<DL><DT><A HREF="https://e.test/${"a".repeat(5 * MIB)}">x</A></DL>`);
    const folder = parsed(`<DL><DT><H3>${"f".repeat(5 * MIB)}</H3><DL><DT><A HREF="https://e.test/">x</A></DL></DL>`);
    const text = parsed("t".repeat(5 * MIB));

    expect(title[0]?.title?.length).toBeLessThanOrEqual(4096);
    expect(readImportBookmark(address[0] ?? { url: "" }, 1)).toMatchObject({ reason: "url_invalid" });
    expect(folder[0]?.folders?.[0]?.length).toBeLessThanOrEqual(4096);
    expect(text).toEqual([]);
  }, 30_000);

  it("reads an entity bomb once: references are decoded a single time and a long run of them is cut like any text", () => {
    const bomb = "&amp;".repeat(MIB);
    const [bookmark] = parsed(`<DL><DT><H3>${bomb}</H3><DL><DT><A HREF="https://e.test/" TAGS="${bomb}">${bomb}</A></DL></DL>`);
    const nested = parsed('<DL><DT><A HREF="https://e.test/">&amp;lt;script&amp;gt;&amp;#38;amp;</A></DL>')[0];

    expect(bookmark?.title?.length).toBeLessThanOrEqual(4096);
    expect(bookmark?.title).toMatch(/^&+$/);
    expect(bookmark?.tags).toHaveLength(1);
    expect(nested?.title).toBe("&lt;script&gt;&#38;amp;");
    expect(parsed(`<DL><DT><A HREF="https://e.test/">${"&#x10FFFF;&#0;&#xD800;&#99999999;&#x110000;".repeat(100_000)}</A></DL>`)).toHaveLength(1);
  }, 30_000);

  it("drops NUL bytes everywhere, so a tag, an attribute or a scheme cannot be split by one", () => {
    const bookmarks = parsed('<DL><DT><A\u0000 HREF="https://e.test/\u0000x" TA\u0000GS="a\u0000,b">T\u0000itle</A></DL>\u0000'.repeat(2));

    expect(bookmarks).toEqual([
      { url: "https://e.test/x", title: "Title", folders: [], tags: ["a", "b"] },
      { url: "https://e.test/x", title: "Title", folders: [], tags: ["a", "b"] },
    ]);
  });

  it("refuses a file of more than 5 000 links, and reads one of exactly 5 000, without reading past the first one over", () => {
    const links = (count: number): string => `<DL>${Array.from({ length: count }, (_value, index) => `<DT><A HREF="https://e.test/${String(index)}">${String(index)}</A>`).join("")}</DL>`;

    expect(parseNetscapeBookmarks(encode(links(IMPORT_MAX_BOOKMARKS)))).toMatchObject({ kind: "parsed" });
    expect(parseNetscapeBookmarks(encode(links(IMPORT_MAX_BOOKMARKS + 1)))).toEqual({ kind: "too_many" });
    expect(parseNetscapeBookmarks(encode(`<DL>${'<DT><A HREF="x">y</A>'.repeat(1_000_000)}</DL>`))).toEqual({ kind: "too_many" });
    // An anchor that is no link does not count, however many there are.
    expect(parseNetscapeBookmarks(encode(`<DL>${'<A NAME="x">y</A>'.repeat(10_000)}</DL>`))).toEqual({ kind: "parsed", bookmarks: [] });
  }, 30_000);

  it("reads tags that are 5 MiB of attributes, and a tag with thousands of attributes, in bounded time", () => {
    const attributes = Array.from({ length: 100_000 }, (_value, index) => `a${String(index)}="v"`).join(" ");

    expect(parsed(`<DL><DT><A ${attributes} HREF="https://e.test/late">x</A></DL>`)).toEqual([]);
    expect(parsed(`<DL><DT><A HREF="https://e.test/early" ${attributes}>x</A></DL>`)).toHaveLength(1);
    expect(parsed(`<A ${"<".repeat(5 * MIB)}`)).toEqual([]);
    expect(() => parsed("<A HREF=".repeat(MIB / 4))).not.toThrow();
  }, 30_000);
});
