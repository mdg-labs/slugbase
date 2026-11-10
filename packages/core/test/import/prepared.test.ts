import { BOOKMARK_URL_MAX_LENGTH, IMPORT_MAX_BOOKMARKS, IMPORT_MAX_DISTINCT_NAMES, type ImportRequest } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import {
  createAuditWriter,
  importBookmarks,
  importPrepared,
  prepareImport,
  previewImport,
  previewPrepared,
  readPreparedImport,
  type ImportAsk,
  type ImportDependencies,
  type ImportStore,
  type PreparedImport,
} from "../../src/index.ts";

// A file is prepared once (`prepareImport`), possibly on another thread, and the import and the preview then run on what was prepared. The preparation must change nothing about the answer, and what comes back from
// another thread is checked before the database sees any of it (`readPreparedImport`, doc 10 T13).

function fixture() {
  const calls: string[] = [];
  const writes: unknown[] = [];
  const store: ImportStore = {
    bookmarkCount: () => Promise.resolve(2),
    existingCanonicalUrls: (canonicals) => {
      calls.push(`urls:${canonicals.join("|")}`);
      return Promise.resolve(new Set(canonicals.filter((canonical) => canonical === "https://example.com/known")));
    },
    existingSlugs: (slugs) => {
      calls.push(`slugs:${slugs.join("|")}`);
      return Promise.resolve(new Set(slugs.filter((slug) => slug === "taken")));
    },
    existingFolderNames: (names) => Promise.resolve(new Set(names.filter((name) => name === "Reading"))),
    existingTagNames: (names) => Promise.resolve(new Set(names.filter((name) => name === "later"))),
    firstSameNames: (names) => {
      const firsts = new Map<string, number>();
      return Promise.resolve(names.map((name, index) => firsts.get(name.toLowerCase()) ?? (firsts.set(name.toLowerCase(), index), index)));
    },
    resolveFolders: (folders) => {
      writes.push(["folders", folders.map(({ name, icon, color }) => [name, icon, color])]);
      return Promise.resolve({ ids: new Map(folders.map((folder) => [folder.name, `folder:${folder.name}`])), created: folders.filter((folder) => folder.name !== "Reading").length });
    },
    resolveTags: (tags) => {
      writes.push(["tags", tags.map((tag) => tag.name)]);
      return Promise.resolve({ ids: new Map(tags.map((tag) => [tag.name, `tag:${tag.name}`])), created: tags.filter((tag) => tag.name !== "later").length });
    },
    linkBookmarks: (links) => {
      writes.push(["links", links.folders.map((link) => link.folderId), links.tags.map((link) => link.tagId)]);
      return Promise.resolve();
    },
    rememberChoices: (choices) => {
      writes.push(["choices", choices]);
      return Promise.resolve(choices.length);
    },
    takePlaces: (_ceiling, wanted) => Promise.resolve({ kind: "taken", taken: wanted, used: wanted }),
    insertBookmarks: (batch) => {
      writes.push(["insert", batch.bookmarks.map((bookmark) => [bookmark.url, bookmark.title, bookmark.slug, bookmark.forwarding, bookmark.pinned])]);
      return Promise.resolve({ slugsLost: [] });
    },
  };
  let bookmarkNumber = 0;
  let eventNumber = 0;
  const dependencies: ImportDependencies = {
    store,
    audit: createAuditWriter({
      store: {
        insert: (record) => {
          writes.push(["audit", record.action, record.metadata]);
          return Promise.resolve();
        },
      },
      newId: () => "00000000-0000-7000-8000-000000000999",
    }),
    newBookmarkId: () => `00000000-0000-7000-8000-${String(100_000_000_000 + bookmarkNumber++)}`,
    newId: () => `00000000-0000-7000-8000-${String(200_000_000_000 + eventNumber++)}`,
  };
  return { calls, writes, dependencies };
}

const ask: Omit<ImportAsk, "file"> = {
  skipDuplicates: true,
  ceiling: "unlimited",
  workspaceId: "00000000-0000-7000-8000-0000000000aa",
  accountId: "00000000-0000-7000-8000-0000000000bb",
  actor: { type: "account", accountId: "00000000-0000-7000-8000-0000000000bb", label: "Ada" },
  ipPrefix: null,
};

