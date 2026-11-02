import { ExportDocumentSchema } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import {
  EXPORT_PAGE_SIZE,
  exportFilename,
  exportStream,
  startExport,
  type AuditEventInput,
  type AuditWriter,
  type ExportBookmarkRow,
  type ExportFolderRow,
  type ExportSharedRow,
  type ExportStore,
  type ExportSummary,
} from "../../src/index.ts";

// The export service (doc 02 sections 13.2 and 13.3): it counts what the member owns and records the export before the first byte, then streams the document one page at a
// time, each page read in a transaction of its own.

const ME = "0192F3A0-BBBB-7000-8000-00000000000A";
const WORKSPACE = "0192F3A0-BBBB-7000-8000-0000000000F1";
const AT = new Date("2026-11-02T10:00:00.000Z");

function bookmark(index: number, overrides: Partial<ExportBookmarkRow> = {}): ExportBookmarkRow {
  const id = `0192f3a0-0000-7000-8000-${String(index).padStart(12, "0")}`;
  return { id, url: `https://example.com/${String(index)}`, title: `Bookmark ${String(index)}`, description: null, slug: null, forwarding: false, pinned: false, planArchived: false, folders: [], tags: [], ...overrides };
}

function sharedRow(index: number, overrides: Partial<ExportSharedRow> = {}): ExportSharedRow {
  const id = `0192f3a0-1111-7000-8000-${String(index).padStart(12, "0")}`;
  return { id, url: `https://example.com/theirs/${String(index)}`, title: `Theirs ${String(index)}`, description: null, slug: null, ownerName: "Olga Owner", ...overrides };
}

interface Counters {
  folderPages: number;
  tagPages: number;
  bookmarkPages: number;
  sharedPages: number;
  open: number;
  asked: { what: string; ownerId: string; after: string | undefined; limit: number }[];
}

const counting = (): Counters => ({ folderPages: 0, tagPages: 0, bookmarkPages: 0, sharedPages: 0, open: 0, asked: [] });

function fakeStore(
  data: { summary?: ExportSummary | undefined; folders?: readonly ExportFolderRow[]; tags?: readonly string[]; bookmarks?: readonly ExportBookmarkRow[]; shared?: readonly ExportSharedRow[] },
  counters: Counters,
): ExportStore {
  const folders = data.folders ?? [];
  const tags = data.tags ?? [];
  const bookmarks = data.bookmarks ?? [];
  const shared = data.shared ?? [];
  return {
    summary: (_ownerId, includeShared) =>
      Promise.resolve("summary" in data ? data.summary : { workspaceName: "Home", bookmarks: bookmarks.length, folders: folders.length, tags: tags.length, shared: includeShared ? shared.length : 0 }),
    shared: (accountId, after, limit) => {
      counters.sharedPages += 1;
      counters.asked.push({ what: "shared", ownerId: accountId, after, limit });
      return Promise.resolve(shared.filter((row) => after === undefined || row.id > after).slice(0, limit));
    },
    folders: (ownerId, after, limit) => {
      counters.folderPages += 1;
      counters.asked.push({ what: "folders", ownerId, after, limit });
      return Promise.resolve(folders.filter((row) => after === undefined || row.name > after).slice(0, limit));
    },
    tags: (ownerId, after, limit) => {
      counters.tagPages += 1;
      counters.asked.push({ what: "tags", ownerId, after, limit });
      return Promise.resolve(tags.filter((name) => after === undefined || name > after).slice(0, limit));
    },
    bookmarks: (ownerId, after, limit) => {
      counters.bookmarkPages += 1;
      counters.asked.push({ what: "bookmarks", ownerId, after, limit });
      return Promise.resolve(bookmarks.filter((row) => after === undefined || row.id > after).slice(0, limit));
    },
  };
}

