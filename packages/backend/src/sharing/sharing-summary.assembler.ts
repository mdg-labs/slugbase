import type {
  BookmarkSharingAccessPath,
  BookmarkSharingSummary,
  BookmarkViaFolderShare,
  FolderSharingAccessPath,
  FolderSharingSummary,
  ShareRecipient,
} from "./sharing.types.js";

export interface DirectShareRow {
  bookmarkId: string;
  recipient: ShareRecipient;
}

export interface FolderDirectShareRow {
  folderId: string;
  recipient: ShareRecipient;
}

export interface ViaFolderShareRow {
  bookmarkId: string;
  folderId: string;
  folderName: string;
  recipient: ShareRecipient;
}

export interface AccessPathCandidate {
  bookmarkId: string;
  accessPath: BookmarkSharingAccessPath;
  priority: number;
}

export interface FolderAccessPathCandidate {
  folderId: string;
  accessPath: FolderSharingAccessPath;
  priority: number;
}

export function computeShareGrantCount(summary: BookmarkSharingSummary): number {
  if (summary.scope !== "shared-by-me") {
    return 0;
  }
  const folderGrantCount = summary.viaFolders.reduce(
    (sum, folder) => sum + folder.recipients.length,
    0,
  );
  return summary.directRecipients.length + folderGrantCount;
}

export function groupDirectShares(rows: DirectShareRow[]): Map<string, ShareRecipient[]> {
  const map = new Map<string, ShareRecipient[]>();
  for (const row of rows) {
    const existing = map.get(row.bookmarkId) ?? [];
    existing.push(row.recipient);
    map.set(row.bookmarkId, existing);
  }
  return map;
}

export function groupDirectFolderShares(
  rows: FolderDirectShareRow[],
): Map<string, ShareRecipient[]> {
  const map = new Map<string, ShareRecipient[]>();
  for (const row of rows) {
    const existing = map.get(row.folderId) ?? [];
    existing.push(row.recipient);
    map.set(row.folderId, existing);
  }
  return map;
}

export function groupViaFolderShares(
  rows: ViaFolderShareRow[],
): Map<string, BookmarkViaFolderShare[]> {
  const byBookmark = new Map<string, Map<string, BookmarkViaFolderShare>>();

  for (const row of rows) {
    let folders = byBookmark.get(row.bookmarkId);
    if (!folders) {
      folders = new Map();
      byBookmark.set(row.bookmarkId, folders);
    }

    let folderEntry = folders.get(row.folderId);
    if (!folderEntry) {
      folderEntry = {
        folderId: row.folderId,
        folderName: row.folderName,
        recipients: [],
      };
      folders.set(row.folderId, folderEntry);
    }
    folderEntry.recipients.push(row.recipient);
  }

  const result = new Map<string, BookmarkViaFolderShare[]>();
  for (const [bookmarkId, folders] of byBookmark) {
    result.set(
      bookmarkId,
      [...folders.values()].sort((a, b) => a.folderName.localeCompare(b.folderName)),
    );
  }
  return result;
}

export function pickAccessPaths(
  candidates: AccessPathCandidate[],
): Map<string, BookmarkSharingAccessPath> {
  const best = new Map<string, AccessPathCandidate>();

  for (const candidate of candidates) {
    const existing = best.get(candidate.bookmarkId);
    if (!existing || candidate.priority < existing.priority) {
      best.set(candidate.bookmarkId, candidate);
    } else if (
      candidate.priority === existing.priority &&
      candidate.accessPath.kind === "folder" &&
      existing.accessPath.kind === "folder"
    ) {
      const nextName = candidate.accessPath.folderName ?? "";
      const currentName = existing.accessPath.folderName ?? "";
      if (nextName.localeCompare(currentName) < 0) {
        best.set(candidate.bookmarkId, candidate);
      }
    }
  }

  return new Map(
    [...best.entries()].map(([bookmarkId, entry]) => [bookmarkId, entry.accessPath]),
  );
}

export function pickFolderAccessPaths(
  candidates: FolderAccessPathCandidate[],
): Map<string, FolderSharingAccessPath> {
  const best = new Map<string, FolderAccessPathCandidate>();

  for (const candidate of candidates) {
    const existing = best.get(candidate.folderId);
    if (!existing || candidate.priority < existing.priority) {
      best.set(candidate.folderId, candidate);
    }
  }

  return new Map(
    [...best.entries()].map(([folderId, entry]) => [folderId, entry.accessPath]),
  );
}

export function assembleBookmarkSharingSummary(
  bookmarkId: string,
  ownerUserId: string,
  viewerUserId: string,
  directByBookmark: Map<string, ShareRecipient[]>,
  viaFoldersByBookmark: Map<string, BookmarkViaFolderShare[]>,
  accessPathsByBookmark: Map<string, BookmarkSharingAccessPath>,
): BookmarkSharingSummary {
  const isOwner = ownerUserId === viewerUserId;

  if (isOwner) {
    const directRecipients = directByBookmark.get(bookmarkId) ?? [];
    const viaFolders = viaFoldersByBookmark.get(bookmarkId) ?? [];
    const hasShares = directRecipients.length > 0 || viaFolders.length > 0;

    return {
      scope: hasShares ? "shared-by-me" : "mine",
      directRecipients,
      viaFolders,
    };
  }

  return {
    scope: "shared-with-me",
    directRecipients: [],
    viaFolders: [],
    accessPath: accessPathsByBookmark.get(bookmarkId),
  };
}

export function assembleFolderSharingSummary(
  folderId: string,
  ownerUserId: string,
  viewerUserId: string,
  directByFolder: Map<string, ShareRecipient[]>,
  accessPathsByFolder: Map<string, FolderSharingAccessPath>,
): FolderSharingSummary {
  const isOwner = ownerUserId === viewerUserId;

  if (isOwner) {
    const directRecipients = directByFolder.get(folderId) ?? [];
    return {
      scope: directRecipients.length > 0 ? "shared-by-me" : "mine",
      directRecipients,
    };
  }

  return {
    scope: "shared-with-me",
    directRecipients: [],
    accessPath: accessPathsByFolder.get(folderId),
  };
}
