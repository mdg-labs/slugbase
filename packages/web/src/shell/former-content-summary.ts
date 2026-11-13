import type { TFunction } from "i18next";

/** "2 bookmarks and 1 folder", the units a deletion or a reassignment of former members' content counts in; a count of zero is left out. */
export function formerContentSummary(t: TFunction, bookmarkCount: number, folderCount: number): string {
  const bookmarkText = t("settings.members.former.delete.count.bookmarks", { count: bookmarkCount });
  const folderText = t("settings.members.former.delete.count.folders", { count: folderCount });
  if (bookmarkCount > 0 && folderCount > 0) {
    return t("settings.members.former.delete.count.both", { bookmarks: bookmarkText, folders: folderText });
  }
  return bookmarkCount > 0 ? bookmarkText : folderText;
}
