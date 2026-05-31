/** Free workspace bookmark cap — spec §12.1, defaults-and-constants §2. */
export const FREE_BOOKMARK_CAP = 50;

/** Show approaching-cap banner when usage reaches this fraction of the Free cap. */
export const APPROACHING_CAP_RATIO = 0.9;

export const CHECKLIST_STORAGE_KEY = "slugbase_dashboard_checklist";
export const CHECKLIST_DISMISSED_KEY = "slugbase_dashboard_checklist_dismissed";

export const CHECKLIST_ITEM_IDS = [
  "import",
  "browser_shortcut",
  "folder",
  "tag",
] as const;

export type ChecklistItemId = (typeof CHECKLIST_ITEM_IDS)[number];
