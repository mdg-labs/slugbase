import { describe, expect, it } from "vitest";
import {
  FOLDER_LIST_TOTAL_CAP,
  createFolder,
  deleteFolder,
  listFolders,
  normalizeFolderName,
  readFolder,
  updateFolder,
  type FolderCursors,
  type FolderListRow,
  type FolderPosition,
  type FolderRecord,
  type FolderStore,
  type FolderUpdateRequest,
  type NewFolder,
} from "../../src/index.ts";

const ACCOUNT = "0192F3A0-BBBB-7000-8000-000000000001";
const FOLDER = "0192f3a0-aaaa-7000-8000-000000000001";
const NOW = new Date("2026-10-24T05:00:00.000Z");

function recordOf(name: string, id = FOLDER): FolderRecord {
  return { id, ownerId: ACCOUNT.toLowerCase(), name, icon: "folder", color: 1, bookmarkCount: 0, version: 1, createdAt: NOW, updatedAt: NOW };
}

function rowOf(name: string, id = FOLDER, extra: Partial<FolderListRow> = {}): FolderListRow {
  return { ...recordOf(name, id), updatedKey: "2026-10-24 05:00:00.123456+00", ...extra };
}

/** A store that records what it is asked and answers what the test says. */
function store(answers: Partial<FolderStore> = {}) {
  const calls: { method: string; request: unknown }[] = [];
  const record = <T>(method: string, request: unknown, answer: T): Promise<T> => {
    calls.push({ method, request });
    return Promise.resolve(answer);
  };
  const dependencies: FolderStore = {
    create: answers.create ?? ((folder: NewFolder) => record("create", folder, { kind: "created", folder: recordOf(folder.name, folder.id) } as const)),
    find: answers.find ?? ((request) => record("find", request, recordOf("Found") as FolderRecord | undefined)),
    list: answers.list ?? ((request) => record("list", request, [] as readonly FolderListRow[])),
    count: answers.count ?? ((request) => record("count", request, 0)),
    update: answers.update ?? ((request: FolderUpdateRequest) => record("update", request, { kind: "updated", folder: recordOf(request.changes.name ?? "Same") } as const)),
    remove: answers.remove ?? ((request) => record("remove", request, true)),
  };
  return { calls, store: dependencies };
}

describe("normalizeFolderName", () => {
  it("keeps the case as entered and removes the whitespace around the name", () => {
    expect(normalizeFolderName("  Reading List ")).toEqual({ name: "Reading List" });
  });

  it("refuses an empty name and one that is blank once trimmed", () => {
    expect(normalizeFolderName("")).toEqual({ refusal: "empty" });
    expect(normalizeFolderName(" \t\n ")).toEqual({ refusal: "empty" });
  });

  it("allows 64 characters and refuses 65, counting a character outside the BMP once", () => {
    expect(normalizeFolderName("x".repeat(64))).toEqual({ name: "x".repeat(64) });
    expect(normalizeFolderName("x".repeat(65))).toEqual({ refusal: "too_long" });
    expect(normalizeFolderName("😀".repeat(64))).toEqual({ name: "😀".repeat(64) });
    expect(normalizeFolderName("😀".repeat(65))).toEqual({ refusal: "too_long" });
  });
});

