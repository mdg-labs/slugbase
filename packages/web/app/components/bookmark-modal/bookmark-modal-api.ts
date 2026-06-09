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

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

async function getMutationHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${getApiBaseUrl()}/auth/csrf-token`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to fetch CSRF token");
  }
  const data = (await res.json()) as { csrfToken: string };
  return {
    "Content-Type": "application/json",
    "x-csrf-token": data.csrfToken,
  };
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string };
    return data.message ?? "Request failed";
  } catch {
    return "Request failed";
  }
}

async function createBookmark(
  body: ReturnType<typeof toBookmarkSubmitBody>,
): Promise<{ id: string }> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/bookmarks`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as { id: string };
}

async function updateBookmark(
  bookmarkId: string,
  body: ReturnType<typeof toBookmarkSubmitBody>,
): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/bookmarks/${bookmarkId}`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

async function addBookmarkToFolder(folderId: string, bookmarkId: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/folders/${folderId}/bookmarks`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ bookmarkId }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

async function addBookmarkToTag(tagId: string, bookmarkId: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/tags/${tagId}/bookmarks`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ bookmarkId }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

async function createTag(name: string): Promise<{ id: string }> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/tags`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as { id: string };
}

async function createFolder(name: string): Promise<{ id: string }> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/folders`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as { id: string };
}

async function syncFolderMembership(
  bookmarkId: string,
  selectedFolderIds: string[],
  initialFolderIds: string[],
): Promise<void> {
  const toAdd = selectedFolderIds.filter((id) => !initialFolderIds.includes(id));
  await Promise.all(toAdd.map((folderId) => addBookmarkToFolder(folderId, bookmarkId)));
}

async function syncTagMembership(
  bookmarkId: string,
  selectedTagIds: string[],
  initialTagIds: string[],
): Promise<void> {
  const toAdd = selectedTagIds.filter((id) => !initialTagIds.includes(id));
  await Promise.all(toAdd.map((tagId) => addBookmarkToTag(tagId, bookmarkId)));
}

export async function submitBookmarkModal(
  payload: BookmarkModalSubmitPayload,
  initial?: BookmarkModalInitialBookmark,
): Promise<void> {
  const body = toBookmarkSubmitBody(payload);

  const newFolderIds = await Promise.all(
    payload.newFolderNames.map((name) => createFolder(name).then((f) => f.id)),
  );
  const allFolderIds = [...payload.folderIds, ...newFolderIds];

  const newTagIds = await Promise.all(
    payload.newTagNames.map((name) => createTag(name).then((t) => t.id)),
  );
  const allTagIds = [...payload.tagIds, ...newTagIds];

  if (payload.mode === "create") {
    const created = await createBookmark(body);
    await Promise.all([
      ...allFolderIds.map((folderId) =>
        addBookmarkToFolder(folderId, created.id),
      ),
      ...allTagIds.map((tagId) => addBookmarkToTag(tagId, created.id)),
    ]);
    return;
  }

  if (!payload.bookmarkId) {
    throw new Error("bookmarkId is required for edit");
  }

  await updateBookmark(payload.bookmarkId, body);
  await syncFolderMembership(
    payload.bookmarkId,
    allFolderIds,
    initial?.folderIds ?? [],
  );
  await syncTagMembership(payload.bookmarkId, allTagIds, initial?.tagIds ?? []);
}

export type LoadBookmarkModalOptionsResult = {
  folders: BookmarkModalFolderOption[];
  tags: BookmarkModalTagOption[];
};

async function fetchFolders(): Promise<BookmarkModalFolderOption[]> {
  const res = await fetch(`${getApiBaseUrl()}/folders?pageSize=100`, {
    credentials: "include",
  });
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
  const res = await fetch(`${getApiBaseUrl()}/tags?pageSize=100`, {
    credentials: "include",
  });
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
