export type BookmarkModalMode = "create" | "edit";

export type BookmarkModalFolderOption = {
  id: string;
  name: string;
  icon: string | null;
};

export type BookmarkModalTagOption = {
  id: string;
  name: string;
};

/** Bookmark fields loaded when opening edit mode. */
export type BookmarkModalInitialBookmark = {
  id: string;
  title: string;
  url: string;
  slug: string | null;
  forwardingEnabled: boolean;
  pinned: boolean;
  folderIds: string[];
  tagIds: string[];
};

export type BookmarkModalFormValues = {
  url: string;
  title: string;
  slug: string;
  folderIds: string[];
  tagIds: string[];
  pinned: boolean;
  forwardingEnabled: boolean;
};

export type BookmarkModalFieldErrors = Partial<
  Record<"url" | "title" | "slug" | "form", string>
>;

export type BookmarkModalSubmitPayload = BookmarkModalFormValues & {
  mode: BookmarkModalMode;
  bookmarkId?: string;
};

export const EMPTY_BOOKMARK_FORM: BookmarkModalFormValues = {
  url: "",
  title: "",
  slug: "",
  folderIds: [],
  tagIds: [],
  pinned: false,
  forwardingEnabled: false,
};
