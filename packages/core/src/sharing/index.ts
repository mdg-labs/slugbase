export { findShareTargets } from "./targets.ts";
export type { ShareTargetDependencies } from "./targets.ts";
export { grantBookmarkShare, listBookmarkShares, revokeBookmarkShare } from "./bookmark-shares.ts";
export type {
  BookmarkShareAsk,
  BookmarkShareDependencies,
  BookmarkShareGrantAsk,
  BookmarkShareGrantOutcome,
  BookmarkShareListOutcome,
  BookmarkShareReadAsk,
  BookmarkShareReadDependencies,
  BookmarkShareRevocationAsk,
  BookmarkShareRevocationOutcome,
} from "./bookmark-shares.ts";
export { grantFolderShare, listFolderShares, revokeFolderShare } from "./folder-shares.ts";
export type {
  FolderShareAsk,
  FolderShareDependencies,
  FolderShareGrantAsk,
  FolderShareGrantOutcome,
  FolderShareListOutcome,
  FolderShareReadAsk,
  FolderShareReadDependencies,
  FolderShareRevocationAsk,
  FolderShareRevocationOutcome,
} from "./folder-shares.ts";
export { SHARE_ENTITLEMENTS } from "./store.ts";
export type {
  BookmarkShareGrant,
  BookmarkShareList,
  BookmarkShareRecord,
  BookmarkShareStore,
  BookmarkShareUse,
  FolderShareGrant,
  FolderShareList,
  FolderShareRecord,
  FolderShareStore,
  FolderShareUse,
  NewBookmarkShare,
  NewFolderShare,
  ShareTarget,
  ShareTargetKind,
  ShareTargetRecord,
  ShareTargetSearch,
  ShareTargetStore,
} from "./store.ts";
