import type { ImportRequest } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import { createAuditWriter, IMPORT_BATCH_SIZE, importBookmarks, type AuditRecord, type ImportAsk, type ImportFolderToResolve, type ImportLinks, type ImportNewBookmark, type ImportPlaces, type ImportStore, type ImportTagToResolve } from "../../src/index.ts";

// The import that writes (doc 02 section 13.1, doc 01 section 7.5, doc 10 T11 and T13): what the service asks of the store, in which order, and what it writes when a step fails.

interface Written {
  readonly takes: { ceiling: number | null; wanted: number }[];
  readonly batches: { bookmarks: readonly ImportNewBookmark[]; events: readonly { eventId: string; name: string; payload: unknown }[] }[];
  readonly order: string[];
  readonly audit: AuditRecord[];
  readonly slugLookups: (readonly string[])[];
  readonly folders: (readonly ImportFolderToResolve[])[];
  readonly tags: (readonly ImportTagToResolve[])[];
  readonly links: ImportLinks[];
}

interface Options {
  /** The places the store has left; unlimited when left out. */
  room?: number;
  existing?: readonly string[];
  unavailable?: boolean;
  failBatch?: number;
  failAudit?: boolean;
  /** The slugs the caller has already. */
  slugs?: readonly string[];
  /** The slugs another transaction writes after the check, so an insert loses them. */
  racedSlugs?: readonly string[];
  /** The names of the folders and tags the caller has, in lower case. */
  folders?: readonly string[];
  tags?: readonly string[];
  /** Whether two spellings are one name for the store; the same whatever the case when left out. */
  same?: (a: string, b: string) => boolean;
}

function fixture(options: Options = {}) {
  const written: Written = { takes: [], batches: [], order: [], audit: [], slugLookups: [], folders: [], tags: [], links: [] };
  const store: ImportStore = {
    bookmarkCount: () => Promise.reject(new Error("the import never reads the counter outside the lock")),
    existingCanonicalUrls: (canonicals) => {
      written.order.push("lookup");
      return Promise.resolve(new Set(canonicals.filter((canonical) => (options.existing ?? []).includes(canonical))));
    },
    existingSlugs: (slugs) => {
      written.order.push("slugs");
      written.slugLookups.push(slugs);
      return Promise.resolve(new Set(slugs.filter((slug) => (options.slugs ?? []).includes(slug))));
    },
    existingFolderNames: () => Promise.reject(new Error("the import never asks which folders exist")),
    existingTagNames: () => Promise.reject(new Error("the import never asks which tags exist")),
    firstSameNames: (names) => {
      const same = options.same ?? ((a: string, b: string) => a.toLowerCase() === b.toLowerCase());
      return Promise.resolve(names.map((name, index) => Math.max(0, names.findIndex((other, place) => place <= index && same(other, name)))));
    },
    resolveFolders: (folders) => {
      written.order.push("folders");
      written.folders.push(folders);
      return Promise.resolve({ ids: new Map(folders.map((folder) => [folder.name, `folder:${folder.name}`])), created: folders.filter((folder) => !(options.folders ?? []).includes(folder.name.toLowerCase())).length });
    },
    resolveTags: (tags) => {
      written.order.push("tags");
      written.tags.push(tags);
      return Promise.resolve({ ids: new Map(tags.map((tag) => [tag.name, `tag:${tag.name}`])), created: tags.filter((tag) => !(options.tags ?? []).includes(tag.name.toLowerCase())).length });
    },
    linkBookmarks: (links) => {
      written.order.push("link");
      written.links.push(links);
      return Promise.resolve();
    },
    takePlaces: (ceiling, wanted): Promise<ImportPlaces> => {
      written.order.push("take");
      written.takes.push({ ceiling, wanted });
      if (options.unavailable === true) {
        return Promise.resolve({ kind: "unavailable" });
      }
      const room = Math.min(wanted, options.room ?? Number.POSITIVE_INFINITY, ceiling === null ? Number.POSITIVE_INFINITY : ceiling);
      return Promise.resolve({ kind: "taken", taken: room, used: room });
    },
    insertBookmarks: (batch) => {
      written.order.push("insert");
      if (options.failBatch === written.batches.length) {
        return Promise.reject(new Error("the insert failed"));
      }
      written.batches.push({ bookmarks: batch.bookmarks, events: batch.events });
      return Promise.resolve({ slugsLost: batch.bookmarks.filter((bookmark) => bookmark.slug !== null && (options.racedSlugs ?? []).includes(bookmark.slug)).map((bookmark) => bookmark.id) });
    },
  };
  let bookmarkNumber = 0;
  let eventNumber = 0;
  const audit = createAuditWriter({
    store: {
      insert: (record) => {
        written.order.push("audit");
        if (options.failAudit === true) {
          return Promise.reject(new Error("the audit insert failed"));
        }
        written.audit.push(record);
        return Promise.resolve();
      },
    },
    newId: () => `00000000-0000-7000-8000-${String(900_000_000_000 + written.audit.length)}`,
  });
  const dependencies = {
    store,
    audit,
    newBookmarkId: () => `00000000-0000-7000-8000-${String(100_000_000_000 + bookmarkNumber++)}`,
    newId: () => `00000000-0000-7000-8000-${String(200_000_000_000 + eventNumber++)}`,
  };
  return { written, dependencies };
}

