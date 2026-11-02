import type { ImportRequest } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import { createAuditWriter, IMPORT_BATCH_SIZE, importBookmarks, type AuditRecord, type ImportAsk, type ImportNewBookmark, type ImportPlaces, type ImportStore } from "../../src/index.ts";

// The import that writes (doc 02 section 13.1, doc 01 section 7.5, doc 10 T11 and T13): what the service asks of the store, in which order, and what it writes when a step fails.

interface Written {
  readonly takes: { ceiling: number | null; wanted: number }[];
  readonly batches: { bookmarks: readonly ImportNewBookmark[]; events: readonly { eventId: string; name: string; payload: unknown }[] }[];
  readonly order: string[];
  readonly audit: AuditRecord[];
}

interface Options {
  /** The places the store has left; unlimited when left out. */
  room?: number;
  existing?: readonly string[];
  unavailable?: boolean;
  failBatch?: number;
  failAudit?: boolean;
}

function fixture(options: Options = {}) {
  const written: Written = { takes: [], batches: [], order: [], audit: [] };
  const store: ImportStore = {
    bookmarkCount: () => Promise.reject(new Error("the import never reads the counter outside the lock")),
    existingCanonicalUrls: (canonicals) => {
      written.order.push("lookup");
      return Promise.resolve(new Set(canonicals.filter((canonical) => (options.existing ?? []).includes(canonical))));
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
      return Promise.resolve();
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
});
