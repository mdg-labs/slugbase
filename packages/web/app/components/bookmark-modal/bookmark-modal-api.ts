import { resolveClientApiPath } from "../../lib/client-api-path.js";
import {
  apiFetch,
  fetchCsrfHeaders,
  parseApiErrorMessage,
  type JsonHeaders,
} from "../../lib/client-api-fetch.js";
import type {
  BookmarkModalFolderOption,
  BookmarkModalInitialBookmark,
  BookmarkModalSubmitPayload,
  BookmarkModalTagOption,
} from "./bookmark-modal.types.js";
import { toBookmarkSubmitBody } from "./bookmark-modal.validation.js";

export class BookmarkModalLoadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BookmarkModalLoadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFolderOptionArray(items: unknown): items is BookmarkModalFolderOption[] {
  if (!Array.isArray(items)) return false;
  return items.every(
    (item) =>
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      (item.icon === null || typeof item.icon === "string"),
  );
}

function isTagOptionArray(items: unknown): items is BookmarkModalTagOption[] {
  if (!Array.isArray(items)) return false;
  return items.every(
    (item) =>
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.name === "string",
  );
}

async function createBookmark(
  body: ReturnType<typeof toBookmarkSubmitBody>,
  csrfHeaders: JsonHeaders,
): Promise<{ id: string }> {
  const res = await apiFetch(resolveClientApiPath("/bookmarks"), {
    method: "POST",
    csrfHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as { id: string };
}

async function updateBookmark(
  bookmarkId: string,
  body: ReturnType<typeof toBookmarkSubmitBody>,
  csrfHeaders: JsonHeaders,
): Promise<void> {
  const res = await apiFetch(resolveClientApiPath(`/bookmarks/${bookmarkId}`), {
    method: "PATCH",
    csrfHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

async function addBookmarkToFolder(
  folderId: string,
  bookmarkId: string,
  csrfHeaders: JsonHeaders,
): Promise<void> {
  const res = await apiFetch(`/folders/${folderId}/bookmarks`, {
    method: "POST",
    csrfHeaders,
    body: JSON.stringify({ bookmarkId }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

async function addBookmarkToTag(
  tagId: string,
  bookmarkId: string,
  csrfHeaders: JsonHeaders,
): Promise<void> {
  const res = await apiFetch(`/tags/${tagId}/bookmarks`, {
    method: "POST",
    csrfHeaders,
    body: JSON.stringify({ bookmarkId }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

async function createTag(
  name: string,
  csrfHeaders: JsonHeaders,
): Promise<{ id: string }> {
  const res = await apiFetch(resolveClientApiPath("/tags"), {
    method: "POST",
    csrfHeaders,
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as { id: string };
}

async function createFolder(
  name: string,
  csrfHeaders: JsonHeaders,
): Promise<{ id: string }> {
  const res = await apiFetch(resolveClientApiPath("/folders"), {
    method: "POST",
    csrfHeaders,
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as { id: string };
}

async function syncFolderMembership(
  bookmarkId: string,
  selectedFolderIds: string[],
  initialFolderIds: string[],
  csrfHeaders: JsonHeaders,
): Promise<void> {
  const toAdd = selectedFolderIds.filter((id) => !initialFolderIds.includes(id));
  await Promise.all(
    toAdd.map((folderId) => addBookmarkToFolder(folderId, bookmarkId, csrfHeaders)),
  );
}

async function syncTagMembership(
  bookmarkId: string,
  selectedTagIds: string[],
  initialTagIds: string[],
  csrfHeaders: JsonHeaders,
): Promise<void> {
  const toAdd = selectedTagIds.filter((id) => !initialTagIds.includes(id));
  await Promise.all(
    toAdd.map((tagId) => addBookmarkToTag(tagId, bookmarkId, csrfHeaders)),
  );
}

export async function submitBookmarkModal(
  payload: BookmarkModalSubmitPayload,
  initial?: BookmarkModalInitialBookmark,
): Promise<void> {
  const csrfHeaders = await fetchCsrfHeaders();
  const body = toBookmarkSubmitBody(payload);

  const newFolderIds = await Promise.all(
    payload.newFolderNames.map((name) =>
      createFolder(name, csrfHeaders).then((f) => f.id),
    ),
  );
  const allFolderIds = [...payload.folderIds, ...newFolderIds];

  const newTagIds = await Promise.all(
    payload.newTagNames.map((name) => createTag(name, csrfHeaders).then((t) => t.id)),
  );
  const allTagIds = [...payload.tagIds, ...newTagIds];

  if (payload.mode === "create") {
    const created = await createBookmark(body, csrfHeaders);
    await Promise.all([
      ...allFolderIds.map((folderId) =>
        addBookmarkToFolder(folderId, created.id, csrfHeaders),
      ),
      ...allTagIds.map((tagId) => addBookmarkToTag(tagId, created.id, csrfHeaders)),
    ]);
    return;
  }

  if (!payload.bookmarkId) {
    throw new Error("bookmarkId is required for edit");
  }

  await updateBookmark(payload.bookmarkId, body, csrfHeaders);
  await syncFolderMembership(
    payload.bookmarkId,
    allFolderIds,
    initial?.folderIds ?? [],
    csrfHeaders,
  );
  await syncTagMembership(
    payload.bookmarkId,
    allTagIds,
    initial?.tagIds ?? [],
    csrfHeaders,
  );
}

export type LoadBookmarkModalOptionsResult = {
  folders: BookmarkModalFolderOption[];
  tags: BookmarkModalTagOption[];
};

async function fetchFolders(): Promise<BookmarkModalFolderOption[]> {
  const res = await apiFetch(resolveClientApiPath("/folders?pageSize=100"));
  if (!res.ok) {
    throw new BookmarkModalLoadError(
      `Failed to load folders (HTTP ${String(res.status)})`,
    );
  }
  const body: unknown = await res.json();
  if (!isRecord(body) || !isFolderOptionArray(body.items)) {
    throw new BookmarkModalLoadError(
      "Unexpected response shape when loading folders",
    );
  }
  return body.items;
}

async function fetchTags(): Promise<BookmarkModalTagOption[]> {
  const res = await apiFetch(resolveClientApiPath("/tags?pageSize=100"));
  if (!res.ok) {
    throw new BookmarkModalLoadError(
      `Failed to load tags (HTTP ${String(res.status)})`,
    );
  }
  const body: unknown = await res.json();
  if (!isRecord(body) || !isTagOptionArray(body.items)) {
    throw new BookmarkModalLoadError(
      "Unexpected response shape when loading tags",
    );
  }
  return body.items;
}

export async function loadBookmarkModalOptions(): Promise<LoadBookmarkModalOptionsResult> {
  const [folders, tags] = await Promise.all([fetchFolders(), fetchTags()]);
  return { folders, tags };
}
