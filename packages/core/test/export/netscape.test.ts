import { describe, expect, it } from "vitest";
import {
  EXPORT_PAGE_SIZE,
  escapeHtml,
  exportNetscapeFilename,
  exportNetscapeStream,
  parseNetscapeBookmarks,
  type NetscapeBookmarkRow,
  type NetscapeExportStore,
  type NetscapeSectionRow,
} from "../../src/index.ts";

// The Netscape export (doc 02 section 13.2, doc 10 T13 and T14): the member's bookmarks as a browser bookmark file, one section per folder, every value escaped. The failure scenario: a title, a folder
// name or a tag that holds markup is written as markup, so the file runs it in a browser or the import reads something other than what the member typed.

const ME = "0192F3A0-BBBB-7000-8000-00000000000A";

function row(index: number, overrides: Partial<NetscapeBookmarkRow> = {}): NetscapeBookmarkRow {
  const id = `0192f3a0-0000-7000-8000-${String(index).padStart(12, "0")}`;
  return { id, url: `https://example.com/${String(index)}`, title: `Bookmark ${String(index)}`, slug: null, tags: [], ...overrides };
}

/** A folder the store holds: its identifier is its position in the list of the test, so the order of the list is the order of the folders. */
const folder = (name: string): string => name;

interface Data {
  readonly folders?: readonly string[];
  /** The bookmarks of each folder by its name. */
  readonly filed?: Readonly<Record<string, readonly NetscapeBookmarkRow[]>>;
  readonly unfiled?: readonly NetscapeBookmarkRow[];
}

interface Counters {
  unfiledPages: number;
  folderPages: number;
  sectionPages: number;
  open: number;
  asked: { what: string; ownerId: string; folderId?: string; after: string | undefined; limit: number }[];
}

const idOfFolder = (position: number): string => `0192f3a0-ffff-7000-8000-${String(position + 1).padStart(12, "0")}`;

function harness(data: Data, options: { pageSize?: number; failOnSectionPage?: number; renameAfterSection?: (names: string[]) => void } = {}) {
  const counters: Counters = { unfiledPages: 0, folderPages: 0, sectionPages: 0, open: 0, asked: [] };
  const failures: unknown[] = [];
  const names = [...(data.folders ?? [])];
  const store: NetscapeExportStore = {
    sections: (ownerId, after, limit) => {
      counters.folderPages += 1;
      counters.asked.push({ what: "sections", ownerId, after, limit });
      const rows: NetscapeSectionRow[] = names.map((name, position) => ({ id: idOfFolder(position), name }));
      return Promise.resolve(rows.filter((entry) => after === undefined || entry.id > after).slice(0, limit));
    },
    folderBookmarks: (ownerId, folderId, after, limit) => {
      counters.sectionPages += 1;
      counters.asked.push({ what: "folderBookmarks", ownerId, folderId, after, limit });
      if (options.failOnSectionPage === counters.sectionPages) {
        return Promise.reject(new Error("connection lost"));
      }
      const position = names.findIndex((_, index) => idOfFolder(index) === folderId);
      // The bookmarks are filed under the name the folder had when the test was set up: a rename moves no bookmark.
      const original = (data.folders ?? [])[position] ?? "";
      const rows = (data.filed?.[original] ?? []).filter((entry) => after === undefined || entry.id > after).slice(0, limit);
      options.renameAfterSection?.(names);
      return Promise.resolve(rows);
    },
    unfiledBookmarks: (ownerId, after, limit) => {
      counters.unfiledPages += 1;
      counters.asked.push({ what: "unfiledBookmarks", ownerId, after, limit });
      return Promise.resolve((data.unfiled ?? []).filter((entry) => after === undefined || entry.id > after).slice(0, limit));
    },
  };
  const stream = exportNetscapeStream(
    {
      page: async (read) => {
        counters.open += 1;
        try {
          return await read(store);
        } finally {
          counters.open -= 1;
        }
      },
      onFailure: (error) => failures.push(error),
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    },
    { accountId: ME },
  );
  return { stream, counters, failures };
}

const drain = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();

const parse = (text: string) => {
  const parsed = parseNetscapeBookmarks(new TextEncoder().encode(text));
  if (parsed.kind !== "parsed") {
    throw new Error("the file did not parse");
  }
  return parsed.bookmarks;
};

