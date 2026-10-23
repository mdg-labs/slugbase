export { BOOKMARK_URL_MAX_LENGTH, normalizeBookmarkUrl } from "./url.ts";
export type { BookmarkUrl, BookmarkUrlRefusal, BookmarkUrlResult } from "./url.ts";
export { BOOKMARK_DESCRIPTION_MAX_LENGTH, BOOKMARK_TITLE_MAX_LENGTH, createBookmark } from "./create.ts";
export type {
  BookmarkCreationAsk,
  BookmarkCreationDependencies,
  BookmarkCreationOutcome,
  BookmarkCreationRequest,
  BookmarkRecord,
  BookmarkStore,
  BookmarkStoreResult,
  NewBookmark,
} from "./create.ts";
export { readBookmark } from "./read.ts";
export type { BookmarkReadAsk, BookmarkReadDependencies } from "./read.ts";
