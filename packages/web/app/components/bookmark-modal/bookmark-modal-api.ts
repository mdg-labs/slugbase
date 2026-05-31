import type {
  BookmarkModalFolderOption,
  BookmarkModalInitialBookmark,
  BookmarkModalSubmitPayload,
  BookmarkModalTagOption,
} from "./bookmark-modal.types.js";
import { toBookmarkSubmitBody } from "./bookmark-modal.validation.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

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
  const res = await fetch(`${getApiBaseUrl()}/bookmarks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  const res = await fetch(`${getApiBaseUrl()}/bookmarks/${bookmarkId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

async function addBookmarkToFolder(folderId: string, bookmarkId: string): Promise<void> {
  const res = await fetch(`${getApiBaseUrl()}/folders/${folderId}/bookmarks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ bookmarkId }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

async function addBookmarkToTag(tagId: string, bookmarkId: string): Promise<void> {
  const res = await fetch(`${getApiBaseUrl()}/tags/${tagId}/bookmarks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ bookmarkId }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
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

  if (payload.mode === "create") {
    const created = await createBookmark(body);
    await Promise.all([
      ...payload.folderIds.map((folderId) =>
        addBookmarkToFolder(folderId, created.id),
      ),
      ...payload.tagIds.map((tagId) => addBookmarkToTag(tagId, created.id)),
    ]);
    return;
  }

  if (!payload.bookmarkId) {
    throw new Error("bookmarkId is required for edit");
  }

  await updateBookmark(payload.bookmarkId, body);
  await syncFolderMembership(
    payload.bookmarkId,
    payload.folderIds,
    initial?.folderIds ?? [],
  );
  await syncTagMembership(payload.bookmarkId, payload.tagIds, initial?.tagIds ?? []);
}

export async function loadBookmarkModalOptions(): Promise<{
  folders: BookmarkModalFolderOption[];
  tags: BookmarkModalTagOption[];
}> {
  const [foldersRes, tagsRes] = await Promise.all([
    fetch(`${getApiBaseUrl()}/folders?pageSize=100`, {
      credentials: "include",
    }),
    fetch(`${getApiBaseUrl()}/tags?pageSize=100`, { credentials: "include" }),
  ]);

  if (!foldersRes.ok || !tagsRes.ok) {
    return { folders: [], tags: [] };
  }

  const foldersData = (await foldersRes.json()) as {
    items: BookmarkModalFolderOption[];
  };
  const tagsData = (await tagsRes.json()) as { items: BookmarkModalTagOption[] };

  return {
    folders: foldersData.items,
    tags: tagsData.items,
  };
}
