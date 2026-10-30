import type { TFunction } from "i18next";
import { summaryOfParts } from "../sharing/index.ts";
import type { Folder } from "./folders.ts";

/** How a folder is shared with respect to the member (doc 03 section 6): their own is private or shared with others, another member's is shared with them. */
export type FolderSharing = "private" | "shared" | "received";

/**
 * The sharing of the folder for a member who owns it or does not (`owned`). The server sends the share summary for the member's own folders and the owner
 * for the others; an own folder without a summary is read as private.
 */
export function sharingOf(folder: Folder, owned: boolean): FolderSharing {
  if (!owned) {
    return "received";
  }
  const summary = folder.shareSummary;
  return summary === null || summary === undefined || (summary.memberCount === 0 && summary.teams.length === 0) ? "private" : "shared";
}

/** "Private", "Shared with Platform team and 2 members", "Shared with you by Ada" or, where the owner has left the workspace, "Shared with you". */
export function sharingLabelOf(t: TFunction, language: string, folder: Folder, owned: boolean): string {
  if (!owned) {
    return folder.owner === null || folder.owner === undefined ? t("folders.sharing.received") : t("folders.sharing.receivedBy", { owner: folder.owner.displayName });
  }
  const summary = folder.shareSummary;
  return summaryOfParts(t, language, { teams: (summary?.teams ?? []).map(({ name }) => name), members: summary?.memberCount ?? 0 });
}
