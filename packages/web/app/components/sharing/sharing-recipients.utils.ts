/** Mirrors `@slugbase/shared-types` sharing summary contracts (#460/#461). */
export type ShareRecipient = {
  kind: "user" | "team";
  targetId: string;
  targetName: string;
};

export type BookmarkViaFolderShare = {
  folderId: string;
  folderName: string;
  recipients: ShareRecipient[];
};

export type BookmarkSharingAccessPath = {
  kind: "direct" | "team" | "folder";
  ownerName: string;
  teamName?: string;
  folderName?: string;
};

export type FolderSharingAccessPath = {
  kind: "direct" | "team";
  ownerName: string;
  teamName?: string;
};

export type BookmarkSharingSummary = {
  scope: "mine" | "shared-by-me" | "shared-with-me";
  directRecipients: ShareRecipient[];
  viaFolders: BookmarkViaFolderShare[];
  accessPath?: BookmarkSharingAccessPath;
};

export type FolderSharingSummary = {
  scope: "mine" | "shared-by-me" | "shared-with-me";
  directRecipients: ShareRecipient[];
  accessPath?: FolderSharingAccessPath;
};

export type SharingSummary = BookmarkSharingSummary | FolderSharingSummary;

export const TOOLTIP_MAX_RECIPIENT_NAMES = 5;

export function isBookmarkSharingSummary(
  summary: SharingSummary,
): summary is BookmarkSharingSummary {
  return "viaFolders" in summary;
}

export function shouldShowRecipientsBadge(summary: SharingSummary): boolean {
  if (summary.scope !== "mine") {
    return true;
  }
  if (summary.directRecipients.length > 0) {
    return true;
  }
  return isBookmarkSharingSummary(summary) && summary.viaFolders.length > 0;
}

export function computeEffectiveShareCount(summary: SharingSummary): number {
  if (summary.scope !== "shared-by-me") {
    return 0;
  }

  let count = summary.directRecipients.length;
  if (isBookmarkSharingSummary(summary)) {
    count += summary.viaFolders.reduce(
      (sum, folder) => sum + folder.recipients.length,
      0,
    );
  }
  return count;
}

export function collectRecipientNames(summary: SharingSummary): string[] {
  const names: string[] = [];
  for (const recipient of summary.directRecipients) {
    names.push(recipient.targetName);
  }
  if (isBookmarkSharingSummary(summary)) {
    for (const folder of summary.viaFolders) {
      for (const recipient of folder.recipients) {
        names.push(recipient.targetName);
      }
    }
  }
  return names;
}

export function truncateRecipientNamesForTooltip(names: string[]): {
  visible: string[];
  overflowCount: number;
} {
  if (names.length <= TOOLTIP_MAX_RECIPIENT_NAMES) {
    return { visible: names, overflowCount: 0 };
  }
  return {
    visible: names.slice(0, TOOLTIP_MAX_RECIPIENT_NAMES),
    overflowCount: names.length - TOOLTIP_MAX_RECIPIENT_NAMES,
  };
}

export function getAccessPathMessageKey(
  accessPath: BookmarkSharingAccessPath | FolderSharingAccessPath,
): string {
  switch (accessPath.kind) {
    case "direct":
      return "sharing.recipients.access_path_direct";
    case "team":
      return "sharing.recipients.access_path_team";
    case "folder":
      return "sharing.recipients.access_path_folder";
  }
}

export function getAccessPathMessageParams(
  accessPath: BookmarkSharingAccessPath | FolderSharingAccessPath,
): Record<string, string> {
  const params: Record<string, string> = { ownerName: accessPath.ownerName };
  if (accessPath.kind === "team" && accessPath.teamName) {
    params.teamName = accessPath.teamName;
  }
  if (accessPath.kind === "folder" && accessPath.folderName) {
    params.folderName = accessPath.folderName;
  }
  return params;
}