function harness(data: Parameters<typeof fakeStore>[0], options: { pageSize?: number; failOnBookmarkPage?: number; includeShared?: boolean } = {}) {
  const counters = counting();
  const failures: unknown[] = [];
  const store = fakeStore(data, counters);
  const stream = exportStream(
    {
      page: async (read) => {
        counters.open += 1;
        try {
          if (options.failOnBookmarkPage !== undefined && counters.bookmarkPages + 1 === options.failOnBookmarkPage && counters.folderPages > 0 && counters.tagPages > 0) {
            const result = await read({ ...store, bookmarks: () => Promise.reject(new Error("connection lost")) });
            return result;
          }
          return await read(store);
        } finally {
          counters.open -= 1;
        }
      },
      onFailure: (error) => failures.push(error),
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    },
    { accountId: ME, workspaceName: "Home", exportedAt: AT, includeShared: options.includeShared ?? false },
  );
  return { stream, counters, failures };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("the export stream", () => {
  it("writes the document of the format, in the order of the contract, and it parses against the contract's schema", async () => {
    const { stream } = harness({
      folders: [{ name: "Reading", icon: "book", color: 3 }, { name: "Work", icon: "folder", color: 1 }],
      tags: ["news", "tools"],
      bookmarks: [bookmark(1, { slug: "one", forwarding: true, pinned: true, folders: ["Reading"], tags: ["news"], description: "d" }), bookmark(2, { planArchived: true })],
    });
    const text = await drain(stream);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["format", "version", "exportedAt", "workspace", "folders", "tags", "bookmarks", "goPreferences", "shared"]);
    expect(ExportDocumentSchema.parse(JSON.parse(text))).toEqual({
      format: "slugbase-export",
      version: 1,
      exportedAt: "2026-11-02T10:00:00.000Z",
      workspace: { name: "Home" },
      folders: [{ name: "Reading", icon: "book", color: 3 }, { name: "Work", icon: "folder", color: 1 }],
      tags: ["news", "tools"],
      bookmarks: [
        { ref: "b1", url: "https://example.com/1", title: "Bookmark 1", description: "d", slug: "one", forwarding: true, pinned: true, planArchived: false, folders: ["Reading"], tags: ["news"] },
        { ref: "b2", url: "https://example.com/2", title: "Bookmark 2", description: null, slug: null, forwarding: false, pinned: false, planArchived: true, folders: [], tags: [] },
      ],
      goPreferences: [],
      shared: [],
    });
  });

  it("writes a valid document for a member with nothing", async () => {
    const text = await drain(harness({}).stream);
    expect(ExportDocumentSchema.parse(JSON.parse(text))).toMatchObject({ folders: [], tags: [], bookmarks: [], goPreferences: [], shared: [] });
  });

  it("never writes an identifier of the database, and gives the bookmarks refs by position across pages", async () => {
    const bookmarks = Array.from({ length: 7 }, (_, index) => bookmark(index + 1));
    const text = await drain(harness({ bookmarks }, { pageSize: 3 }).stream);
    const parsed = ExportDocumentSchema.parse(JSON.parse(text));
    expect(parsed.bookmarks.map((entry) => entry.ref)).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b7"]);
    expect(text).not.toContain("0192f3a0");
    expect(text).not.toContain('"id"');
  });

  it("is the same document for the same content, whatever the page size", async () => {
    const bookmarks = Array.from({ length: 11 }, (_, index) => bookmark(index + 1, { tags: ["b", "a"].sort() }));
    const folders = ["a", "b", "c", "d"].map((name) => ({ name, icon: "folder", color: 1 }));
    const whole = await drain(harness({ bookmarks, folders, tags: ["x", "y", "z"] }, { pageSize: 500 }).stream);
    const paged = await drain(harness({ bookmarks, folders, tags: ["x", "y", "z"] }, { pageSize: 2 }).stream);
    expect(paged).toBe(whole);
  });

  it("escapes what a title or a name holds, so the document parses whatever the content", async () => {
    const title = 'He said "hi"\n</script> \\ and 😀';
    const text = await drain(harness({ bookmarks: [bookmark(1, { title })], folders: [{ name: 'a"b', icon: "folder", color: 1 }] }).stream);
    const parsed = ExportDocumentSchema.parse(JSON.parse(text));
    expect(parsed.bookmarks[0]?.title).toBe(title);
    expect(parsed.folders[0]?.name).toBe('a"b');
  });

  it("asks every store method for the member only, in the case it is held in, and with the page size", async () => {
    const { stream, counters } = harness({ bookmarks: [bookmark(1)], folders: [{ name: "a", icon: "folder", color: 1 }], tags: ["t"] });
    await drain(stream);
    expect(counters.asked.map((entry) => entry.ownerId)).toEqual([ME.toLowerCase(), ME.toLowerCase(), ME.toLowerCase()]);
    expect(counters.asked.map((entry) => entry.limit)).toEqual([EXPORT_PAGE_SIZE, EXPORT_PAGE_SIZE, EXPORT_PAGE_SIZE]);
  });

  it("holds no transaction between pages, and reads no page before the client asks for it", async () => {
    const bookmarks = Array.from({ length: 50_000 }, (_, index) => bookmark(index + 1));
    const { stream, counters } = harness({ bookmarks });
    const reader = stream.getReader();
    expect(counters.bookmarkPages).toBe(0);

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain('"format":"slugbase-export"');
    expect(counters.bookmarkPages).toBe(0);
    expect(counters.open).toBe(0);

    let chunks = 1;
    let held = 0;
    for (;;) {
      const read = await reader.read();
      if (read.done) {
        break;
      }
      chunks += 1;
      held = Math.max(held, read.value.length);
      expect(counters.open).toBe(0);
      expect(counters.bookmarkPages).toBeLessThanOrEqual(chunks);
    }
    expect(counters.bookmarkPages).toBe(Math.ceil(50_000 / EXPORT_PAGE_SIZE) + 1);
    // 100 pages of 500 bookmarks, and never one chunk that is the whole document
    expect(held).toBeLessThan(500 * 1000);
  });

  it("stops reading when the client goes away", async () => {
    const { stream, counters } = harness({ bookmarks: Array.from({ length: 5_000 }, (_, index) => bookmark(index + 1)) });
    const reader = stream.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    await reader.read();
    const pages = counters.bookmarkPages;
    await reader.cancel();
    expect(counters.bookmarkPages).toBe(pages);
    expect(pages).toBeLessThan(10);
  });

  it("errors the stream when a page cannot be read, so the document is left unfinished and does not parse", async () => {
    const bookmarks = Array.from({ length: 6 }, (_, index) => bookmark(index + 1));
    const { stream, failures } = harness({ bookmarks }, { pageSize: 2, failOnBookmarkPage: 2 });
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
    expect(received).toContain('"bookmarks":[');
    expect(received).not.toContain('"goPreferences"');
    expect(() => {
      JSON.parse(received);
    }).toThrow();
  });
});