describe("the Netscape file", () => {
  it("is a Netscape bookmark file with a flat section for each folder, the bookmarks without a folder at the top level, and a link with its slug and its tags", async () => {
    const { stream } = harness({
      folders: [folder("Reading"), folder("Work")],
      filed: { Reading: [row(2, { slug: "read", tags: ["later", "news"] })], Work: [row(3)] },
      unfiled: [row(1, { slug: "mail" })],
    });

    const text = await drain(stream);

    expect(text.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n")).toBe(true);
    expect(text).toContain('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
    expect(text).toContain('    <DT><A HREF="https://example.com/1" SHORTCUTURL="mail">Bookmark 1</A>\n');
    expect(text).toContain('    <DT><H3>Reading</H3>\n    <DL><p>\n        <DT><A HREF="https://example.com/2" SHORTCUTURL="read" TAGS="later,news">Bookmark 2</A>\n    </DL><p>\n');
    expect(text).toContain('    <DT><H3>Work</H3>\n    <DL><p>\n        <DT><A HREF="https://example.com/3">Bookmark 3</A>\n    </DL><p>\n');
    expect(text.indexOf("Bookmark 1")).toBeLessThan(text.indexOf("<H3>Reading</H3>"));
    expect(text.match(/<H3>/g)).toHaveLength(2);
    expect(text.endsWith("</DL><p>\n")).toBe(true);
  });

  it("writes a folder with no bookmark, and a library with nothing, as a file that parses to no bookmark", async () => {
    const empty = await drain(harness({ folders: [folder("Empty")] }).stream);
    expect(empty).toContain("<H3>Empty</H3>");
    expect(parse(empty)).toEqual([]);
    expect(parse(await drain(harness({}).stream))).toEqual([]);
  });

  it("files a bookmark that is in several folders under each of them, and the import reads it once for each", async () => {
    const shared = row(1, { tags: ["both"] });
    const { stream } = harness({ folders: [folder("A"), folder("B")], filed: { A: [shared], B: [shared] } });

    const bookmarks = parse(await drain(stream));

    expect(bookmarks.map((entry) => [entry.url, entry.folders])).toEqual([
      ["https://example.com/1", ["A"]],
      ["https://example.com/1", ["B"]],
    ]);
  });

  it("escapes a title, an address, a folder name, a tag and a slug that hold markup, in text and in attribute values, and the import reads back the same text", async () => {
    const hostile = [`"><script>alert(1)</script>`, "<img src=x onerror=alert(1)>", `' onmouseover='alert(1)`, "a & b &amp; c &lt;"];
    const { stream } = harness({
      folders: hostile.map(folder),
      filed: Object.fromEntries(hostile.map((name, index) => [name, [row(index + 1, { url: `https://example.com/?q=${encodeURIComponent("x")}&a="${name}"`, title: name, slug: name, tags: [name, "plain"] })]])),
      unfiled: [row(9, { title: hostile[0] ?? "" })],
    });

    const text = await drain(stream);

    expect(text).not.toMatch(/<script|<img/);
    expect(text).not.toMatch(/'/);
    expect(text.replaceAll(/<\/?(?:DT|DL|H1|H3|A|TITLE|META|p)\b[^>]*>/gi, "").replaceAll(/<!DOCTYPE[^>]*>/g, "")).not.toMatch(/[<>]/);
    expect(text).toContain("<H3>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</H3>");
    expect(text).toContain('TAGS="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;,plain"');
    expect(text).toContain('SHORTCUTURL="&#39; onmouseover=&#39;alert(1)"');
    const bookmarks = parse(text);
    expect(bookmarks).toHaveLength(5);
    expect(bookmarks.map((entry) => entry.title).sort()).toEqual([...hostile, hostile[0]].sort());
    for (const entry of bookmarks.filter((candidate) => (candidate.folders ?? []).length === 1)) {
      const name = entry.folders?.[0] ?? "";
      expect(hostile).toContain(name);
      expect(entry.title).toBe(name);
      expect(entry.tags).toEqual([name, "plain"]);
      expect(entry.url).toBe(`https://example.com/?q=x&a="${name}"`);
    }
    expect(bookmarks.find((entry) => (entry.folders ?? []).length === 0)?.title).toBe(hostile[0]);
  });

  it("keeps the bookmarks of a folder that is renamed while its section is being read, and of one renamed to a name before the cursor, and writes the name each was read with", async () => {
    let renamed = false;
    const { stream } = harness(
      { folders: ["Beta", "Gamma"], filed: { Beta: [row(1), row(2), row(3)], Gamma: [row(4)] } },
      {
        pageSize: 1,
        renameAfterSection: (names) => {
          if (!renamed) {
            renamed = true;
            names[0] = "Zulu";
            names[1] = "Aardvark";
          }
        },
      },
    );

    const text = await drain(stream);

    expect(text).toContain("<H3>Beta</H3>");
    expect(text).toContain("<H3>Aardvark</H3>");
    expect(text).not.toContain("Zulu");
    expect(parse(text).map((entry) => [entry.url, entry.folders])).toEqual([
      ["https://example.com/1", ["Beta"]],
      ["https://example.com/2", ["Beta"]],
      ["https://example.com/3", ["Beta"]],
      ["https://example.com/4", ["Aardvark"]],
    ]);
    expect(text.endsWith("</DL><p>\n</DL><p>\n")).toBe(true);
  });

  it("ends a section whose folder is gone with the bookmarks read so far, and goes on with the next folder", async () => {
    const { stream } = harness({ folders: ["A", "B"], filed: { B: [row(2)] } });
    const text = await drain(stream);

    expect(parse(text).map((entry) => [entry.url, entry.folders])).toEqual([["https://example.com/2", ["B"]]]);
  });

  it("escapes the five characters and nothing else", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml("plain text, ünïcödé 日本")).toBe("plain text, ünïcödé 日本");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("asks the store for the member only, in the case it is held in, and with the page size", async () => {
    const { stream, counters } = harness({ folders: [folder("A")], filed: { A: [row(1)] }, unfiled: [row(2)] });
    await drain(stream);

    expect(counters.asked.map((entry) => entry.what)).toEqual(["unfiledBookmarks", "sections", "folderBookmarks"]);
    expect(new Set(counters.asked.map((entry) => entry.ownerId))).toEqual(new Set([ME.toLowerCase()]));
    expect(counters.asked.map((entry) => entry.limit)).toEqual([EXPORT_PAGE_SIZE, EXPORT_PAGE_SIZE, EXPORT_PAGE_SIZE]);
    expect(counters.asked.find((entry) => entry.what === "folderBookmarks")?.folderId).toBe(idOfFolder(0));
  });

  it("is the same file whatever the page size, with every bookmark once", async () => {
    const data: Data = {
      folders: [folder("A"), folder("B"), folder("C")],
      filed: { A: [1, 2, 3, 4, 5].map((n) => row(n)), B: [6].map((n) => row(n)), C: [] },
      unfiled: [7, 8, 9].map((n) => row(n)),
    };
    const whole = await drain(harness(data).stream);

    for (const pageSize of [1, 2, 3, 100]) {
      expect(await drain(harness(data, { pageSize }).stream), String(pageSize)).toBe(whole);
    }
  });

  it("holds no transaction between pages, and reads no page after the first piece before the client asks for it", async () => {
    const unfiled = Array.from({ length: 5_000 }, (_, index) => row(index + 1));
    const { stream, counters } = harness({ folders: [folder("Late")], filed: { Late: [row(9_000)] }, unfiled });
    const reader = stream.getReader();
    expect(counters.unfiledPages).toBe(0);

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("<!DOCTYPE NETSCAPE-Bookmark-file-1>");
    expect(counters.unfiledPages).toBe(0);
    expect(counters.open).toBe(0);

    let chunks = 1;
    for (;;) {
      const read = await reader.read();
      if (read.done) {
        break;
      }
      chunks += 1;
      expect(counters.open).toBe(0);
      expect(counters.unfiledPages + counters.folderPages + counters.sectionPages).toBeLessThanOrEqual(chunks);
    }
    expect(counters.unfiledPages).toBe(Math.ceil(5_000 / EXPORT_PAGE_SIZE) + 1);
    expect(counters.sectionPages).toBe(1);
  });

  it("delivers the first bookmarks before the section of the last folder is read, and stops reading when the client goes away", async () => {
    const folders = Array.from({ length: 4 }, (_, index) => folder(`F${String(index)}`));
    const filed = Object.fromEntries(folders.map((name, index) => [name, [row(index + 1)]]));
    const { stream, counters } = harness({ folders, filed, unfiled: [row(100)] }, { pageSize: 1 });
    const reader = stream.getReader();
    let received = "";
    const decoder = new TextDecoder();
    while (!received.includes("example.com/100")) {
      received += decoder.decode((await reader.read()).value, { stream: true });
    }
    expect(counters.sectionPages).toBe(0);
    expect(received).not.toContain("<H3>");
    await reader.read();
    await reader.read();
    await reader.cancel();
    const pages = counters.sectionPages;
    expect(pages).toBeLessThan(folders.length);
    expect(counters.sectionPages).toBe(pages);
  });

  it("errors the stream when a page cannot be read, so the file ends before its closing list and the failure is told", async () => {
    const { stream, failures } = harness({ folders: [folder("A"), folder("B")], filed: { A: [row(1)], B: [row(2)] } }, { failOnSectionPage: 2 });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let received = "";
    let failure: unknown;
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) {
          break;
        }
        received += decoder.decode(read.value, { stream: true });
      }
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failures).toHaveLength(1);
    expect(received).toContain("<H3>B</H3>");
    expect(received.endsWith("</DL><p>\n</DL><p>\n")).toBe(false);
    expect(received).not.toContain("example.com/2");
  });
});

describe("the name of the Netscape attachment", () => {
  it("is the UTC day of the export with the extension of the file", () => {
    expect(exportNetscapeFilename(new Date("2026-11-02T23:59:59.999Z"))).toBe("slugbase-export-2026-11-02.html");
    expect(exportNetscapeFilename(new Date("2026-11-03T00:00:00.000Z"))).toBe("slugbase-export-2026-11-03.html");
  });
});