describe("createFolder", () => {
  it("hands the store the trimmed name, a generated identifier, the account in lower case as owner and the default icon and colour", async () => {
    const { calls, store: folderStore } = store();

    const outcome = await createFolder({ store: folderStore, newId: () => FOLDER }, { accountId: ACCOUNT, name: " Reading ", icon: undefined, color: undefined });

    expect(outcome).toEqual({ kind: "created", folder: recordOf("Reading") });
    expect(calls).toEqual([{ method: "create", request: { id: FOLDER, ownerId: ACCOUNT.toLowerCase(), name: "Reading", icon: "folder", color: 1 } }]);
  });

  it("passes a chosen icon and colour on", async () => {
    const { calls, store: folderStore } = store();
    await createFolder({ store: folderStore, newId: () => FOLDER }, { accountId: ACCOUNT, name: "Trips", icon: "plane", color: 8 });
    expect(calls).toEqual([{ method: "create", request: { id: FOLDER, ownerId: ACCOUNT.toLowerCase(), name: "Trips", icon: "plane", color: 8 } }]);
  });

  it("refuses an invalid name before the store is asked", async () => {
    const { calls, store: folderStore } = store();
    const base = { accountId: ACCOUNT, icon: undefined, color: undefined };

    expect(await createFolder({ store: folderStore, newId: () => FOLDER }, { ...base, name: "  " })).toEqual({ kind: "invalid_name", reason: "empty" });
    expect(await createFolder({ store: folderStore, newId: () => FOLDER }, { ...base, name: "x".repeat(65) })).toEqual({ kind: "invalid_name", reason: "too_long" });
    expect(calls).toEqual([]);
  });

  it("throws for an icon outside the list or a colour outside 1 to 8, without asking the store", async () => {
    const { calls, store: folderStore } = store();
    const ask = { accountId: ACCOUNT, name: "Reading" };

    await expect(createFolder({ store: folderStore, newId: () => FOLDER }, { ...ask, icon: "not-an-icon", color: undefined })).rejects.toThrow(RangeError);
    await expect(createFolder({ store: folderStore, newId: () => FOLDER }, { ...ask, icon: undefined, color: 9 })).rejects.toThrow(RangeError);
    await expect(createFolder({ store: folderStore, newId: () => FOLDER }, { ...ask, icon: undefined, color: 0 })).rejects.toThrow(RangeError);
    await expect(createFolder({ store: folderStore, newId: () => FOLDER }, { ...ask, icon: undefined, color: 1.5 })).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });

  it("passes a name that is taken on, as the store answers it", async () => {
    const { store: folderStore } = store({ create: () => Promise.resolve({ kind: "name_taken" }) });

    expect(await createFolder({ store: folderStore, newId: () => FOLDER }, { accountId: ACCOUNT, name: "Taken", icon: undefined, color: undefined })).toEqual({ kind: "name_taken" });
  });
});

describe("readFolder", () => {
  it("names the folder and the owner in lower case to the store and passes its answer on", async () => {
    const { calls, store: folderStore } = store();
    expect(await readFolder({ store: folderStore }, { folderId: FOLDER, accountId: ACCOUNT })).toEqual(recordOf("Found"));
    expect(calls).toEqual([{ method: "find", request: { folderId: FOLDER, ownerId: ACCOUNT.toLowerCase() } }]);

    const { store: empty } = store({ find: () => Promise.resolve(undefined) });
    expect(await readFolder({ store: empty }, { folderId: FOLDER, accountId: ACCOUNT })).toBeUndefined();
  });
});

