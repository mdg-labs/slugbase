import { describe, expect, it } from "vitest";
import { fileBookmarks, unfileBookmarks, type FolderFilingRequest, type FolderFilingStore, type FolderFilingStoreResult, type FolderRecord } from "../../src/index.ts";

const ACCOUNT = "0192F3A0-BBBB-7000-8000-000000000001";
const FOLDER = "0192F3A0-AAAA-7000-8000-000000000001";
const BOOKMARK_A = "0192f3a0-cccc-7000-8000-00000000000A";
const BOOKMARK_B = "0192f3a0-cccc-7000-8000-00000000000b";
const NOW = new Date("2026-10-24T05:00:00.000Z");

const FOLDER_RECORD: FolderRecord = { id: FOLDER.toLowerCase(), ownerId: ACCOUNT.toLowerCase(), name: "Reading", icon: "folder", color: 1, bookmarkCount: 2, version: 1, createdAt: NOW, updatedAt: NOW, owner: null, shareSummary: null };

function filing(answer: FolderFilingStoreResult = { kind: "done", folder: FOLDER_RECORD, changed: 2 }, shared: readonly string[] = [], folderShared = false) {
  const calls: { method: "file" | "unfile"; request: FolderFilingRequest }[] = [];
  const asked: { bookmarkIds: readonly string[]; accountId: string }[] = [];
  const askedFolders: { folderId: string; accountId: string }[] = [];
  const store: FolderFilingStore = {
    file(request) {
      calls.push({ method: "file", request });
      return Promise.resolve(answer);
    },
    unfile(request) {
      calls.push({ method: "unfile", request });
      return Promise.resolve(answer);
    },
    sharedAmong(request) {
      asked.push(request);
      return Promise.resolve(shared);
    },
    sharedWith(request) {
      askedFolders.push(request);
      return Promise.resolve(folderShared);
    },
  };
  return { calls, asked, askedFolders, dependencies: { store } };
}

describe("fileBookmarks and unfileBookmarks", () => {
  it("hand the store the folder and the account in lower case and the bookmarks without repeats, whatever the case they were written in", async () => {
    const { calls, dependencies } = filing();

    const ask = { folderId: FOLDER, accountId: ACCOUNT, bookmarkIds: [BOOKMARK_A, BOOKMARK_B, BOOKMARK_A.toLowerCase()] };
    await fileBookmarks(dependencies, ask);
    await unfileBookmarks(dependencies, ask);

    const request = { folderId: FOLDER.toLowerCase(), ownerId: ACCOUNT.toLowerCase(), bookmarkIds: [BOOKMARK_A.toLowerCase(), BOOKMARK_B] };
    expect(calls).toEqual([
      { method: "file", request },
      { method: "unfile", request },
    ]);
  });

  it("answer what the store answers, and a refusal carries no folder", async () => {
    const done = filing();
    const refused = filing({ kind: "not_found" });
    const ask = { folderId: FOLDER, accountId: ACCOUNT, bookmarkIds: [BOOKMARK_A] };

    expect(await fileBookmarks(done.dependencies, ask)).toEqual({ kind: "done", folder: FOLDER_RECORD, changed: 2 });
    expect(await fileBookmarks(refused.dependencies, ask)).toEqual({ kind: "not_found" });
    expect(await unfileBookmarks(refused.dependencies, ask)).toEqual({ kind: "not_found" });
  });

  it("answer forbidden, not not_found, when the store refuses and a bookmark named is shared with the caller", async () => {
    const { asked, dependencies } = filing({ kind: "not_found" }, [BOOKMARK_A.toLowerCase()]);
    const ask = { folderId: FOLDER, accountId: ACCOUNT, bookmarkIds: [BOOKMARK_A, BOOKMARK_B] };

    expect(await fileBookmarks(dependencies, ask)).toEqual({ kind: "forbidden" });
    expect(await unfileBookmarks(dependencies, ask)).toEqual({ kind: "forbidden" });
    expect(asked).toEqual([
      { bookmarkIds: [BOOKMARK_A.toLowerCase(), BOOKMARK_B], accountId: ACCOUNT.toLowerCase() },
      { bookmarkIds: [BOOKMARK_A.toLowerCase(), BOOKMARK_B], accountId: ACCOUNT.toLowerCase() },
    ]);
  });

  it("answer forbidden, not not_found, when the store refuses and the folder is shared with the caller, whichever bookmarks are named", async () => {
    const { asked, askedFolders, dependencies } = filing({ kind: "not_found" }, [], true);
    const ask = { folderId: FOLDER, accountId: ACCOUNT, bookmarkIds: [BOOKMARK_A, BOOKMARK_B] };

    expect(await fileBookmarks(dependencies, ask)).toEqual({ kind: "forbidden" });
    expect(await unfileBookmarks(dependencies, ask)).toEqual({ kind: "forbidden" });
    expect(askedFolders).toEqual([
      { folderId: FOLDER.toLowerCase(), accountId: ACCOUNT.toLowerCase() },
      { folderId: FOLDER.toLowerCase(), accountId: ACCOUNT.toLowerCase() },
    ]);
    expect(asked).toEqual([]);
  });

  it("keep not_found when neither the folder nor a bookmark named is shared with the caller, and ask nothing when the store filed", async () => {
    const refused = filing({ kind: "not_found" });
    const done = filing();
    const ask = { folderId: FOLDER, accountId: ACCOUNT, bookmarkIds: [BOOKMARK_A] };

    expect(await fileBookmarks(refused.dependencies, ask)).toEqual({ kind: "not_found" });
    expect(await unfileBookmarks(refused.dependencies, ask)).toEqual({ kind: "not_found" });
    await fileBookmarks(done.dependencies, ask);
    expect(done.asked).toEqual([]);
    expect(done.askedFolders).toEqual([]);
  });

  it("let the failure of the store reject, so the caller's transaction does not commit", async () => {
    const store: FolderFilingStore = {
      file: () => Promise.reject(new Error("the database refused")),
      unfile: () => Promise.reject(new Error("the database refused")),
      sharedAmong: () => Promise.resolve([]),
      sharedWith: () => Promise.resolve(false),
    };
    const ask = { folderId: FOLDER, accountId: ACCOUNT, bookmarkIds: [BOOKMARK_A] };

    await expect(fileBookmarks({ store }, ask)).rejects.toThrow("the database refused");
    await expect(unfileBookmarks({ store }, ask)).rejects.toThrow("the database refused");
  });
});