const ACCOUNT = "11111111-1111-7111-8111-111111111111";
const WORKSPACE = "22222222-2222-7222-8222-222222222222";

const ask = (file: ImportRequest, overrides: Partial<ImportAsk> = {}): ImportAsk => ({
  file,
  skipDuplicates: true,
  ceiling: "unlimited",
  workspaceId: WORKSPACE,
  accountId: ACCOUNT,
  actor: { type: "account", accountId: ACCOUNT, label: "Walker" },
  ipPrefix: null,
  ...overrides,
});

const urls = (...values: string[]) => values.map((url) => ({ url }));

describe("importBookmarks", () => {
  it("is unavailable when the store cannot take places, and writes no bookmark and no audit event", async () => {
    const { written, dependencies } = fixture({ unavailable: true });

    await expect(importBookmarks(dependencies, ask(urls("https://example.com/")))).resolves.toEqual({ kind: "unavailable" });
    expect(written.batches).toEqual([]);
    expect(written.audit).toEqual([]);
  });

  it("takes the places the valid bookmarks that are not duplicates need, once, before inserting any, and records the import last", async () => {
    const { written, dependencies } = fixture({ existing: ["https://example.com/mine"] });

    const outcome = await importBookmarks(dependencies, ask(urls("https://example.com/mine", "https://example.com/new", "bogus", "https://example.com/new/", "https://example.com/other"), { ceiling: 10 }));

    expect(written.takes).toEqual([{ ceiling: 10, wanted: 2 }]);
    expect(written.order).toEqual(["lookup", "take", "insert", "audit"]);
    expect(outcome).toMatchObject({ kind: "imported", result: { created: 2 } });
    expect(written.batches.flatMap((batch) => batch.bookmarks.map((bookmark) => bookmark.url))).toEqual(["https://example.com/new", "https://example.com/other"]);
  });

  it("passes no ceiling for an unlimited workspace, and creates all", async () => {
    const { written, dependencies } = fixture();

    const outcome = await importBookmarks(dependencies, ask(urls("https://example.com/a", "https://example.com/b")));

    expect(written.takes).toEqual([{ ceiling: null, wanted: 2 }]);
    expect(outcome).toMatchObject({ result: { created: 2, skipped: [] } });
  });

  it("creates the first bookmarks of the file that the places cover and reports the others as bookmark_limit_reached, interleaved with the duplicates in file order", async () => {
    const { written, dependencies } = fixture({ room: 2, existing: ["https://example.com/dup"] });

    const outcome = await importBookmarks(dependencies, ask(urls("https://example.com/1", "https://example.com/dup", "https://example.com/2", "https://example.com/3", "bogus", "https://example.com/4"), { ceiling: 2 }));

    if (outcome.kind !== "imported") {
      throw new Error("not imported");
    }
    expect(outcome.result.created).toBe(2);
    expect(outcome.result.skipped.map((entry) => [entry.position, entry.reason])).toEqual([
      [2, "duplicate"],
      [4, "bookmark_limit_reached"],
      [6, "bookmark_limit_reached"],
    ]);
    expect(outcome.result.failed.map((entry) => entry.position)).toEqual([5]);
    expect(written.batches.flatMap((batch) => batch.bookmarks.map((bookmark) => bookmark.url))).toEqual(["https://example.com/1", "https://example.com/2"]);
  });

  it("writes the bookmarks as the account's own, with the host, the plain text, the pin and no archive state, in batches in the order of the file with the identifiers in the order given", async () => {
    const { written, dependencies } = fixture();
    const count = IMPORT_BATCH_SIZE * 2 + 1;
    const file: ImportRequest = [
      { url: "https://Example.com:443/first", title: " First \u0000", description: "About", pinned: true, planArchived: true },
      ...Array.from({ length: count - 1 }, (_, index) => ({ url: `https://example.com/${String(index)}` })),
    ];

    await importBookmarks(dependencies, ask(file));

    expect(written.batches.map((batch) => batch.bookmarks.length)).toEqual([IMPORT_BATCH_SIZE, IMPORT_BATCH_SIZE, 1]);
    const all = written.batches.flatMap((batch) => batch.bookmarks);
    expect(all[0]).toEqual({
      id: "00000000-0000-7000-8000-100000000000",
      ownerId: ACCOUNT,
      url: "https://example.com/first",
      urlCanonical: "https://example.com/first",
      host: "example.com",
      title: "First",
      description: "About",
      pinned: true,
      slug: null,
      forwarding: false,
    });
    expect(all.map((bookmark) => bookmark.id)).toEqual([...all.map((bookmark) => bookmark.id)].sort());
    expect(all.every((bookmark) => bookmark.ownerId === ACCOUNT)).toBe(true);
    expect(Object.keys(all[0] ?? {})).not.toContain("planArchived");
  });

  it("announces bookmark.created for each bookmark it inserts, in the batch that inserts it, and nothing else", async () => {
    const { written, dependencies } = fixture();

    await importBookmarks(dependencies, ask(urls("https://example.com/a", "https://example.com/b")));

    const [batch] = written.batches;
    expect(batch?.events.map((event) => [event.name, event.payload])).toEqual(
      (batch?.bookmarks ?? []).map((bookmark) => ["bookmark.created", { workspaceId: WORKSPACE, bookmarkId: bookmark.id, accountId: ACCOUNT }]),
    );
    expect(new Set(batch?.events.map((event) => event.eventId)).size).toBe(2);
  });

  it("records one import.completed with counts only, for the actor, also when nothing is created", async () => {
    const { written, dependencies } = fixture({ room: 0 });

    await importBookmarks(dependencies, ask(urls("https://example.com/a", "bogus"), { ceiling: 0, actor: { type: "api_token", accountId: ACCOUNT, tokenId: "33333333-3333-7333-8333-333333333333", label: "CLI" }, ipPrefix: "203.0.0.0/16" }));

    expect(written.batches).toEqual([]);
    expect(written.audit).toHaveLength(1);
    expect(written.audit[0]).toMatchObject({
      action: "import.completed",
      workspaceId: WORKSPACE,
      actorType: "api_token",
      actorAccountId: ACCOUNT,
      actorTokenId: "33333333-3333-7333-8333-333333333333",
      ipPrefix: "203.0.0.0/16",
      metadata: { created: "0", skipped: "1", failed: "1", slugsDropped: "0", foldersCreated: "0", tagsCreated: "0" },
    });
  });

  it("rejects when an insert fails and records nothing, and rejects when the audit write fails, so the caller's transaction is rolled back", async () => {
    const insert = fixture({ failBatch: 0 });
    await expect(importBookmarks(insert.dependencies, ask(urls("https://example.com/a")))).rejects.toThrow("the insert failed");
    expect(insert.written.audit).toEqual([]);

    const audit = fixture({ failAudit: true });
    await expect(importBookmarks(audit.dependencies, ask(urls("https://example.com/a")))).rejects.toThrow("the audit insert failed");
  });

  it("refuses a store that took more places than it was asked for", async () => {
    const { dependencies } = fixture();
    const greedy = { ...dependencies, store: { ...dependencies.store, takePlaces: () => Promise.resolve<ImportPlaces>({ kind: "taken", taken: 5, used: 5 }) } };

    await expect(importBookmarks(greedy, ask(urls("https://example.com/a")))).rejects.toThrow("more places");
  });

  it("never reads the plan-archived flag of the file: it changes neither the places wanted nor the bookmark", async () => {
    const plain = fixture();
    const flagged = fixture();

    await importBookmarks(plain.dependencies, ask([{ url: "https://example.com/a" }, { url: "https://example.com/b" }]));
    await importBookmarks(flagged.dependencies, ask([{ url: "https://example.com/a", planArchived: true }, { url: "https://example.com/b", planArchived: false }]));

    expect(flagged.written.takes).toEqual(plain.written.takes);
    expect(flagged.written.batches).toEqual(plain.written.batches);
  });

  it("makes sure of the slugs, folders and tags after taking the places and before writing the first bookmark, and links each batch after it is inserted", async () => {
    const { written, dependencies } = fixture();

    await importBookmarks(dependencies, ask([{ url: "https://example.com/a", slug: "a", folders: ["F"], tags: ["T"] }]));

    expect(written.order).toEqual(["lookup", "take", "slugs", "folders", "tags", "insert", "link", "audit"]);
  });

  it("files and tags each bookmark by its own names and keeps its slug, forwarding and pin, matching names without regard to case", async () => {
    const { written, dependencies } = fixture();

    const outcome = await importBookmarks(
      dependencies,
      ask([
        { url: "https://example.com/a", slug: " Alpha ", forwarding: true, pinned: true, folders: ["Work", "Home"], tags: ["News"] },
        { url: "https://example.com/b", slug: "beta", folders: ["work"], tags: ["news", "Later"] },
        { url: "https://example.com/c", forwarding: true, folders: [], tags: [] },
      ]),
    );

    const rows = written.batches.flatMap((batch) => batch.bookmarks);
    expect(rows.map((row) => [row.slug, row.forwarding, row.pinned])).toEqual([
      ["alpha", true, true],
      ["beta", false, false],
      [null, false, false],
    ]);
    expect(written.links).toHaveLength(1);
    expect(written.links[0]?.folders).toEqual([
      { bookmarkId: rows[0]?.id, folderId: "folder:Work" },
      { bookmarkId: rows[0]?.id, folderId: "folder:Home" },
      { bookmarkId: rows[1]?.id, folderId: "folder:Work" },
    ]);
    expect(written.links[0]?.tags).toEqual([
      { bookmarkId: rows[0]?.id, tagId: "tag:News" },
      { bookmarkId: rows[1]?.id, tagId: "tag:News" },
      { bookmarkId: rows[1]?.id, tagId: "tag:Later" },
    ]);
    expect(written.folders[0]?.map((folder) => folder.name)).toEqual(["Work", "Home"]);
    expect(written.tags[0]?.map((tag) => tag.name)).toEqual(["News", "Later"]);
    expect(outcome).toMatchObject({ result: { foldersCreated: 2, tagsCreated: 2, slugsDropped: 0 } });
  });

  it("makes sure of one folder and one tag for each name the store tells apart, the first spelling standing, and files a bookmark under the row of its spelling's name", async () => {
    const dotted = new Set(["\u0130", "i"]);
    const { written, dependencies } = fixture({ same: (a, b) => a === b || (dotted.has(a) && dotted.has(b)) });

    const outcome = await importBookmarks(
      dependencies,
      ask([
        { url: "https://example.com/a", folders: ["\u0130"], tags: ["\uA7CE"] },
        { url: "https://example.com/b", folders: ["i", "\uA7CF"], tags: ["\uA7CF"] },
      ]),
    );

    const rows = written.batches.flatMap((batch) => batch.bookmarks);
    expect(written.folders[0]?.map((folder) => folder.name)).toEqual(["\u0130", "\uA7CF"]);
    expect(written.tags[0]?.map((tag) => tag.name)).toEqual(["\uA7CE", "\uA7CF"]);
    expect(written.links[0]?.folders).toEqual([
      { bookmarkId: rows[0]?.id, folderId: "folder:\u0130" },
      { bookmarkId: rows[1]?.id, folderId: "folder:\u0130" },
      { bookmarkId: rows[1]?.id, folderId: "folder:\uA7CF" },
    ]);
    expect(written.links[0]?.tags).toEqual([
      { bookmarkId: rows[0]?.id, tagId: "tag:\uA7CE" },
      { bookmarkId: rows[1]?.id, tagId: "tag:\uA7CF" },
    ]);
    expect(outcome).toMatchObject({ result: { foldersCreated: 2, tagsCreated: 2, detected: { folders: 2, tags: 2 } } });
  });

  it("creates the folders and tags the document lists, with the file's icon and colour, whether a bookmark uses them or not, and falls back to the defaults for an unknown icon or an out-of-range colour", async () => {
    const { written, dependencies } = fixture({ folders: ["old"], tags: ["kept"] });

    const outcome = await importBookmarks(
      dependencies,
      ask({
        format: "slugbase-export",
        version: 1,
        folders: [
          { name: "Unused", icon: "briefcase", color: 3 },
          { name: "Old", icon: "briefcase", color: 3 },
          { name: "Odd", icon: "no-such-icon", color: 9 },
          { name: "Zero", color: 0 },
          { name: "  \u0000 " },
          { name: "A/B/C" },
          { name: "x".repeat(70) },
          { name: "unused", icon: "star", color: 5 },
        ],
        tags: ["Kept", "Free", "", "z".repeat(50)],
        bookmarks: [{ url: "https://example.com/a", folders: ["UNUSED"] }],
      }),
    );

    expect(written.folders[0]?.map((folder) => [folder.name, folder.icon, folder.color])).toEqual([
      ["Unused", "briefcase", 3],
      ["Old", "briefcase", 3],
      ["Odd", "folder", 1],
      ["Zero", "folder", 1],
      ["A/B/C", "folder", 1],
      ["x".repeat(64), "folder", 1],
    ]);
    expect(written.tags[0]?.map((tag) => tag.name)).toEqual(["Kept", "Free", "z".repeat(40)]);
    expect(outcome).toMatchObject({ result: { foldersCreated: 5, tagsCreated: 2 } });
    expect(new Set([...(written.folders[0] ?? []), ...(written.tags[0] ?? [])].map((entry) => entry.id)).size).toBe(9);
  });

  it("makes sure of the listed folders and tags also when every bookmark is skipped, and of the names of a bookmark that is imported only", async () => {
    const { written, dependencies } = fixture({ room: 0 });

    await importBookmarks(
      dependencies,
      ask(
        { format: "slugbase-export", version: 1, folders: [{ name: "Listed" }], tags: ["Listed"], bookmarks: [{ url: "https://example.com/a", folders: ["Skipped"], tags: ["Skipped"] }] },
        { ceiling: 0 },
      ),
    );

    expect(written.folders[0]?.map((folder) => folder.name)).toEqual(["Listed"]);
    expect(written.tags[0]?.map((tag) => tag.name)).toEqual(["Listed"]);
    expect(written.batches).toEqual([]);
    expect(written.links).toEqual([]);
  });

  it("keeps a slug the file gives once, the first bookmark that is imported, and drops the rest from their bookmarks with forwarding off, importing every bookmark and listing each drop", async () => {
    const { written, dependencies } = fixture({ slugs: ["held"] });

    const outcome = await importBookmarks(
      dependencies,
      ask([
        { url: "https://example.com/1", slug: "Mail", forwarding: true },
        { url: "https://example.com/2", slug: "mail", forwarding: true },
        { url: "https://example.com/3", slug: "held", forwarding: true },
        { url: "https://example.com/4", slug: "not valid!", forwarding: true },
        { url: "https://example.com/5", slug: "-x" },
      ]),
    );

    const rows = written.batches.flatMap((batch) => batch.bookmarks);
    expect(rows.map((row) => [row.slug, row.forwarding])).toEqual([
      ["mail", true],
      [null, false],
      [null, false],
      [null, false],
      [null, false],
    ]);
    if (outcome.kind !== "imported") {
      throw new Error("not imported");
    }
    expect(outcome.result.created).toBe(5);
    expect(outcome.result.slugsDropped).toBe(4);
    expect(outcome.result.droppedSlugs.map((drop) => [drop.position, drop.slug, drop.reason])).toEqual([
      [2, "mail", "slug_conflict"],
      [3, "held", "slug_conflict"],
      [4, "not valid!", "slug_invalid"],
      [5, "-x", "slug_invalid"],
    ]);
    expect(written.audit[0]?.metadata).toMatchObject({ slugsDropped: "4" });
  });

  it("imports a bookmark whose slug another transaction took after the check, without the slug and the forwarding, and lists it with the dropped slugs in the order of the file", async () => {
    const { dependencies } = fixture({ racedSlugs: ["raced"] });

    const outcome = await importBookmarks(
      dependencies,
      ask([
        { url: "https://example.com/1", slug: "ok" },
        { url: "https://example.com/2", slug: "raced", forwarding: true },
        { url: "https://example.com/3", slug: "bad slug" },
      ]),
    );

    if (outcome.kind !== "imported") {
      throw new Error("not imported");
    }
    expect(outcome.result.created).toBe(3);
    expect(outcome.result.droppedSlugs.map((drop) => [drop.position, drop.slug, drop.reason])).toEqual([
      [2, "raced", "slug_conflict"],
      [3, "bad slug", "slug_invalid"],
    ]);
    expect(outcome.result.slugsDropped).toBe(2);
  });

  it("refuses an answer of the store that names a lost slug outside the batch, and one that leaves a name unresolved", async () => {
    const { dependencies } = fixture();
    const stray = { ...dependencies, store: { ...dependencies.store, insertBookmarks: () => Promise.resolve({ slugsLost: ["99999999-9999-7999-8999-999999999999"] }) } };
    await expect(importBookmarks(stray, ask(urls("https://example.com/a")))).rejects.toThrow("outside the batch");

    const unresolved = { ...dependencies, store: { ...dependencies.store, resolveFolders: () => Promise.resolve({ ids: new Map<string, string>(), created: 0 }) } };
    await expect(importBookmarks(unresolved, ask([{ url: "https://example.com/a", folders: ["F"] }]))).rejects.toThrow("did not resolve a folder");
  });

  it("rejects, and records nothing, when linking fails", async () => {
    const { written, dependencies } = fixture();
    const failing = { ...dependencies, store: { ...dependencies.store, linkBookmarks: () => Promise.reject(new Error("the link failed")) } };

    await expect(importBookmarks(failing, ask([{ url: "https://example.com/a", tags: ["T"] }]))).rejects.toThrow("the link failed");
    expect(written.audit).toEqual([]);
  });
});