describe("the shared list of the export", () => {
  it("holds, for the bookmarks shared with the member, the readable fields and the flag and nothing else, in the order of the identifier across pages, and it parses against the contract's schema", async () => {
    const shared = [sharedRow(1, { description: "About it", slug: "theirs" }), sharedRow(2, { ownerName: null }), sharedRow(3), sharedRow(4), sharedRow(5)];
    const { stream } = harness({ bookmarks: [bookmark(1)], shared }, { includeShared: true, pageSize: 2 });

    const text = await drain(stream);
    const parsed = ExportDocumentSchema.parse(JSON.parse(text));

    expect(parsed.bookmarks.map((entry) => entry.title)).toEqual(["Bookmark 1"]);
    expect(parsed.shared).toEqual([
      { url: "https://example.com/theirs/1", title: "Theirs 1", description: "About it", slug: "theirs", ownerName: "Olga Owner", shared: true },
      { url: "https://example.com/theirs/2", title: "Theirs 2", description: null, slug: null, ownerName: null, shared: true },
      { url: "https://example.com/theirs/3", title: "Theirs 3", description: null, slug: null, ownerName: "Olga Owner", shared: true },
      { url: "https://example.com/theirs/4", title: "Theirs 4", description: null, slug: null, ownerName: "Olga Owner", shared: true },
      { url: "https://example.com/theirs/5", title: "Theirs 5", description: null, slug: null, ownerName: "Olga Owner", shared: true },
    ]);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["format", "version", "exportedAt", "workspace", "folders", "tags", "bookmarks", "goPreferences", "shared"]);
    expect(text).not.toContain("0192f3a0");
  });

  it("is the same document whatever the page size", async () => {
    const shared = Array.from({ length: 9 }, (_, index) => sharedRow(index + 1));
    const whole = await drain(harness({ shared }, { includeShared: true, pageSize: 500 }).stream);
    const paged = await drain(harness({ shared }, { includeShared: true, pageSize: 2 }).stream);
    expect(paged).toBe(whole);
  });

  it("asks the store for the member's shared bookmarks only when it is asked to, and writes an empty list otherwise", async () => {
    const without = harness({ shared: [sharedRow(1)] });
    expect(ExportDocumentSchema.parse(JSON.parse(await drain(without.stream))).shared).toEqual([]);
    expect(without.counters.sharedPages).toBe(0);

    const asking = harness({ shared: [sharedRow(1)] }, { includeShared: true });
    await drain(asking.stream);
    expect(asking.counters.asked.filter((entry) => entry.what === "shared")).toEqual([{ what: "shared", ownerId: ME.toLowerCase(), after: undefined, limit: EXPORT_PAGE_SIZE }]);
  });

  it("writes no field of a row beyond the readable ones, so a store that answered the owner's tags, folders, pin or recipients would still not reach the file", async () => {
    const leaky = { ...sharedRow(1), tags: ["private-tag"], folders: ["Private folder"], pinned: true, forwarding: true, recipients: ["Max Member"], ownerId: "0192f3a0-bbbb-7000-8000-0000000000a1" } as ExportSharedRow;

    const text = await drain(harness({ shared: [leaky] }, { includeShared: true }).stream);

    expect(text).not.toMatch(/private-tag|Private folder|Max Member|recipients|"pinned":true|"forwarding":true|ownerId/);
    expect(ExportDocumentSchema.parse(JSON.parse(text)).shared).toHaveLength(1);
  });

  it("follows the store from page to page, so a bookmark whose share ends during the export is left out of the pages not yet read and none is written twice", async () => {
    const shared = [sharedRow(1), sharedRow(2), sharedRow(3), sharedRow(4)];
    const counters = counting();
    const store = fakeStore({ shared }, counters);
    let pages = 0;
    const stream = exportStream(
      {
        page: (read) => {
          const reading = read({
            ...store,
            shared: async (accountId, after, limit) => {
              pages += 1;
              const rows = await store.shared(accountId, after, limit);
              if (pages === 1) {
                // The share of the third bookmark is revoked after the first page was read.
                shared.splice(2, 1);
              }
              return rows;
            },
          });
          return reading;
        },
        onFailure: () => undefined,
        pageSize: 2,
      },
      { accountId: ME, workspaceName: "Home", exportedAt: AT, includeShared: true },
    );

    const parsed = ExportDocumentSchema.parse(JSON.parse(await drain(stream)));

    expect(parsed.shared.map((entry) => entry.title)).toEqual(["Theirs 1", "Theirs 2", "Theirs 4"]);
  });

  it("errors the stream when a page of shared bookmarks cannot be read, so the document is left unfinished and does not parse", async () => {
    const counters = counting();
    const store = fakeStore({ shared: [sharedRow(1)] }, counters);
    const failures: unknown[] = [];
    const stream = exportStream(
      { page: (read) => read({ ...store, shared: () => Promise.reject(new Error("connection lost")) }), onFailure: (error) => failures.push(error) },
      { accountId: ME, workspaceName: "Home", exportedAt: AT, includeShared: true },
    );
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
    expect(received).toContain('"shared":[');
    expect(() => {
      JSON.parse(received);
    }).toThrow();
  });
});

