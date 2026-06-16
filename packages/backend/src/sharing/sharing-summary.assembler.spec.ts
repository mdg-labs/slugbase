import { describe, expect, it } from "vitest";

import {
  assembleBookmarkSharingSummary,
  assembleFolderSharingSummary,
  computeShareGrantCount,
  groupDirectFolderShares,
  groupDirectShares,
  groupViaFolderShares,
  pickAccessPaths,
  pickFolderAccessPaths,
  type AccessPathCandidate,
  type DirectShareRow,
  type FolderDirectShareRow,
  type ViaFolderShareRow,
} from "./sharing-summary.assembler.js";

describe("sharing-summary assembler", () => {
  it("computes share grant count including folder-transitive grants", () => {
    const summary = assembleBookmarkSharingSummary(
      "bm-1",
      "owner-1",
      "owner-1",
      groupDirectShares([
        {
          bookmarkId: "bm-1",
          recipient: { kind: "user", targetId: "u1", targetName: "User One" },
        },
      ]),
      groupViaFolderShares([
        {
          bookmarkId: "bm-1",
          folderId: "f1",
          folderName: "Alpha",
          recipient: { kind: "team", targetId: "t1", targetName: "Team One" },
        },
        {
          bookmarkId: "bm-1",
          folderId: "f1",
          folderName: "Alpha",
          recipient: { kind: "user", targetId: "u2", targetName: "User Two" },
        },
      ]),
      new Map(),
    );

    expect(computeShareGrantCount(summary)).toBe(3);
    expect(summary.scope).toBe("shared-by-me");
  });

  it("returns mine scope for owned bookmarks without shares", () => {
    const summary = assembleBookmarkSharingSummary(
      "bm-1",
      "owner-1",
      "owner-1",
      new Map(),
      new Map(),
      new Map(),
    );

    expect(summary.scope).toBe("mine");
    expect(summary.directRecipients).toEqual([]);
    expect(summary.viaFolders).toEqual([]);
    expect(summary.accessPath).toBeUndefined();
  });

  it("returns accessPath only for recipients", () => {
    const accessPaths = pickAccessPaths([
      {
        bookmarkId: "bm-1",
        priority: 3,
        accessPath: { kind: "folder", ownerName: "Owner", folderName: "Shared Folder" },
      },
      {
        bookmarkId: "bm-1",
        priority: 1,
        accessPath: { kind: "direct", ownerName: "Owner" },
      },
    ]);

    const summary = assembleBookmarkSharingSummary(
      "bm-1",
      "owner-1",
      "recipient-1",
      new Map(),
      new Map(),
      accessPaths,
    );

    expect(summary.scope).toBe("shared-with-me");
    expect(summary.directRecipients).toEqual([]);
    expect(summary.viaFolders).toEqual([]);
    expect(summary.accessPath).toEqual({ kind: "direct", ownerName: "Owner" });
  });

  it("groups folder shares by folder and sorts folder names", () => {
    const rows: ViaFolderShareRow[] = [
      {
        bookmarkId: "bm-1",
        folderId: "f2",
        folderName: "Beta",
        recipient: { kind: "user", targetId: "u2", targetName: "User Two" },
      },
      {
        bookmarkId: "bm-1",
        folderId: "f1",
        folderName: "Alpha",
        recipient: { kind: "user", targetId: "u1", targetName: "User One" },
      },
    ];

    const grouped = groupViaFolderShares(rows);
    expect(grouped.get("bm-1")).toEqual([
      {
        folderId: "f1",
        folderName: "Alpha",
        recipients: [{ kind: "user", targetId: "u1", targetName: "User One" }],
      },
      {
        folderId: "f2",
        folderName: "Beta",
        recipients: [{ kind: "user", targetId: "u2", targetName: "User Two" }],
      },
    ]);
  });

  it("prefers lexicographically earlier folder when folder paths tie", () => {
    const candidates: AccessPathCandidate[] = [
      {
        bookmarkId: "bm-1",
        priority: 3,
        accessPath: { kind: "folder", ownerName: "Owner", folderName: "Zulu" },
      },
      {
        bookmarkId: "bm-1",
        priority: 3,
        accessPath: { kind: "folder", ownerName: "Owner", folderName: "Alpha" },
      },
    ];

    const picked = pickAccessPaths(candidates);
    expect(picked.get("bm-1")).toEqual({
      kind: "folder",
      ownerName: "Owner",
      folderName: "Alpha",
    });
  });

  it("groups direct shares per bookmark", () => {
    const rows: DirectShareRow[] = [
      {
        bookmarkId: "bm-1",
        recipient: { kind: "team", targetId: "t1", targetName: "Team" },
      },
      {
        bookmarkId: "bm-2",
        recipient: { kind: "user", targetId: "u1", targetName: "User" },
      },
    ];

    const grouped = groupDirectShares(rows);
    expect(grouped.get("bm-1")).toHaveLength(1);
    expect(grouped.get("bm-2")).toHaveLength(1);
  });

  it("assembles folder sharing summary for owned folders with direct recipients", () => {
    const directByFolder = groupDirectFolderShares([
      {
        folderId: "f1",
        recipient: { kind: "user", targetId: "u1", targetName: "User One" },
      },
    ]);

    const summary = assembleFolderSharingSummary(
      "f1",
      "owner-1",
      "owner-1",
      directByFolder,
      new Map(),
    );

    expect(summary.scope).toBe("shared-by-me");
    expect(summary.directRecipients).toEqual([
      { kind: "user", targetId: "u1", targetName: "User One" },
    ]);
    expect(summary.accessPath).toBeUndefined();
  });

  it("returns mine scope for owned folders without shares", () => {
    const summary = assembleFolderSharingSummary(
      "f1",
      "owner-1",
      "owner-1",
      new Map(),
      new Map(),
    );

    expect(summary.scope).toBe("mine");
    expect(summary.directRecipients).toEqual([]);
  });

  it("returns accessPath for shared-with-me folders", () => {
    const accessPaths = pickFolderAccessPaths([
      {
        folderId: "f1",
        priority: 2,
        accessPath: { kind: "team", ownerName: "Owner", teamName: "Team One" },
      },
      {
        folderId: "f1",
        priority: 1,
        accessPath: { kind: "direct", ownerName: "Owner" },
      },
    ]);

    const summary = assembleFolderSharingSummary(
      "f1",
      "owner-1",
      "recipient-1",
      new Map(),
      accessPaths,
    );

    expect(summary.scope).toBe("shared-with-me");
    expect(summary.directRecipients).toEqual([]);
    expect(summary.accessPath).toEqual({ kind: "direct", ownerName: "Owner" });
  });

  it("groups direct folder shares per folder", () => {
    const rows: FolderDirectShareRow[] = [
      {
        folderId: "f1",
        recipient: { kind: "team", targetId: "t1", targetName: "Team" },
      },
      {
        folderId: "f2",
        recipient: { kind: "user", targetId: "u1", targetName: "User" },
      },
    ];

    const grouped = groupDirectFolderShares(rows);
    expect(grouped.get("f1")).toHaveLength(1);
    expect(grouped.get("f2")).toHaveLength(1);
  });
});
