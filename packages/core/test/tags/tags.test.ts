import { describe, expect, it } from "vitest";
import {
  TAG_LIST_TOTAL_CAP,
  TAG_NAME_MAX_LENGTH,
  createTag,
  deleteTag,
  listTags,
  mergeTag,
  normalizeTagName,
  renameTag,
  tagStats,
  type NewTag,
  type TagCursors,
  type TagMergeRequest,
  type TagPosition,
  type TagRecord,
  type TagRenameRequest,
  type TagStore,
} from "../../src/index.ts";

const ACCOUNT = "0192F3A0-BBBB-7000-8000-000000000001";
const TAG = "0192f3a0-aaaa-7000-8000-000000000001";
const NOW = new Date("2026-10-24T05:00:00.000Z");

function recordOf(name: string, id = TAG): TagRecord {
  return { id, name, bookmarkCount: 0, createdAt: NOW };
}

/** A store that records what it is asked and answers what the test says. */
function store(answers: Partial<TagStore> = {}) {
  const calls: { method: string; request: unknown }[] = [];
  const record = <T>(method: string, request: unknown, answer: T): Promise<T> => {
    calls.push({ method, request });
    return Promise.resolve(answer);
  };
  const dependencies: TagStore = {
    create: answers.create ?? ((tag: NewTag) => record("create", tag, { kind: "created", tag: recordOf(tag.name, tag.id) } as const)),
    list: answers.list ?? ((request) => record("list", request, [] as readonly TagRecord[])),
    count: answers.count ?? ((ownerId, limit) => record("count", { ownerId, limit }, 0)),
    rename: answers.rename ?? ((request: TagRenameRequest) => record("rename", request, { kind: "renamed", tag: recordOf(request.name) } as const)),
    merge: answers.merge ?? ((request: TagMergeRequest) => record("merge", request, { kind: "merged", tag: recordOf("Target", request.targetId) } as const)),
    remove: answers.remove ?? ((request) => record("remove", request, true)),
  };
  return { calls, store: dependencies };
}

describe("normalizeTagName", () => {
  it("keeps the case as entered and removes the whitespace around the name", () => {
    expect(normalizeTagName("  Read Later ")).toEqual({ name: "Read Later" });
    expect(normalizeTagName("ÄÖÜ")).toEqual({ name: "ÄÖÜ" });
  });

  it("refuses an empty name and one that is blank once trimmed", () => {
    expect(normalizeTagName("")).toEqual({ refusal: "empty" });
    expect(normalizeTagName(" \t\n ")).toEqual({ refusal: "empty" });
  });

  it("allows 40 characters and refuses 41, counting a character outside the BMP once", () => {
    expect(TAG_NAME_MAX_LENGTH).toBe(40);
    expect(normalizeTagName("x".repeat(40))).toEqual({ name: "x".repeat(40) });
    expect(normalizeTagName("x".repeat(41))).toEqual({ refusal: "too_long" });
    expect(normalizeTagName("😀".repeat(40))).toEqual({ name: "😀".repeat(40) });
    expect(normalizeTagName("😀".repeat(41))).toEqual({ refusal: "too_long" });
  });
});

describe("createTag", () => {
  it("hands the store the trimmed name, a generated identifier and the account in lower case as owner", async () => {
    const { calls, store: tagStore } = store();

    const outcome = await createTag({ store: tagStore, newId: () => TAG }, { accountId: ACCOUNT, name: " Read Later " });

    expect(outcome).toEqual({ kind: "created", tag: recordOf("Read Later") });
    expect(calls).toEqual([{ method: "create", request: { id: TAG, ownerId: ACCOUNT.toLowerCase(), name: "Read Later" } }]);
  });

  it("refuses an invalid name before the store is asked", async () => {
    const { calls, store: tagStore } = store();

    expect(await createTag({ store: tagStore, newId: () => TAG }, { accountId: ACCOUNT, name: "  " })).toEqual({ kind: "invalid_name", reason: "empty" });
    expect(await createTag({ store: tagStore, newId: () => TAG }, { accountId: ACCOUNT, name: "x".repeat(41) })).toEqual({ kind: "invalid_name", reason: "too_long" });
    expect(calls).toEqual([]);
  });

  it("passes a name that is taken on, as the store answers it", async () => {
    const { store: tagStore } = store({ create: () => Promise.resolve({ kind: "name_taken" }) });

    expect(await createTag({ store: tagStore, newId: () => TAG }, { accountId: ACCOUNT, name: "Taken" })).toEqual({ kind: "name_taken" });
  });
});

