import { describe, expect, it } from "vitest";
import { fileBookmarks, unfileBookmarks, type FolderFilingRequest, type FolderFilingResult, type FolderFilingStore, type FolderRecord } from "../../src/index.ts";

const ACCOUNT = "0192F3A0-BBBB-7000-8000-000000000001";
const FOLDER = "0192F3A0-AAAA-7000-8000-000000000001";
const BOOKMARK_A = "0192f3a0-cccc-7000-8000-00000000000A";
const BOOKMARK_B = "0192f3a0-cccc-7000-8000-00000000000b";
const NOW = new Date("2026-10-24T05:00:00.000Z");

const FOLDER_RECORD: FolderRecord = { id: FOLDER.toLowerCase(), ownerId: ACCOUNT.toLowerCase(), name: "Reading", icon: "folder", color: 1, bookmarkCount: 2, version: 1, createdAt: NOW, updatedAt: NOW };

function filing(answer: FolderFilingResult = { kind: "done", folder: FOLDER_RECORD, changed: 2 }) {
  const calls: { method: "file" | "unfile"; request: FolderFilingRequest }[] = [];
  const store: FolderFilingStore = {
    file(request) {
      calls.push({ method: "file", request });
      return Promise.resolve(answer);
    },
    unfile(request) {
      calls.push({ method: "unfile", request });
      return Promise.resolve(answer);
    },
  };
  return { calls, dependencies: { store } };
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

  it("let the failure of the store reject, so the caller's transaction does not commit", async () => {
    const store: FolderFilingStore = {
      file: () => Promise.reject(new Error("the database refused")),
      unfile: () => Promise.reject(new Error("the database refused")),
    };
    const ask = { folderId: FOLDER, accountId: ACCOUNT, bookmarkIds: [BOOKMARK_A] };

    await expect(fileBookmarks({ store }, ask)).rejects.toThrow("the database refused");
    await expect(unfileBookmarks({ store }, ask)).rejects.toThrow("the database refused");
  });
});