/** A document with every part the preparation reads: listed folders and tags, names that differ in case, a duplicate, a bad URL, slugs (kept, taken, invalid, repeated) and remembered choices. */
const document: ImportRequest = {
  format: "slugbase-export",
  version: 1,
  folders: [{ name: "Reading", icon: "book" }, { name: "Empty", color: 3 }],
  tags: ["later", "Spare"],
  bookmarks: [
    { ref: "a", url: "https://example.com/one", title: "One", slug: "one", forwarding: true, pinned: true, folders: ["Reading", "reading", "Work"], tags: ["later", "LATER", "new"] },
    { ref: "b", url: "https://example.com/known", title: "Known" },
    { ref: "c", url: "javascript:alert(1)", title: "Bad" },
    { ref: "d", url: "https://example.com/two", slug: "taken", forwarding: true, folders: ["work"] },
    { ref: "d", url: "https://example.com/three", slug: "Not A Slug!", tags: ["Spare"] },
    { url: "https://example.com/four", slug: "one", forwarding: true },
  ],
  goPreferences: [
    { slug: "one", bookmarkRef: "a" },
    { slug: "taken", bookmarkRef: "d" },
  ],
};

/** What another thread hands back: the prepared import as structured clone leaves it. */
const handedOver = (prepared: PreparedImport): PreparedImport | undefined => readPreparedImport(structuredClone(prepared));