describe("listFolders", () => {
  const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
  const BETA = "0192f3a0-aaaa-7000-8000-000000000002";

  /** Cursors that seal a position as JSON and open only what they sealed for the same scope. */
  function cursors(scopes: string[] = []): FolderCursors {
    return {
      seal(position, scope) {
        scopes.push(scope);
        return `${scope}|${JSON.stringify(position)}`;
      },
      open(cursor, scope) {
        const [sealedFor, position] = cursor.split("|");
        return sealedFor === scope && position !== undefined ? (JSON.parse(position) as FolderPosition) : undefined;
      },
    };
  }

  const ask = { workspaceId: WORKSPACE, accountId: ACCOUNT, scope: "all", search: undefined, sort: "name", limit: 2, cursor: undefined } as const;

  it("asks the store for one folder more than the page for the account alone and the total up to one past the cap, and answers a page", async () => {
    const recording = store();
    expect(await listFolders({ store: recording.store, cursors: cursors() }, { ...ask, sort: "count", search: "read" })).toEqual({ kind: "listed", items: [], nextCursor: null, total: 0 });
    expect(recording.calls).toEqual([
      { method: "list", request: { ownerId: ACCOUNT.toLowerCase(), search: "read", sort: "count", after: undefined, limit: 3 } },
      { method: "count", request: { ownerId: ACCOUNT.toLowerCase(), search: "read", limit: FOLDER_LIST_TOTAL_CAP + 1 } },
    ]);
  });

  it("answers the first limit folders and a cursor at the last of them when another follows, and no cursor on the last page", async () => {
    const [one, two, three] = [rowOf("Alpha"), rowOf("Beta", BETA), rowOf("Gamma", "0192f3a0-aaaa-7000-8000-000000000003")];
    const scopes: string[] = [];
    const more = store({ list: () => Promise.resolve([one, two, three]), count: () => Promise.resolve(3) });
    const page = await listFolders({ store: more.store, cursors: cursors(scopes) }, ask);

    expect(page).toMatchObject({ kind: "listed", items: [one, two], total: 3 });
    expect(page.kind === "listed" ? page.nextCursor : undefined).toBe(`${scopes[0] ?? ""}|${JSON.stringify({ name: "Beta", id: BETA })}`);
    const last = store({ list: () => Promise.resolve([one, two]), count: () => Promise.resolve(2) });
    expect(await listFolders({ store: last.store, cursors: cursors() }, ask)).toEqual({ kind: "listed", items: [one, two], nextCursor: null, total: 2 });
  });

  it("carries the count of the last folder in the cursor of the sort by count and its update time as text in the cursor of the sort by update time", async () => {
    const busy = rowOf("Beta", BETA, { bookmarkCount: 4, updatedKey: "2026-10-24 05:00:00.000001+00" });
    const more = store({ list: () => Promise.resolve([busy, rowOf("Alpha")]), count: () => Promise.resolve(2) });

    const byCount = await listFolders({ store: more.store, cursors: cursors() }, { ...ask, sort: "count", limit: 1 });
    const countCursor = byCount.kind === "listed" ? byCount.nextCursor : null;
    const byUpdate = await listFolders({ store: more.store, cursors: cursors() }, { ...ask, sort: "updated", limit: 1 });
    const updateCursor = byUpdate.kind === "listed" ? byUpdate.nextCursor : null;
    expect(countCursor).not.toBeNull();
    expect(updateCursor).not.toBeNull();

    const resumed = store();
    await listFolders({ store: resumed.store, cursors: cursors() }, { ...ask, sort: "count", limit: 1, cursor: countCursor ?? "" });
    await listFolders({ store: resumed.store, cursors: cursors() }, { ...ask, sort: "updated", limit: 1, cursor: updateCursor ?? "" });
    expect(resumed.calls.filter((call) => call.method === "list").map((call) => (call.request as { after: unknown }).after)).toEqual([
      { count: 4, name: "Beta", id: BETA },
      { updated: "2026-10-24 05:00:00.000001+00", name: "Beta", id: BETA },
    ]);
  });

  it("gives a total of null above the cap", async () => {
    const full = store({ count: ({ limit }) => Promise.resolve(limit) });
    expect(await listFolders({ store: full.store, cursors: cursors() }, ask)).toEqual({ kind: "listed", items: [], nextCursor: null, total: null });
    const atTheCap = store({ count: () => Promise.resolve(FOLDER_LIST_TOTAL_CAP) });
    expect(await listFolders({ store: atTheCap.store, cursors: cursors() }, ask)).toMatchObject({ total: FOLDER_LIST_TOTAL_CAP });
  });

  it("reads nothing for a cursor sealed for another sort, search, scope, account or workspace, or one whose position does not fit its sort", async () => {
    const sealed = (scope: { sort: string; account: string; search: string | null; scope: string }, position: FolderPosition) =>
      `${JSON.stringify([WORKSPACE, scope.account.toLowerCase(), scope.scope, scope.search, scope.sort])}|${JSON.stringify(position)}`;
    const mine = { sort: "name", account: ACCOUNT, search: null, scope: "all" };
    const position = { count: undefined, updated: undefined, name: "Beta", id: BETA };
    const attempts = [
      { ...ask, sort: "count", cursor: sealed(mine, position) },
      { ...ask, cursor: sealed({ ...mine, account: "0192f3a0-bbbb-7000-8000-000000000002" }, position) },
      { ...ask, workspaceId: "0192f3a0-cccc-7000-8000-000000000002", cursor: sealed(mine, position) },
      { ...ask, search: "x", cursor: sealed(mine, position) },
      { ...ask, scope: "mine", cursor: sealed(mine, position) },
      { ...ask, sort: "count", cursor: sealed({ ...mine, sort: "count" }, position) },
      { ...ask, sort: "updated", cursor: sealed({ ...mine, sort: "updated" }, position) },
      { ...ask, cursor: sealed(mine, { ...position, count: 3 }) },
      { ...ask, cursor: sealed(mine, { ...position, updated: "2026-10-24 05:00:00+00" }) },
      { ...ask, cursor: "sealed" },
    ] as const;
    for (const attempt of attempts) {
      const recording = store();
      expect(await listFolders({ store: recording.store, cursors: cursors() }, attempt)).toEqual({ kind: "bad_cursor" });
      expect(recording.calls).toEqual([]);
    }
  });
});

