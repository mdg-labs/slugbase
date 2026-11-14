import { IMPORT_MAX_DISTINCT_NAMES, IMPORT_MAX_LINKS, IMPORT_MAX_NEW_NAMES, type ImportRequest } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../../vitest.shared.ts";
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
  readonly choices: { slug: string; bookmarkId: string }[];
  readonly choiceCalls: number[];
  /** How many times the store was asked about the names of the file. */
  nameCalls: number;
}

interface Options {
  /** The places the store has left; unlimited when left out. */
  room?: number;
  existing?: readonly string[];
  unavailable?: boolean;
  /** The counter the import reads before it takes the places; 0 when left out, and undefined for a workspace that cannot be read. */
  counter?: number | undefined;
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
  /** The slugs the store refuses a choice for, as it does when the bookmark is no longer a candidate of the member. */
  refusedChoices?: readonly string[];
  failChoice?: boolean;
}

function fixture(options: Options = {}) {
  const written: Written = { takes: [], batches: [], order: [], audit: [], slugLookups: [], folders: [], tags: [], links: [], choices: [], choiceCalls: [], nameCalls: 0 };
  const store: ImportStore = {
    bookmarkCount: () => {
      written.order.push("count");
      return Promise.resolve("counter" in options ? options.counter : 0);
    },
    existingCanonicalUrls: (canonicals) => {
      written.order.push("lookup");
      return Promise.resolve(new Set(canonicals.filter((canonical) => (options.existing ?? []).includes(canonical))));
    },
    existingSlugs: (slugs) => {
      written.order.push("slugs");
      written.slugLookups.push(slugs);
      return Promise.resolve(new Set(slugs.filter((slug) => (options.slugs ?? []).includes(slug))));
    },
    existingFolderNames: (names) => {
      written.nameCalls += 1;
      return Promise.resolve(new Set(names.filter((name) => (options.folders ?? []).includes(name.toLowerCase()))));
    },
    existingTagNames: (names) => {
      written.nameCalls += 1;
      return Promise.resolve(new Set(names.filter((name) => (options.tags ?? []).includes(name.toLowerCase()))));
    },
    firstSameNames: (names) => {
      written.nameCalls += 1;
      if (options.same === undefined) {
        const firsts = new Map<string, number>();
        return Promise.resolve(names.map((name, index) => firsts.get(name.toLowerCase()) ?? (firsts.set(name.toLowerCase(), index), index)));
      }
      const same = options.same;
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
    rememberChoices: (choices) => {
      written.order.push("remember");
      if (options.failChoice === true) {
        return Promise.reject(new Error("the choices could not be stored"));
      }
      written.choices.push(...choices);
      written.choiceCalls.push(choices.length);
      return Promise.resolve(choices.filter((choice) => !(options.refusedChoices ?? []).includes(choice.slug)).length);
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
    expect(written.order).toEqual(["lookup", "count", "take", "insert", "audit"]);
    expect(outcome).toMatchObject({ kind: "imported", result: { created: 2 } });
    expect(written.batches.flatMap((batch) => batch.bookmarks.map((bookmark) => bookmark.url))).toEqual(["https://example.com/new", "https://example.com/other"]);
  });

  it("reads a long file in chunks and lets the event loop run between them, with the same reads, canonical URLs and duplicates as a short file", async () => {
    const { written, dependencies } = fixture();
    const file = urls(...Array.from({ length: 1200 }, (_, index) => `https://example.com/${String(index)}`), "https://example.com/0/", "bogus");
    let turns = 0;
    let spinning = true;
    const spin = (): void => {
      if (spinning) {
        turns += 1;
        setImmediate(spin);
      }
    };
    setImmediate(spin);
    let asked: readonly string[] = [];
    let turnsWhenAsked = -1;
    const store: ImportStore = {
      ...dependencies.store,
      existingCanonicalUrls: (canonicals) => {
        asked = canonicals;
        turnsWhenAsked = turns;
        return dependencies.store.existingCanonicalUrls(canonicals);
      },
    };

    const outcome = await importBookmarks({ ...dependencies, store }, ask(file));
    spinning = false;

    expect(turnsWhenAsked).toBeGreaterThanOrEqual(2);
    expect(asked).toEqual(Array.from({ length: 1200 }, (_, index) => `https://example.com/${String(index)}`));
    if (outcome.kind !== "imported") {
      throw new Error("not imported");
    }
    expect(outcome.result.detected.bookmarks).toBe(1202);
    expect(outcome.result.created).toBe(1200);
    expect(outcome.result.skipped).toEqual([{ position: 1201, title: "example.com", url: "https://example.com/0/", reason: "duplicate" }]);
    expect(outcome.result.failed.map((entry) => entry.position)).toEqual([1202]);
    expect(written.takes).toEqual([{ ceiling: null, wanted: 1200 }]);
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

    expect(written.order).toEqual(["lookup", "count", "take", "slugs", "folders", "tags", "insert", "link", "audit"]);
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

  it("is unavailable, before it takes any place, when the counter of the workspace cannot be read", async () => {
    const { written, dependencies } = fixture({ counter: undefined });

    await expect(importBookmarks(dependencies, ask(urls("https://example.com/")))).resolves.toEqual({ kind: "unavailable" });
    expect(written.takes).toEqual([]);
    expect(written.order).toEqual(["lookup", "count"]);
  });
});

describe("importBookmarks and the new folders and tags", () => {
  const names = (prefix: string, count: number, from = 0) => Array.from({ length: count }, (_, index) => `${prefix}${String(from + index)}`);
  const withNames = (count: number, kind: "tags" | "folders" = "tags", prefix = "n"): ImportRequest => [{ url: "https://example.com/a", [kind]: names(prefix, count) }];

  it("refuses a file of more new folders and tags together than one import may create before it takes any place, and writes nothing", async () => {
    for (const file of [
      withNames(IMPORT_MAX_NEW_NAMES + 1),
      withNames(IMPORT_MAX_NEW_NAMES + 1, "folders"),
      [{ url: "https://example.com/a", folders: names("f", 5001), tags: names("t", 5000) }],
      { format: "slugbase-export" as const, version: 1, folders: names("f", 4000).map((name) => ({ name })), tags: names("t", 3000), bookmarks: [{ url: "https://example.com/a", folders: names("g", 1000), tags: names("u", 2001) }] },
    ] satisfies ImportRequest[]) {
      const { written, dependencies } = fixture();

      const outcome = await importBookmarks(dependencies, ask(file));

      expect(outcome).toEqual({ kind: "too_many_names", newNames: IMPORT_MAX_NEW_NAMES + 1 });
      expect(written.takes).toEqual([]);
      expect(written.order).not.toContain("take");
      expect(written.batches).toEqual([]);
      expect(written.folders).toEqual([]);
      expect(written.tags).toEqual([]);
      expect(written.audit).toEqual([]);
    }
  });

  it("imports a file of exactly the most new names", async () => {
    const { written, dependencies } = fixture();

    const outcome = await importBookmarks(dependencies, ask([{ url: "https://example.com/a", folders: names("f", 5000), tags: names("t", 5000) }]));

    expect(outcome).toMatchObject({ kind: "imported", result: { created: 1, foldersCreated: 5000, tagsCreated: 5000 } });
    expect(written.audit).toHaveLength(1);
  });

  it("does not count the names the caller has, matched by the store, so any size of file whose names exist imports", async () => {
    const known = names("t", 2 * IMPORT_MAX_NEW_NAMES);
    const { dependencies } = fixture({ tags: known.map((name) => name.toLowerCase()) });

    const outcome = await importBookmarks(dependencies, ask([{ url: "https://example.com/a", tags: known.map((name) => name.toUpperCase()) }]));

    expect(outcome).toMatchObject({ kind: "imported", result: { tagsCreated: 0, detected: { tags: 2 * IMPORT_MAX_NEW_NAMES } } });
  });

  it("counts the names the store tells apart, not the spellings: spellings of one name are one", async () => {
    const { dependencies } = fixture();
    const spelled = names("t", IMPORT_MAX_NEW_NAMES).flatMap((name) => [name, name.toUpperCase()]);

    const outcome = await importBookmarks(dependencies, ask([{ url: "https://example.com/a", tags: spelled }]));

    expect(outcome).toMatchObject({ kind: "imported", result: { tagsCreated: IMPORT_MAX_NEW_NAMES } });
  });

  it("counts the names of the bookmarks that are created and not those of a bookmark left out for a duplicate or for the limit", async () => {
    const file: ImportRequest = [
      { url: "https://example.com/1", tags: names("a", 6000) },
      { url: "https://example.com/1", tags: names("b", 6000) },
      { url: "https://example.com/2", tags: names("c", 4000) },
      { url: "https://example.com/3", tags: names("d", 6000) },
    ];
    const inside = fixture({ room: 2 });
    const over = fixture({ room: 3 });

    await expect(importBookmarks(inside.dependencies, ask(file, { ceiling: 2 }))).resolves.toMatchObject({ kind: "imported", result: { created: 2, tagsCreated: 10_000 } });
    await expect(importBookmarks(over.dependencies, ask(file, { ceiling: 3 }))).resolves.toEqual({ kind: "too_many_names", newNames: 16_000 });
  });

  it("counts again under the lock when the places taken cover more bookmarks than the counter showed, and answers too_many_names without writing a bookmark or an audit event", async () => {
    const file: ImportRequest = [
      { url: "https://example.com/1", tags: names("a", 6000) },
      { url: "https://example.com/2", tags: names("b", 6000) },
    ];
    // The counter shows no room, so the count before the lock sees no bookmark; the places taken then cover both.
    const { written, dependencies } = fixture({ counter: 2 });

    const outcome = await importBookmarks(dependencies, ask(file, { ceiling: 2 }));

    expect(outcome).toEqual({ kind: "too_many_names", newNames: 12_000 });
    expect(written.takes).toEqual([{ ceiling: 2, wanted: 2 }]);
    expect(written.batches).toEqual([]);
    expect(written.folders).toEqual([]);
    expect(written.tags).toEqual([]);
    expect(written.audit).toEqual([]);
  });
});

describe("importBookmarks and the folder and tag links", () => {
  const pool = (count: number) => Array.from({ length: count }, (_, index) => `t${String(index)}`);
  // `bookmarks` bookmarks of `perBookmark` tags each from one pool, so only the pool's names are new.
  const linked = (bookmarks: number, perBookmark: number, extra: readonly string[] = []): { url: string; tags: string[] }[] =>
    Array.from({ length: bookmarks }, (_, index) => ({ url: `https://example.com/${String(index)}`, tags: [...pool(perBookmark), ...(index === 0 ? extra : [])] }));

  it("refuses a file that would make more links than one import may before it takes any place, and writes nothing", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    for (const file of [
      linked(1000, 100, ["extra"]),
      Array.from({ length: 1000 }, (_, index) => ({ url: `https://example.com/${String(index)}`, folders: pool(50), tags: pool(index === 0 ? 51 : 50) })),
    ] satisfies ImportRequest[]) {
      const { written, dependencies } = fixture();

      const outcome = await importBookmarks(dependencies, ask(file));

      expect(outcome).toEqual({ kind: "too_many_links", links: IMPORT_MAX_LINKS + 1 });
      expect(written.takes).toEqual([]);
      expect(written.order).not.toContain("take");
      expect(written.batches).toEqual([]);
      expect(written.folders).toEqual([]);
      expect(written.tags).toEqual([]);
      expect(written.links).toEqual([]);
      expect(written.audit).toEqual([]);
    }
  });

  it("imports a file of exactly the most links", async () => {
    const { written, dependencies } = fixture();

    const outcome = await importBookmarks(dependencies, ask(linked(1000, 100)));

    expect(outcome).toMatchObject({ kind: "imported", result: { created: 1000, tagsCreated: 100 } });
    expect(written.links.reduce((total, batch) => total + batch.tags.length, 0)).toBe(IMPORT_MAX_LINKS);
    expect(written.audit).toHaveLength(1);
  });

  it("counts the spellings of one name on a bookmark once, and counts the links of a name the caller has", async () => {
    const spelled = [...pool(100), ...pool(100).map((name) => name.toUpperCase())];
    const file: ImportRequest = Array.from({ length: 1000 }, (_, index) => ({ url: `https://example.com/${String(index)}`, tags: spelled }));
    const imported = fixture({ tags: pool(100) });
    const over = fixture({ tags: pool(100) });

    await expect(importBookmarks(imported.dependencies, ask(file))).resolves.toMatchObject({ kind: "imported", result: { created: 1000, tagsCreated: 0 } });
    await expect(importBookmarks(over.dependencies, ask([...file, { url: "https://example.com/over", tags: ["x"] }]))).resolves.toEqual({ kind: "too_many_links", links: IMPORT_MAX_LINKS + 1 });
    expect(over.written.takes).toEqual([]);
  });

  it("sends the store one pair for each bookmark and each folder or tag, however many spellings of the name the bookmark has", async () => {
    const { written, dependencies } = fixture();

    await importBookmarks(dependencies, ask([{ url: "https://example.com/a", folders: ["Work", "WORK", "work"], tags: ["T1", "t1", "T2", "T1"] }, { url: "https://example.com/b", tags: ["t1", "T1"] }]));

    const pairs = written.links.flatMap((batch) => [...batch.folders.map((link) => ["folder", link.bookmarkId, link.folderId]), ...batch.tags.map((link) => ["tag", link.bookmarkId, link.tagId])]);
    expect(pairs).toHaveLength(4);
    expect(new Set(pairs.map((pair) => pair.join("|"))).size).toBe(4);
    expect(pairs.filter((pair) => pair[0] === "folder")).toHaveLength(1);
    expect(pairs.filter((pair) => pair[0] === "tag" && pair[1] === written.batches[0]?.bookmarks[0]?.id)).toHaveLength(2);
  });

  it("counts the links of the bookmarks that are created and not those of a bookmark left out for a duplicate or for the limit", async () => {
    const file = [...linked(1000, 100), { url: "https://example.com/0", tags: ["x"] }, { url: "https://example.com/over", tags: ["x"] }];
    const inside = fixture({ room: 1000 });
    const over = fixture({ room: 1001 });

    await expect(importBookmarks(inside.dependencies, ask(file, { ceiling: 1000 }))).resolves.toMatchObject({ kind: "imported", result: { created: 1000 } });
    await expect(importBookmarks(over.dependencies, ask(file, { ceiling: 1001 }))).resolves.toEqual({ kind: "too_many_links", links: IMPORT_MAX_LINKS + 1 });
  });

  it("counts again under the lock when the places taken cover more bookmarks than the counter showed, and answers too_many_links without writing a bookmark, a link or an audit event", async () => {
    // The counter shows one place left, so the count before the lock sees one bookmark and 100 links; the places taken then cover all 1001.
    const { written, dependencies } = fixture({ counter: 1999 });

    const outcome = await importBookmarks(dependencies, ask(linked(1001, 100), { ceiling: 2000 }));

    expect(outcome).toEqual({ kind: "too_many_links", links: 100_100 });
    expect(written.takes).toEqual([{ ceiling: 2000, wanted: 1001 }]);
    expect(written.batches).toEqual([]);
    expect(written.folders).toEqual([]);
    expect(written.tags).toEqual([]);
    expect(written.links).toEqual([]);
    expect(written.audit).toEqual([]);
  });

  it("answers the names refusal first when a file is over both limits", async () => {
    const { dependencies } = fixture();

    await expect(importBookmarks(dependencies, ask([{ url: "https://example.com/a", tags: Array.from({ length: IMPORT_MAX_NEW_NAMES + 1 }, (_, index) => `n${String(index)}`) }]))).resolves.toMatchObject({ kind: "too_many_names" });
  });
});

describe("importBookmarks and the remembered slug choices", () => {
  const link = (ref: string, slug: string, extra: Record<string, unknown> = {}) => ({ ref, url: `https://example.com/${ref}`, slug, forwarding: true, ...extra });
  const envelope = (bookmarks: object[], goPreferences: object[]): ImportRequest => ({ format: "slugbase-export", version: 1, bookmarks, goPreferences }) as ImportRequest;
  const idOf = (written: Written, url: string): string | undefined => written.batches.flatMap((batch) => batch.bookmarks).find((bookmark) => bookmark.url === url)?.id;

  it("restores the choices for the bookmarks their refs name once the bookmarks are written with that slug and forward, in one call after the last batch and before the audit event, in the order of the file", async () => {
    const { written, dependencies } = fixture();

    const outcome = await importBookmarks(dependencies, ask(envelope([link("b1", "docs"), link("b2", "news")], [{ slug: "news", bookmarkRef: "b2" }, { slug: "docs", bookmarkRef: "b1" }])));

    expect(outcome).toMatchObject({ kind: "imported", result: { created: 2 } });
    expect(written.choices).toEqual([
      { slug: "news", bookmarkId: idOf(written, "https://example.com/b2") },
      { slug: "docs", bookmarkId: idOf(written, "https://example.com/b1") },
    ]);
    expect(written.order).toEqual(["lookup", "count", "take", "slugs", "insert", "remember", "audit"]);
  });

  it("reads a slug of a choice as a slug of a bookmark is read: trimmed and in lower case", async () => {
    const { written, dependencies } = fixture();

    await importBookmarks(dependencies, ask(envelope([link("b1", "Docs")], [{ slug: "  DOCS ", bookmarkRef: "b1" }])));

    expect(written.choices).toEqual([{ slug: "docs", bookmarkId: idOf(written, "https://example.com/b1") }]);
  });

  it("restores nothing and fails nothing for a bookmark that lost its slug to one the caller has, to an earlier bookmark of the file, or to another transaction", async () => {
    const { written, dependencies } = fixture({ slugs: ["had"], racedSlugs: ["raced"] });
    const file = envelope(
      [link("b1", "had"), link("b2", "twice"), link("b3", "twice"), link("b4", "raced")],
      [
        { slug: "had", bookmarkRef: "b1" },
        { slug: "twice", bookmarkRef: "b3" },
        { slug: "raced", bookmarkRef: "b4" },
      ],
    );

    const outcome = await importBookmarks(dependencies, ask(file));

    expect(outcome).toMatchObject({ kind: "imported", result: { created: 4, slugsDropped: 3 } });
    expect(written.choices).toEqual([]);
  });

  it("restores nothing for a bookmark that was skipped as a duplicate, failed or was left out for the limit", async () => {
    const { written, dependencies } = fixture({ existing: ["https://example.com/dup"], room: 1 });
    const file = envelope(
      [link("b1", "kept"), link("dup", "dup-slug", { url: "https://example.com/dup" }), link("bad", "bad-slug", { url: "bogus" }), link("b4", "late")],
      [
        { slug: "dup-slug", bookmarkRef: "dup" },
        { slug: "bad-slug", bookmarkRef: "bad" },
        { slug: "late", bookmarkRef: "b4" },
      ],
    );

    const outcome = await importBookmarks(dependencies, ask(file, { ceiling: 1 }));

    expect(outcome).toMatchObject({ kind: "imported", result: { created: 1 } });
    expect(written.choices).toEqual([]);
  });

  it("restores nothing for a bookmark that does not forward, for a slug the bookmark does not have and for a bookmark with no slug", async () => {
    const { written, dependencies } = fixture();
    const file = envelope(
      [link("b1", "quiet", { forwarding: false }), link("b2", "other"), { ref: "b3", url: "https://example.com/b3" }],
      [
        { slug: "quiet", bookmarkRef: "b1" },
        { slug: "docs", bookmarkRef: "b2" },
        { slug: "docs", bookmarkRef: "b3" },
      ],
    );

    await importBookmarks(dependencies, ask(file));

    expect(written.choices).toEqual([]);
  });

  it("restores nothing for a ref no bookmark of the file has, for a ref more than one has, and for a slug outside the grammar, and fails nothing", async () => {
    const { written, dependencies } = fixture();
    const file = envelope(
      [link("b1", "docs"), link("b1", "news", { url: "https://example.com/b1-again" }), link("b3", "fine")],
      [
        { slug: "docs", bookmarkRef: "b1" },
        { slug: "news", bookmarkRef: "b1" },
        { slug: "fine", bookmarkRef: "b9" },
        { slug: "Not A Slug!", bookmarkRef: "b3" },
        { slug: "", bookmarkRef: "b3" },
        { slug: "x".repeat(1000), bookmarkRef: "b3" },
      ],
    );

    const outcome = await importBookmarks(dependencies, ask(file));

    expect(outcome).toMatchObject({ kind: "imported", result: { created: 3 } });
    expect(written.choices).toEqual([]);
    expect(written.audit).toHaveLength(1);
  });

  it("restores nothing from a plain array or a document with no list or an empty one", async () => {
    for (const file of [[link("b1", "docs")], envelope([link("b1", "docs")], []), { format: "slugbase-export", version: 1, bookmarks: [link("b1", "docs")] } as ImportRequest]) {
      const { written, dependencies } = fixture();
      await importBookmarks(dependencies, ask(file));
      expect(written.choices).toEqual([]);
      expect(written.order).not.toContain("remember");
    }
  });

  it("asks once for a slug however many entries name it, and the entries that name a bookmark that lost the slug do not take the choice from the one that kept it", async () => {
    const { written, dependencies } = fixture();
    const entries = Array.from({ length: 1000 }, (_, index) => ({ slug: "docs", bookmarkRef: index % 2 === 0 ? "b1" : "b2" }));

    await importBookmarks(dependencies, ask(envelope([link("b1", "docs"), link("b2", "docs")], entries)));

    expect(written.choices).toEqual([{ slug: "docs", bookmarkId: idOf(written, "https://example.com/b1") }]);
  });

  it("asks the store once for all of the choices of a file, at most one for each slug and never more than there are bookmarks created with a slug", async () => {
    const { written, dependencies } = fixture();
    const bookmarks = Array.from({ length: 50 }, (_, index) => link(`b${String(index + 1)}`, `s${String(index + 1)}`));
    const entries = [...bookmarks, ...bookmarks, ...bookmarks].map((bookmark) => ({ slug: bookmark.slug, bookmarkRef: bookmark.ref }));

    await importBookmarks(dependencies, ask(envelope(bookmarks, entries)));

    expect(written.choices).toHaveLength(50);
    expect(written.choiceCalls).toEqual([50]);
    expect(new Set(written.choices.map((choice) => choice.slug)).size).toBe(50);
  });

  it("succeeds when the store refuses a choice", async () => {
    const { written, dependencies } = fixture({ refusedChoices: ["docs"] });

    const outcome = await importBookmarks(dependencies, ask(envelope([link("b1", "docs"), link("b2", "news")], [{ slug: "docs", bookmarkRef: "b1" }, { slug: "news", bookmarkRef: "b2" }])));

    expect(outcome).toMatchObject({ kind: "imported", result: { created: 2 } });
    expect(written.choices.map((choice) => choice.slug)).toEqual(["docs", "news"]);
  });

  it("rejects, and records no audit event, when the store cannot store a choice", async () => {
    const { written, dependencies } = fixture({ failChoice: true });

    await expect(importBookmarks(dependencies, ask(envelope([link("b1", "docs")], [{ slug: "docs", bookmarkRef: "b1" }])))).rejects.toThrow("the choices could not be stored");
    expect(written.audit).toEqual([]);
  });
});

describe("importBookmarks and the distinct folder and tag spellings of the file", () => {
  const refused = (all: readonly string[], perBookmark = 1000): ImportRequest =>
    Array.from({ length: Math.ceil(all.length / perBookmark) }, (_, index) => ({ url: "ftp://example.com/x", tags: all.slice(index * perBookmark, (index + 1) * perBookmark) }));
  const tags = (count: number) => Array.from({ length: count }, (_, index) => `t${String(index)}`);

  it("refuses a file of refused bookmarks that names more spellings than one import may, before the store is asked anything, and writes nothing", async () => {
    const { written, dependencies } = fixture();

    const outcome = await importBookmarks(dependencies, ask(refused(tags(IMPORT_MAX_DISTINCT_NAMES + 1))));

    expect(outcome).toEqual({ kind: "too_many_distinct_names", names: IMPORT_MAX_DISTINCT_NAMES + 1 });
    expect(written.nameCalls).toBe(0);
    expect(written.order).toEqual([]);
    expect(written.takes).toEqual([]);
    expect(written.audit).toEqual([]);
  });

  it("imports a file that names exactly that many", async () => {
    const { written, dependencies } = fixture();

    const outcome = await importBookmarks(dependencies, ask(refused(tags(IMPORT_MAX_DISTINCT_NAMES))));

    expect(outcome).toMatchObject({ kind: "imported", result: { created: 0, detected: { tags: IMPORT_MAX_DISTINCT_NAMES }, tagsCreated: 0 } });
    expect(written.audit).toHaveLength(1);
  });
});