describe("a prepared import", () => {
  it("is imported exactly as the file is: the same questions to the store, the same writes, the same answer", async () => {
    const direct = fixture();
    const viaFile = await importBookmarks(direct.dependencies, { ...ask, file: document });

    const prepared = handedOver(prepareImport(document));
    expect(prepared).toBeDefined();
    const other = fixture();
    const viaPrepared = await importPrepared(other.dependencies, { ...ask, prepared: prepared ?? { kind: "too_many_distinct_names", names: 0 } });

    expect(viaFile).toMatchObject({ kind: "imported", result: { created: 4, slugsDropped: 3 } });
    expect(viaPrepared).toEqual(viaFile);
    expect(other.calls).toEqual(direct.calls);
    expect(other.writes).toEqual(direct.writes);
    expect(direct.writes).toContainEqual(["choices", [{ slug: "one", bookmarkId: "00000000-0000-7000-8000-100000000000" }]]);
  });

  it("is previewed exactly as the file is", async () => {
    const direct = fixture();
    const viaFile = await previewImport({ store: direct.dependencies.store }, { file: document, skipDuplicates: true, ceiling: 5 });
    const other = fixture();
    const prepared = handedOver(prepareImport(document));
    const viaPrepared = await previewPrepared({ store: other.dependencies.store }, { prepared: prepared ?? { kind: "too_many_distinct_names", names: 0 }, skipDuplicates: true, ceiling: 5 });

    expect(viaFile).toMatchObject({ kind: "previewed", result: { created: 3 } });
    expect(viaPrepared).toEqual(viaFile);
    expect(other.calls).toEqual(direct.calls);
  });

  it("answers a plain array of bookmarks too", async () => {
    const file: ImportRequest = [{ url: "https://example.com/a", tags: ["x"] }, { url: "nope" }];
    const direct = fixture();
    const other = fixture();

    const viaFile = await importBookmarks(direct.dependencies, { ...ask, file });
    const viaPrepared = await importPrepared(other.dependencies, { ...ask, prepared: handedOver(prepareImport(file)) ?? { kind: "too_many_distinct_names", names: 0 } });

    expect(viaPrepared).toEqual(viaFile);
    expect(other.writes).toEqual(direct.writes);
  });

  it("is the refusal of a file that names too many distinct folders and tags, before any bookmark is read and before the store is asked anything", async () => {
    const tags = Array.from({ length: IMPORT_MAX_DISTINCT_NAMES + 1 }, (_, index) => `tag ${String(index)}`);
    const prepared = prepareImport({ format: "slugbase-export", version: 1, tags, bookmarks: [{ url: "https://example.com/a" }] });
    const { calls, writes, dependencies } = fixture();

    expect(prepared).toEqual({ kind: "too_many_distinct_names", names: IMPORT_MAX_DISTINCT_NAMES + 1 });
    expect(handedOver(prepared)).toEqual(prepared);
    expect(await importPrepared(dependencies, { ...ask, prepared })).toEqual({ kind: "too_many_distinct_names", names: IMPORT_MAX_DISTINCT_NAMES + 1 });
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("readPreparedImport", () => {
  const ready = (): Extract<PreparedImport, { kind: "ready" }> => {
    const prepared = prepareImport(document);
    if (prepared.kind !== "ready") {
      throw new Error("not ready");
    }
    return structuredClone(prepared);
  };
  const mutated = (change: (prepared: Record<string, unknown>) => void): unknown => {
    const copy = structuredClone(ready()) as unknown as Record<string, unknown>;
    change(copy);
    return copy;
  };
  /** The member `index` of the list `prepared[key]` (or of `prepared.names`/`prepared.choices` for the lists inside them), which the test then changes. */
  const member = (list: unknown, index: number): Record<string, unknown> => {
    const found = (list as Record<string, unknown>[])[index];
    if (found === undefined) {
      throw new Error(`no member ${String(index)}`);
    }
    return found;
  };
  const reads = (prepared: Record<string, unknown>): Record<string, unknown>[] => prepared["reads"] as Record<string, unknown>[];

  it("takes what prepareImport makes, unchanged", () => {
    expect(readPreparedImport(ready())).toEqual(ready());
  });

  it.each([
    ["nothing", undefined],
    ["a string", "ready"],
    ["an array", []],
    ["another kind", { kind: "done" }],
    ["a refusal that is not over the bound", { kind: "too_many_distinct_names", names: IMPORT_MAX_DISTINCT_NAMES }],
    ["a refusal with a fraction", { kind: "too_many_distinct_names", names: IMPORT_MAX_DISTINCT_NAMES + 0.5 }],
    ["a refusal with a member more", { kind: "too_many_distinct_names", names: IMPORT_MAX_DISTINCT_NAMES + 1, reads: [] }],
    ["a ready import without choices", mutated((prepared) => delete prepared["choices"])],
    ["a member more", mutated((prepared) => (prepared["extra"] = 1))],
    ["reads that are no array", mutated((prepared) => (prepared["reads"] = {}))],
    ["more reads than a file holds", mutated((prepared) => (prepared["reads"] = Array.from({ length: IMPORT_MAX_BOOKMARKS + 1 }, () => ({}))))],
    ["a read out of place", mutated((prepared) => (member(reads(prepared), 1)["position"] = 5))],
    ["a read with a URL over the longest URL", mutated((prepared) => (member(reads(prepared), 0)["url"] = `https://example.com/${"a".repeat(BOOKMARK_URL_MAX_LENGTH)}`))],
    ["a read without its canonical URL", mutated((prepared) => delete member(reads(prepared), 0)["canonical"])],
    ["a read with a title that is no string", mutated((prepared) => (member(reads(prepared), 0)["title"] = 7))],
    ["a read with an unknown slug kind", mutated((prepared) => (member(reads(prepared), 0)["slug"] = { kind: "other" }))],
    ["a read with a folder name that is empty", mutated((prepared) => (member(reads(prepared), 0)["folders"] = [""]))],
    ["a read with a folder name over its limit", mutated((prepared) => (member(reads(prepared), 0)["folders"] = ["x".repeat(200)]))],
    ["a refusal with an unknown reason", mutated((prepared) => (member(reads(prepared), 2)["reason"] = "because"))],
    ["a listed folder with a colour outside 1 to 8", mutated((prepared) => (member((prepared["names"] as Record<string, unknown>)["listedFolders"], 0)["color"] = 9))],
    ["tags that are no list", mutated((prepared) => ((prepared["names"] as Record<string, unknown>)["tags"] = "new"))],
    ["a choice with a place that is not a place", mutated((prepared) => (member((prepared["choices"] as Record<string, unknown>)["refs"], 0)["place"] = 0))],
  ])("refuses %s", (_name, value) => {
    expect(readPreparedImport(value)).toBeUndefined();
  });

  it("refuses names that together pass the bound of distinct folder and tag spellings, whichever list they are in", () => {
    const names = Array.from({ length: IMPORT_MAX_DISTINCT_NAMES / 2 + 1 }, (_, index) => `n${String(index)}`);
    const over = mutated((prepared) => {
      (prepared["names"] as Record<string, unknown>)["folders"] = names;
      (prepared["names"] as Record<string, unknown>)["tags"] = names;
    });

    expect(readPreparedImport(over)).toBeUndefined();
  });
});
