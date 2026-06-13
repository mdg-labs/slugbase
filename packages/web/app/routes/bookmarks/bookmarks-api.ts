import { resolveClientApiPath } from "../../lib/client-api-path.js";
import { apiFetch } from "../../lib/client-api-fetch.js";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    csrf: true,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = "Request failed";
    try {
      const data = (await res.json()) as { message?: string };
      if (data.message) message = data.message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function deleteJson(path: string): Promise<void> {
  const res = await apiFetch(path, { method: "DELETE", csrf: true });
  if (!res.ok) {
    throw new Error("Delete failed");
  }
}

export type BulkResult = {
  processed: number;
  skipped: number;
  skippedIds: string[];
};

export async function bulkDeleteBookmarks(ids: string[]): Promise<BulkResult> {
  return postJson<BulkResult>("/bookmarks/bulk/delete", { bookmarkIds: ids });
}

export async function bulkPinBookmarks(
  ids: string[],
  pinned: boolean,
): Promise<BulkResult> {
  return postJson<BulkResult>("/bookmarks/bulk/pin", {
    bookmarkIds: ids,
    pinned,
  });
}

export async function bulkMoveToFolder(
  ids: string[],
  folderId: string,
): Promise<BulkResult> {
  return postJson<BulkResult>("/bookmarks/bulk/move-to-folder", {
    bookmarkIds: ids,
    folderId,
  });
}

export async function bulkAddTags(
  ids: string[],
  tagIds: string[],
): Promise<BulkResult> {
  return postJson<BulkResult>("/bookmarks/bulk/add-tags", {
    bookmarkIds: ids,
    tagIds,
  });
}

export async function bulkRemoveTags(
  ids: string[],
  tagIds: string[],
): Promise<BulkResult> {
  return postJson<BulkResult>("/bookmarks/bulk/remove-tags", {
    bookmarkIds: ids,
    tagIds,
  });
}

export async function toggleBookmarkPin(
  id: string,
  pinned: boolean,
): Promise<void> {
  await postJson(`/bookmarks/${id}/pin`, { pinned });
}

export async function deleteBookmark(id: string): Promise<void> {
  await deleteJson(resolveClientApiPath(`/bookmarks/${id}`));
}

export type ToolbarOption = { id: string; name: string };

export async function loadToolbarOptions(): Promise<{
  folders: ToolbarOption[];
  tags: ToolbarOption[];
}> {
  const [foldersRes, tagsRes] = await Promise.all([
    apiFetch(resolveClientApiPath("/folders?pageSize=100")),
    apiFetch(resolveClientApiPath("/tags?pageSize=100")),
  ]);

  const foldersData = foldersRes.ok
    ? ((await foldersRes.json()) as { items: ToolbarOption[] })
    : { items: [] };
  const tagsData = tagsRes.ok
    ? ((await tagsRes.json()) as { items: ToolbarOption[] })
    : { items: [] };

  return {
    folders: foldersData.items,
    tags: tagsData.items,
  };
}
