import { describe, expect, it } from "vitest";

import type { BookmarkRecord } from "../../bookmarks/bookmark.types.js";
import {
  compareArchivePriority,
  computeOverflowArchiveAt,
  selectBookmarkIdsToArchive,
  selectBookmarkIdsToRestore,
  shouldArchiveOverflow,
} from "./archive-selection.js";

function bookmark(
  id: string,
  lastAccessedAt: Date | null,
  createdAt: Date,
): BookmarkRecord {
  return {
    id,
    workspaceId: "ws-1",
    userId: "user-1",
    title: id,
    url: `https://example.com/${id}`,
    slug: null,
    forwardingEnabled: false,
    pinned: false,
    planArchived: false,
    accessCount: 0,
    lastAccessedAt,
    createdAt,
    updatedAt: createdAt,
    folders: [],
    tags: [],
  };
}

describe("archive-selection", () => {
  it("selects lower-priority bookmarks for archive (def §5 rule)", () => {
    const keep = bookmark("keep", new Date("2026-01-10"), new Date("2026-01-01"));
    const tieOlder = bookmark("tie-old", new Date("2026-01-05"), new Date("2026-01-01"));
    const tieNewer = bookmark("tie-new", new Date("2026-01-05"), new Date("2026-01-02"));
    const neverUsed = bookmark("never", null, new Date("2026-01-03"));

    const toArchive = selectBookmarkIdsToArchive(
      [neverUsed, tieOlder, tieNewer, keep],
      2,
    );

    expect(toArchive.sort()).toEqual(["never", "tie-old"].sort());
    expect(compareArchivePriority(keep, tieNewer)).toBeLessThan(0);
  });

  it("restores archived bookmarks up to the new cap on re-upgrade", () => {
    const recent = bookmark("recent", new Date("2026-02-01"), new Date("2026-01-01"));
    const older = bookmark("older", null, new Date("2026-01-01"));

    const restored = selectBookmarkIdsToRestore([older, recent], 49, 50);
    expect(restored).toEqual(["recent"]);
  });

  it("restores all archived bookmarks when cap is unlimited", () => {
    const a = bookmark("a", null, new Date("2026-01-01"));
    const b = bookmark("b", null, new Date("2026-01-02"));
    expect(selectBookmarkIdsToRestore([a, b], 100, null)).toEqual(["a", "b"]);
  });

  it("computes overflow archive time as period end plus grace days", () => {
    const periodEnd = new Date("2026-06-01T00:00:00.000Z");
    const archiveAt = computeOverflowArchiveAt(periodEnd, 7);
    expect(archiveAt?.toISOString()).toBe("2026-06-08T00:00:00.000Z");
  });

  it("requires grace period to elapse before archiving overflow", () => {
    const periodEnd = new Date("2026-06-01T00:00:00.000Z");
    expect(
      shouldArchiveOverflow("free", periodEnd, 7, new Date("2026-06-07T23:59:59.000Z")),
    ).toBe(false);
    expect(
      shouldArchiveOverflow("free", periodEnd, 7, new Date("2026-06-08T00:00:00.000Z")),
    ).toBe(true);
    expect(shouldArchiveOverflow("personal", periodEnd, 7, new Date("2026-06-09T00:00:00.000Z"))).toBe(
      false,
    );
  });
});