describe("the start of an export", () => {
  function auditor(): { audit: AuditWriter; written: AuditEventInput[] } {
    const written: AuditEventInput[] = [];
    return {
      written,
      audit: {
        write: (event) => {
          written.push(event);
          return Promise.resolve();
        },
      },
    };
  }

  const ACTOR = { type: "account", accountId: ME, label: "Alex" } as const;

  it("records one export.created event with the counts of what the member owns, plan-archived bookmarks included, and nothing else", async () => {
    const counters = counting();
    const { audit, written } = auditor();
    const outcome = await startExport(
      { store: fakeStore({ summary: { workspaceName: "Home", bookmarks: 12, folders: 3, tags: 4, shared: 0 } }, counters), audit },
      { workspaceId: WORKSPACE, accountId: ME, actor: ACTOR, ipPrefix: "203.0.0.0/16", includeShared: false },
    );
    expect(outcome).toEqual({ kind: "started", summary: { workspaceName: "Home", bookmarks: 12, folders: 3, tags: 4, shared: 0 } });
    expect(written).toEqual([
      { action: "export.created", workspaceId: WORKSPACE.toLowerCase(), actor: ACTOR, metadata: { bookmarks: "12", folders: "3", tags: "4", shared: "0" }, ipPrefix: "203.0.0.0/16" },
    ]);
    expect(counters.asked).toEqual([]);
  });

  it("counts the shared bookmarks in the event only when the export holds them, and asks the store for them only then", async () => {
    const asked: boolean[] = [];
    const store: ExportStore = {
      ...fakeStore({}, counting()),
      summary: (_ownerId, includeShared) => {
        asked.push(includeShared);
        return Promise.resolve({ workspaceName: "Home", bookmarks: 2, folders: 1, tags: 1, shared: includeShared ? 7 : 0 });
      },
    };
    const { audit, written } = auditor();

    await startExport({ store, audit }, { workspaceId: WORKSPACE, accountId: ME, actor: ACTOR, ipPrefix: null, includeShared: true });
    await startExport({ store, audit }, { workspaceId: WORKSPACE, accountId: ME, actor: ACTOR, ipPrefix: null, includeShared: false });

    expect(asked).toEqual([true, false]);
    expect(written.map((event) => event.metadata)).toEqual([
      { bookmarks: "2", folders: "1", tags: "1", shared: "7" },
      { bookmarks: "2", folders: "1", tags: "1", shared: "0" },
    ]);
  });

  it("records nothing when the workspace cannot be read", async () => {
    const counters = counting();
    const { audit, written } = auditor();
    const outcome = await startExport({ store: fakeStore({ summary: undefined }, counters), audit }, { workspaceId: WORKSPACE, accountId: ME, actor: ACTOR, ipPrefix: null, includeShared: false });
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(written).toEqual([]);
  });

  it("does not catch a failure of the audit writer, so the transaction that counted rolls back and no stream starts", async () => {
    const counters = counting();
    const audit: AuditWriter = { write: () => Promise.reject(new Error("insert failed")) };
    await expect(startExport({ store: fakeStore({}, counters), audit }, { workspaceId: WORKSPACE, accountId: ME, actor: ACTOR, ipPrefix: null, includeShared: false })).rejects.toThrow("insert failed");
  });
});

describe("the name of the attachment", () => {
  it("is the UTC day of the export and holds no workspace name", () => {
    expect(exportFilename(new Date("2026-11-02T23:59:59.999Z"))).toBe("slugbase-export-2026-11-02.json");
    expect(exportFilename(new Date("2026-01-05T00:00:00.000Z"))).toBe("slugbase-export-2026-01-05.json");
  });
});