describe("listTags", () => {
  const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
  const BETA = "0192f3a0-aaaa-7000-8000-000000000002";
  const CURSOR = "sealed";

  /** Cursors that seal a position as JSON and open only what they sealed for the same scope. */
  function cursors(scopes: string[] = []): TagCursors {
    return {
      seal(position, scope) {
        scopes.push(scope);
        return `${scope}|${JSON.stringify(position)}`;
      },
      open(cursor, scope) {
        const [sealedFor, position] = cursor.split("|");
        return sealedFor === scope && position !== undefined ? (JSON.parse(position) as TagPosition) : undefined;
      },
    };
  }

  const ask = { workspaceId: WORKSPACE, accountId: ACCOUNT, sort: "name", limit: 2, cursor: undefined } as const;

  it("asks the store for one tag more than the page for the account alone and the total up to one past the cap, and answers a page", async () => {
    const recording = store();
    expect(await listTags({ store: recording.store, cursors: cursors() }, { ...ask, sort: "count" })).toEqual({ kind: "listed", items: [], nextCursor: null, total: 0 });
    expect(recording.calls).toEqual([
      { method: "list", request: { ownerId: ACCOUNT.toLowerCase(), sort: "count", after: undefined, limit: 3 } },
      { method: "count", request: { ownerId: ACCOUNT.toLowerCase(), limit: TAG_LIST_TOTAL_CAP + 1 } },
    ]);
  });

  it("answers the first limit tags and a cursor at the last of them when another follows, and no cursor on the last page", async () => {
    const [one, two, three] = [recordOf("Alpha"), recordOf("Beta", BETA), recordOf("Gamma", "0192f3a0-aaaa-7000-8000-000000000003")];
    const scopes: string[] = [];
    const more = store({ list: () => Promise.resolve([one, two, three]), count: () => Promise.resolve(3) });
    const page = await listTags({ store: more.store, cursors: cursors(scopes) }, ask);

    expect(page).toMatchObject({ kind: "listed", items: [one, two], total: 3 });
    expect(page.kind === "listed" ? page.nextCursor : undefined).toBe(`${scopes[0] ?? ""}|${JSON.stringify({ name: "Beta", id: BETA })}`);
    const last = store({ list: () => Promise.resolve([one, two]), count: () => Promise.resolve(2) });
    expect(await listTags({ store: last.store, cursors: cursors() }, ask)).toEqual({ kind: "listed", items: [one, two], nextCursor: null, total: 2 });
  });

  it("carries the count of the last tag in the cursor of the sort by count and resumes from the position it opens", async () => {
    const busy = { ...recordOf("Beta", BETA), bookmarkCount: 4 };
    const more = store({ list: () => Promise.resolve([busy, recordOf("Alpha")]), count: () => Promise.resolve(2) });
    const page = await listTags({ store: more.store, cursors: cursors() }, { ...ask, sort: "count", limit: 1 });
    const cursor = page.kind === "listed" ? page.nextCursor : null;
    expect(cursor).not.toBeNull();

    const resumed = store();
    await listTags({ store: resumed.store, cursors: cursors() }, { ...ask, sort: "count", limit: 1, cursor: cursor ?? "" });
    expect(resumed.calls[0]).toEqual({ method: "list", request: { ownerId: ACCOUNT.toLowerCase(), sort: "count", after: { count: 4, name: "Beta", id: BETA }, limit: 2 } });
  });

  it("gives a total of null above the cap", async () => {
    const full = store({ count: (_owner, limit) => Promise.resolve(limit) });
    expect(await listTags({ store: full.store, cursors: cursors() }, ask)).toEqual({ kind: "listed", items: [], nextCursor: null, total: null });
    const atTheCap = store({ count: () => Promise.resolve(TAG_LIST_TOTAL_CAP) });
    expect(await listTags({ store: atTheCap.store, cursors: cursors() }, ask)).toMatchObject({ total: TAG_LIST_TOTAL_CAP });
  });

  it("reads nothing for a cursor sealed for another sort, account or workspace, or one whose position does not fit its sort", async () => {
    const sealed = (sort: string, account: string, position: TagPosition) => `${JSON.stringify([WORKSPACE, account.toLowerCase(), sort])}|${JSON.stringify(position)}`;
    const attempts = [
      { ...ask, sort: "count", cursor: sealed("name", ACCOUNT, { count: undefined, name: "Beta", id: BETA }) },
      { ...ask, cursor: sealed("name", "0192f3a0-bbbb-7000-8000-000000000002", { count: undefined, name: "Beta", id: BETA }) },
      { ...ask, workspaceId: "0192f3a0-cccc-7000-8000-000000000002", cursor: sealed("name", ACCOUNT, { count: undefined, name: "Beta", id: BETA }) },
      { ...ask, sort: "count", cursor: sealed("count", ACCOUNT, { count: undefined, name: "Beta", id: BETA }) },
      { ...ask, cursor: sealed("name", ACCOUNT, { count: 3, name: "Beta", id: BETA }) },
      { ...ask, cursor: CURSOR },
    ] as const;
    for (const attempt of attempts) {
      const recording = store();
      expect(await listTags({ store: recording.store, cursors: cursors() }, attempt)).toEqual({ kind: "bad_cursor" });
      expect(recording.calls).toEqual([]);
    }
  });
});

