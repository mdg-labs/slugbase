import type { ListBookmarksQuery } from "../bookmark.types.js";

/** Bulk selection — explicit IDs or select-all with list filters (spec §6.6). */
export interface BulkSelectionBody extends ListBookmarksQuery {
  bookmarkIds?: string[];
  selectAll?: boolean;
}

export interface BulkResult {
  processed: number;
  skipped: number;
  skippedIds: string[];
}

export interface BulkPinBody extends BulkSelectionBody {
  pinned: boolean;
}

export interface BulkMoveToFolderBody extends BulkSelectionBody {
  folderId: string;
}

export interface BulkTagsBody extends BulkSelectionBody {
  tagIds: string[];
}

export interface BulkAddTagsPreviewResult {
  total: number;
  tags: Array<{
    tagId: string;
    alreadyTagged: number;
    newlyTagged: number;
  }>;
}
