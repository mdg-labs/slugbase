import type { BookmarkRecord } from "../../bookmarks/bookmark.types.js";

/** Default grace days after billing period end before overflow archive (def §5). */
export const DEFAULT_DOWNGRADE_GRACE_PERIOD_DAYS = 7;

/**
 * Sort key for archive/restore selection (def §5):
 * keep most-recently-accessed; tiebreak most-recently-created.
 */
export function compareArchivePriority(a: BookmarkRecord, b: BookmarkRecord): number {
  const aAccess = a.lastAccessedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bAccess = b.lastAccessedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aAccess !== bAccess) {
    return bAccess - aAccess;
  }
  return b.createdAt.getTime() - a.createdAt.getTime();
}

/**
 * Returns bookmark ids to archive when active count exceeds cap.
 * Keeps the highest-priority `cap` bookmarks active; archives the remainder.
 */
export function selectBookmarkIdsToArchive(
  activeBookmarks: BookmarkRecord[],
  cap: number,
): string[] {
  if (activeBookmarks.length <= cap) {
    return [];
  }
  const sorted = [...activeBookmarks].sort(compareArchivePriority);
  return sorted.slice(cap).map((b) => b.id);
}

/**
 * Returns bookmark ids to restore when upgrading to a higher cap.
 * Restores highest-priority archived bookmarks until the cap is reached.
 * When `cap` is null (unlimited), restores all archived bookmarks.
 */
export function selectBookmarkIdsToRestore(
  archivedBookmarks: BookmarkRecord[],
  activeCount: number,
  cap: number | null,
): string[] {
  if (archivedBookmarks.length === 0) {
    return [];
  }
  if (cap === null) {
    return archivedBookmarks.map((b) => b.id);
  }
  const slots = cap - activeCount;
  if (slots <= 0) {
    return [];
  }
  const sorted = [...archivedBookmarks].sort(compareArchivePriority);
  return sorted.slice(0, slots).map((b) => b.id);
}

export function computeOverflowArchiveAt(
  billingPeriodEnd: Date | null,
  gracePeriodDays: number,
): Date | null {
  if (!billingPeriodEnd) {
    return null;
  }
  const ms = billingPeriodEnd.getTime() + gracePeriodDays * 86_400_000;
  return new Date(ms);
}

export function shouldArchiveOverflow(
  plan: "free" | "personal" | "team",
  billingPeriodEnd: Date | null,
  gracePeriodDays: number,
  now: Date = new Date(),
): boolean {
  if (plan !== "free") {
    return false;
  }
  const archiveAt = computeOverflowArchiveAt(billingPeriodEnd, gracePeriodDays);
  if (!archiveAt) {
    return true;
  }
  return now.getTime() >= archiveAt.getTime();
}