describe("renameTag", () => {
  it("names the tag, the owner and the trimmed name to the store and passes its answer on", async () => {
    const { calls, store: tagStore } = store();

    const outcome = await renameTag({ store: tagStore }, { tagId: TAG, accountId: ACCOUNT, name: " Beta " });

    expect(outcome).toEqual({ kind: "renamed", tag: recordOf("Beta") });
    expect(calls).toEqual([{ method: "rename", request: { tagId: TAG, ownerId: ACCOUNT.toLowerCase(), name: "Beta" } }]);
  });

  it("refuses an invalid name before the store is asked, and passes name_taken, unchanged and not_found on", async () => {
    for (const answer of [{ kind: "name_taken" }, { kind: "unchanged", tag: recordOf("Same") }, { kind: "not_found" }] as const) {
      const { store: tagStore } = store({ rename: () => Promise.resolve(answer) });
      expect(await renameTag({ store: tagStore }, { tagId: TAG, accountId: ACCOUNT, name: "Same" })).toEqual(answer);
    }
    const { calls, store: tagStore } = store();
    expect(await renameTag({ store: tagStore }, { tagId: TAG, accountId: ACCOUNT, name: "" })).toEqual({ kind: "invalid_name", reason: "empty" });
    expect(calls).toEqual([]);
  });
});

describe("deleteTag", () => {
  it("names the tag and the owner to the store, and answers whether it deleted one", async () => {
    const { calls, store: tagStore } = store();
    expect(await deleteTag({ store: tagStore }, { tagId: TAG, accountId: ACCOUNT })).toBe(true);
    expect(calls).toEqual([{ method: "remove", request: { tagId: TAG, ownerId: ACCOUNT.toLowerCase() } }]);

    const { store: empty } = store({ remove: () => Promise.resolve(false) });
    expect(await deleteTag({ store: empty }, { tagId: TAG, accountId: ACCOUNT })).toBe(false);
  });
});

describe("mergeTag", () => {
  const TARGET = "0192f3a0-aaaa-7000-8000-000000000002";

  it("names the source, the target and the owner to the store, in lower case, and passes its answer on", async () => {
    const { calls, store: tagStore } = store();

    const outcome = await mergeTag({ store: tagStore }, { tagId: TAG.toUpperCase(), intoTagId: TARGET.toUpperCase(), accountId: ACCOUNT });

    expect(outcome).toEqual({ kind: "merged", tag: recordOf("Target", TARGET) });
    expect(calls).toEqual([{ method: "merge", request: { sourceId: TAG, targetId: TARGET, ownerId: ACCOUNT.toLowerCase() } }]);
  });

  it("passes not_found and same_tag on, whatever the store judged", async () => {
    for (const answer of [{ kind: "not_found" }, { kind: "same_tag" }] as const) {
      const { store: tagStore } = store({ merge: () => Promise.resolve(answer) });
      expect(await mergeTag({ store: tagStore }, { tagId: TAG, intoTagId: TAG, accountId: ACCOUNT })).toEqual(answer);
    }
  });
});

describe("tagStats", () => {
  it("asks the store for the owner's tags by count, up to the limit, and for the capped total", async () => {
    const tags = [{ ...recordOf("Popular"), bookmarkCount: 3 }, recordOf("Unused", "0192f3a0-aaaa-7000-8000-000000000002")];
    const asked: unknown[] = [];
    const { store: tagStore } = store({
      list: (request) => {
        asked.push(request);
        return Promise.resolve(tags);
      },
      count: () => Promise.resolve(7),
    });

    expect(await tagStats({ store: tagStore }, { accountId: ACCOUNT, limit: 2 })).toEqual({ items: tags, total: 7 });
    expect(asked).toEqual([{ ownerId: ACCOUNT.toLowerCase(), sort: "count", after: undefined, limit: 2 }]);
  });

  it("gives no total above the cap and the total at it", async () => {
    const asking = (counted: number) => tagStats({ store: store({ count: () => Promise.resolve(counted) }).store }, { accountId: ACCOUNT, limit: 50 });

    expect((await asking(TAG_LIST_TOTAL_CAP)).total).toBe(TAG_LIST_TOTAL_CAP);
    expect((await asking(TAG_LIST_TOTAL_CAP + 1)).total).toBeNull();
  });
});
