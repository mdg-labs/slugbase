import { describe, expect, it } from "vitest";
import { IMPORT_FILE_MAX_BOOKMARKS, IMPORT_FILE_MAX_BYTES, buildImportFiles, buildJsonFile, buildNetscapeFile } from "../src/seed/import-files.ts";

// The files of the import phase of the performance suite (scripts/perf): what they must be for the phase to measure the largest import the API takes, and for an import that fails to be one to be seen.

interface JsonBookmark {
  readonly ref: string;
  readonly url: string;
  readonly slug?: string;
  readonly folders: readonly string[];
  readonly tags: readonly string[];
}

const COLLIDING = ["docs", "gh", "jira"];

describe("the Netscape import file", () => {
  const file = buildNetscapeFile();
  const links = [...file.body.matchAll(/<A HREF="([^"]+)"/g)].map((match) => match[1] ?? "");

  it("has the most links an import takes and is close to, and not over, the largest body", () => {
    expect(IMPORT_FILE_MAX_BOOKMARKS).toBe(5000);
    expect(IMPORT_FILE_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(file.bookmarks).toBe(5000);
    expect(links).toHaveLength(5000);
    expect(file.bytes).toBe(Buffer.byteLength(file.body));
    expect(file.bytes).toBeLessThanOrEqual(IMPORT_FILE_MAX_BYTES);
    expect(file.bytes).toBeGreaterThan(IMPORT_FILE_MAX_BYTES - 4096);
  });

  it("gives every link an address of its own, within the length of a bookmark's, so that none is skipped as a duplicate or refused", () => {
    expect(new Set(links).size).toBe(5000);
    for (const link of links) {
      expect(link.length).toBeLessThanOrEqual(2048);
      expect(link).toMatch(/^https:\/\/netscape\.import\.example\.test\/p\/\d{5}\/a*$/);
    }
  });

  it("files the links in folders and tags them", () => {
    expect(file.body.match(/<H3>/g)).toHaveLength(40);
    expect(file.body.match(/TAGS="import-tag-\d+,import-tag-\d+"/g)).toHaveLength(5000);
  });

  it("is the same bytes on every build and keeps the size when it holds fewer links", () => {
    expect(buildNetscapeFile().body).toBe(file.body);
    const smaller = buildNetscapeFile({ bookmarks: 100 });
    expect(smaller.bookmarks).toBe(100);
    expect(smaller.bytes).toBe(file.bytes);
    expect(smaller.bytes).toBeLessThanOrEqual(IMPORT_FILE_MAX_BYTES);
  });

  it("is refused for a count the import would refuse", () => {
    expect(() => buildNetscapeFile({ bookmarks: 5001 })).toThrow(RangeError);
    expect(() => buildNetscapeFile({ bookmarks: 0 })).toThrow(RangeError);
  });
});

describe("the SlugBase JSON import file", () => {
  const file = buildJsonFile({ collidingSlugs: COLLIDING });
  const document = JSON.parse(file.body) as { format: string; version: number; folders: unknown[]; tags: unknown[]; bookmarks: JsonBookmark[] };

  it("is an export document of 5 000 bookmarks within the largest body", () => {
    expect(document.format).toBe("slugbase-export");
    expect(document.version).toBe(1);
    expect(document.bookmarks).toHaveLength(5000);
    expect(file.bookmarks).toBe(5000);
    expect(file.bytes).toBe(Buffer.byteLength(file.body));
    expect(file.bytes).toBeLessThanOrEqual(IMPORT_FILE_MAX_BYTES);
    expect(document.folders).toHaveLength(40);
    expect(document.tags).toHaveLength(120);
  });

  it("gives every bookmark an address and a ref of its own, a folder and tags", () => {
    expect(new Set(document.bookmarks.map((bookmark) => bookmark.url)).size).toBe(5000);
    expect(new Set(document.bookmarks.map((bookmark) => bookmark.ref)).size).toBe(5000);
    for (const bookmark of document.bookmarks) {
      expect(bookmark.ref).toMatch(/^b[1-9][0-9]*$/);
      expect(bookmark.url).toMatch(/^https:\/\/json\.import\.example\.test\/p\/\d{5}$/);
      expect(bookmark.folders).toHaveLength(1);
      expect(bookmark.tags).toHaveLength(2);
    }
  });

  it("asks for slugs that the import drops: ones the importer holds, ones the file repeats and ones outside the grammar, besides slugs it keeps", () => {
    const slugs = document.bookmarks.flatMap((bookmark) => (bookmark.slug === undefined ? [] : [bookmark.slug]));
    expect(slugs.length).toBeGreaterThan(1500);
    expect(slugs.some((slug) => COLLIDING.includes(slug))).toBe(true);
    expect(slugs.some((slug) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug))).toBe(true);
    expect(slugs.length - new Set(slugs).size).toBeGreaterThan(0);
    expect(new Set(slugs).size).toBeGreaterThan(1000);
  });

  it("asks for no slug of the importer's when it is given none, and is the same bytes on every build", () => {
    const plain = JSON.parse(buildJsonFile().body) as { bookmarks: JsonBookmark[] };
    expect(plain.bookmarks.some((bookmark) => bookmark.slug !== undefined && COLLIDING.includes(bookmark.slug))).toBe(false);
    expect(buildJsonFile({ collidingSlugs: COLLIDING }).body).toBe(file.body);
  });

  it("shares no address with the Netscape file, so that the second import of a run skips nothing", () => {
    const { netscape, json } = buildImportFiles({ collidingSlugs: COLLIDING });
    const addresses = new Set([...netscape.body.matchAll(/<A HREF="([^"]+)"/g)].map((match) => match[1]));
    for (const bookmark of (JSON.parse(json.body) as { bookmarks: JsonBookmark[] }).bookmarks) {
      expect(addresses.has(bookmark.url)).toBe(false);
    }
  });
});