describe("updateFolder", () => {
  const unchangedPatch = { name: undefined, icon: undefined, color: undefined };

  it("names the folder, the owner, the trimmed name, the other changes and the accepted versions to the store and passes its answer on", async () => {
    const { calls, store: folderStore } = store();

    const outcome = await updateFolder({ store: folderStore }, { folderId: FOLDER, accountId: ACCOUNT, patch: { name: " Beta ", icon: "star", color: 3 }, expectedVersions: [2] });

    expect(outcome).toEqual({ kind: "updated", folder: recordOf("Beta") });
    expect(calls).toEqual([{ method: "update", request: { folderId: FOLDER, ownerId: ACCOUNT.toLowerCase(), changes: { name: "Beta", icon: "star", color: 3 }, expectedVersions: [2] } }]);
  });

  it("leaves out what the patch leaves out", async () => {
    const { calls, store: folderStore } = store();
    await updateFolder({ store: folderStore }, { folderId: FOLDER, accountId: ACCOUNT, patch: { ...unchangedPatch, color: 2 }, expectedVersions: undefined });
    expect(calls).toEqual([{ method: "update", request: { folderId: FOLDER, ownerId: ACCOUNT.toLowerCase(), changes: { color: 2 }, expectedVersions: undefined } }]);
  });

  it("refuses an invalid name before the store is asked, and passes stale, name_taken, unchanged and not_found on", async () => {
    for (const answer of [{ kind: "stale" }, { kind: "name_taken" }, { kind: "unchanged", folder: recordOf("Same") }, { kind: "not_found" }] as const) {
      const { store: folderStore } = store({ update: () => Promise.resolve(answer) });
      expect(await updateFolder({ store: folderStore }, { folderId: FOLDER, accountId: ACCOUNT, patch: { name: "Same" }, expectedVersions: undefined })).toEqual(answer);
    }
    const { calls, store: folderStore } = store();
    expect(await updateFolder({ store: folderStore }, { folderId: FOLDER, accountId: ACCOUNT, patch: { name: "" }, expectedVersions: undefined })).toEqual({ kind: "invalid_name", reason: "empty" });
    await expect(updateFolder({ store: folderStore }, { folderId: FOLDER, accountId: ACCOUNT, patch: { icon: "nope" }, expectedVersions: undefined })).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});

describe("deleteFolder", () => {
  it("names the folder and the owner to the store, and answers whether it deleted one", async () => {
    const { calls, store: folderStore } = store();
    expect(await deleteFolder({ store: folderStore }, { folderId: FOLDER, accountId: ACCOUNT })).toBe(true);
    expect(calls).toEqual([{ method: "remove", request: { folderId: FOLDER, ownerId: ACCOUNT.toLowerCase() } }]);

    const { store: empty } = store({ remove: () => Promise.resolve(false) });
    expect(await deleteFolder({ store: empty }, { folderId: FOLDER, accountId: ACCOUNT })).toBe(false);
  });
});
