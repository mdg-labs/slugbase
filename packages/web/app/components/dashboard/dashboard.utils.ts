import { isPlanGatingEnabled } from "../../lib/billing-config.js";
import {
  APPROACHING_CAP_RATIO,
  FREE_BOOKMARK_CAP,
  type ChecklistItemId,
} from "./dashboard.constants.js";
import type {
  DashboardData,
  DashboardTag,
  EntitlementBannerState,
  WorkspacePlan,
} from "./dashboard.types.js";

export function hasUnlimitedBookmarks(plan: WorkspacePlan): boolean {
  if (!isPlanGatingEnabled()) {
    return true;
  }
  return plan !== "free";
}

export function resolveEntitlementBanner(
  plan: WorkspacePlan,
  bookmarkCount: number,
): EntitlementBannerState | null {
  if (hasUnlimitedBookmarks(plan)) {
    return null;
  }

  const cap = FREE_BOOKMARK_CAP;
  const used = bookmarkCount;
  const remaining = Math.max(0, cap - used);
  const approachingThreshold = Math.floor(cap * APPROACHING_CAP_RATIO);

  if (used >= cap) {
    return { variant: "at-cap", used, cap, remaining: 0 };
  }

  if (used >= approachingThreshold) {
    return { variant: "approaching", used, cap, remaining };
  }

  return null;
}

export function sortTagsByUsage(tags: DashboardTag[]): DashboardTag[] {
  return [...tags].sort((left, right) => {
    if (right.bookmarkCount !== left.bookmarkCount) {
      return right.bookmarkCount - left.bookmarkCount;
    }
    return left.name.localeCompare(right.name);
  });
}

export function sortFoldersByUsage(
  folders: DashboardData["folders"],
): DashboardData["folders"] {
  return [...folders].sort((left, right) => {
    if (right.bookmarkCount !== left.bookmarkCount) {
      return right.bookmarkCount - left.bookmarkCount;
    }
    return left.name.localeCompare(right.name);
  });
}

export function formatRelativeTime(
  isoDate: string | null,
  now: Date = new Date(),
): string | null {
  if (!isoDate) {
    return null;
  }

  const then = new Date(isoDate);
  const diffMs = now.getTime() - then.getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) {
    return null;
  }

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${String(minutes)}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h`;
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${String(days)}d`;
  }

  const months = Math.floor(days / 30);
  return `${String(months)}mo`;
}

export function deriveChecklistCompletion(data: DashboardData): Partial<
  Record<ChecklistItemId, boolean>
> {
  return {
    folder: data.counts.folders > 0,
    tag: data.counts.tags > 0,
  };
}
