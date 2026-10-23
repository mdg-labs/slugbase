import { describe, expect, it } from "vitest";
import { archiveBookmarks, BookmarkArchiveError, createAuditWriter, EntitlementVersionError, restoreBookmarks, type AuditRecord, type BookmarkArchiveTransaction } from "../../src/index.ts";

const WORKSPACE = "0192f3a0-aaaa-7000-8000-00000000000a";
const OTHER = "0192f3a0-aaaa-7000-8000-000000000002";
const FIRST = "0192f3a0-bbbb-7000-8000-00000000000B";
const SECOND = "0192f3a0-bbbb-7000-8000-000000000002";

function transaction(options: { workspaceId?: string | undefined; changed?: number | undefined; bumped?: number | undefined } = {}) {
  const requests: { bookmarkIds: readonly string[]; archived: boolean }[] = [];
  const steps: string[] = [];
  const records: AuditRecord[] = [];
  const tx: BookmarkArchiveTransaction = {
    workspaceId: "workspaceId" in options ? options.workspaceId : WORKSPACE,
    setArchived(request) {
      requests.push(request);
      steps.push("setArchived");
      return Promise.resolve("changed" in options ? options.changed : request.bookmarkIds.length);
    },
    entitlementVersion: {
      bump() {
        steps.push("bump");
        return Promise.resolve("bumped" in options ? options.bumped : 2);
      },
    },
    audit: createAuditWriter({
      store: {
        insert(record) {
          records.push(record);
          return Promise.resolve();
        },
      },
      newId: () => "0192f3a0-eeee-7000-8000-000000000001",
    }),
  };
  return { tx, requests, records, steps };
}

describe("archiveBookmarks", () => {
  it("archives the bookmarks and writes one bookmark.archived event with the count and nothing else", async () => {
    const { tx, requests, records } = transaction({ changed: 1 });

    const result = await archiveBookmarks(tx, { workspaceId: WORKSPACE, bookmarkIds: [FIRST, SECOND] });

    expect(result).toEqual({ archived: 1 });
    expect(requests).toEqual([{ bookmarkIds: [FIRST.toLowerCase(), SECOND], archived: true }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspaceId: WORKSPACE,
      action: "bookmark.archived",
      actorType: "system",
      entityType: null,
      entityId: null,
      metadata: { count: "1" },
    });
    expect(Object.keys(records[0]?.metadata ?? {})).toEqual(["count"]);
  });

  it("passes on each identifier once, in lower case, and drops what is not an identifier", async () => {
    const { tx, requests } = transaction();

    await archiveBookmarks(tx, { workspaceId: WORKSPACE.toUpperCase(), bookmarkIds: [FIRST, FIRST.toLowerCase(), "not-an-id", "", SECOND, " " + SECOND] });

    expect(requests).toEqual([{ bookmarkIds: [FIRST.toLowerCase(), SECOND], archived: true }]);
  });

  it("writes the event with a count of zero when nothing changed", async () => {
    const { tx, records } = transaction({ changed: 0 });

    expect(await archiveBookmarks(tx, { workspaceId: WORKSPACE, bookmarkIds: [FIRST] })).toEqual({ archived: 0 });

    expect(records.map((record) => record.metadata)).toEqual([{ count: "0" }]);
  });

  it("refuses a workspace other than the one the transaction acts in, and one without a workspace, before anything is written", async () => {
    const other = transaction();
    const none = transaction({ workspaceId: undefined });

    await expect(archiveBookmarks(other.tx, { workspaceId: OTHER, bookmarkIds: [FIRST] })).rejects.toThrow(BookmarkArchiveError);
    await expect(archiveBookmarks(none.tx, { workspaceId: WORKSPACE, bookmarkIds: [FIRST] })).rejects.toThrow(BookmarkArchiveError);

    expect([other.requests, other.records, none.requests, none.records]).toEqual([[], [], [], []]);
  });

  it("rejects, writing no event, when the workspace cannot be reached", async () => {
    const { tx, records } = transaction({ changed: undefined });

    await expect(archiveBookmarks(tx, { workspaceId: WORKSPACE, bookmarkIds: [FIRST] })).rejects.toThrow(BookmarkArchiveError);

    expect(records).toEqual([]);
  });

  it("rejects when the store fails, writing no event", async () => {
    const { tx, records } = transaction();
    const failing: BookmarkArchiveTransaction = { ...tx, setArchived: () => Promise.reject(new Error("down")) };

    await expect(archiveBookmarks(failing, { workspaceId: WORKSPACE, bookmarkIds: [FIRST] })).rejects.toThrow("down");

    expect(records).toEqual([]);
  });
});

describe("the entitlement version", () => {
  it("is raised once by each service call, after the rows change, also when nothing changed", async () => {
    const archived = transaction({ changed: 2 });
    const repeated = transaction({ changed: 0 });
    const restored = transaction();

    await archiveBookmarks(archived.tx, { workspaceId: WORKSPACE, bookmarkIds: [FIRST] });
    await archiveBookmarks(repeated.tx, { workspaceId: WORKSPACE, bookmarkIds: [FIRST] });
    await restoreBookmarks(restored.tx, { workspaceId: WORKSPACE, bookmarkIds: [FIRST] });

    expect(archived.steps).toEqual(["setArchived", "bump"]);
    expect(repeated.steps).toEqual(["setArchived", "bump"]);
    expect(restored.steps).toEqual(["setArchived", "bump"]);
  });

  it("is not raised when the rows are not changed", async () => {
    const unreachable = transaction({ changed: undefined });
    const other = transaction();

    await expect(archiveBookmarks(unreachable.tx, { workspaceId: WORKSPACE, bookmarkIds: [FIRST] })).rejects.toThrow(BookmarkArchiveError);
    await expect(restoreBookmarks(other.tx, { workspaceId: OTHER, bookmarkIds: [FIRST] })).rejects.toThrow(BookmarkArchiveError);

    expect([unreachable.steps, other.steps]).toEqual([["setArchived"], []]);
  });

  it("rejects, writing no event, when it cannot be raised", async () => {
    const { tx, records } = transaction({ bumped: undefined });

    await expect(archiveBookmarks(tx, { workspaceId: WORKSPACE, bookmarkIds: [FIRST] })).rejects.toThrow(EntitlementVersionError);

    expect(records).toEqual([]);
  });
});

describe("restoreBookmarks", () => {
  it("restores the bookmarks and writes one bookmark.restored event with the count", async () => {
    const { tx, requests, records } = transaction();

    const result = await restoreBookmarks(tx, { workspaceId: WORKSPACE, bookmarkIds: [FIRST, SECOND] });

    expect(result).toEqual({ restored: 2 });
    expect(requests).toEqual([{ bookmarkIds: [FIRST.toLowerCase(), SECOND], archived: false }]);
    expect(records.map((record) => [record.action, record.metadata])).toEqual([["bookmark.restored", { count: "2" }]]);
  });

  it("refuses a workspace other than the one the transaction acts in", async () => {
    const { tx, requests } = transaction();

    await expect(restoreBookmarks(tx, { workspaceId: OTHER, bookmarkIds: [FIRST] })).rejects.toThrow(BookmarkArchiveError);

    expect(requests).toEqual([]);
  });
});
