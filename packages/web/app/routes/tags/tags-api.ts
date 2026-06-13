import { resolveClientApiPath } from "../../lib/client-api-path.js";
import { apiFetch } from "../../lib/client-api-fetch.js";

export async function createTag(name: string, color?: string | null): Promise<void> {
  const body: Record<string, unknown> = { name };
  if (color) body.color = color;
  const res = await apiFetch("/tags", {
    method: "POST",
    csrf: true,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("failed");
}

export async function renameTag(id: string, name: string, color?: string | null): Promise<void> {
  const body: Record<string, unknown> = { name };
  if (color) body.color = color;
  const res = await apiFetch(`/tags/${id}`, {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("failed");
}

export async function deleteTag(id: string): Promise<void> {
  const res = await apiFetch(`/tags/${id}`, { method: "DELETE", csrf: true });
  if (!res.ok) throw new Error("failed");
}

export type TaggedBookmark = {
  id: string;
  title: string;
  url: string;
  slug: string | null;
};

interface PaginatedBookmarks {
  items: TaggedBookmark[];
  total: number;
}

export async function fetchTaggedBookmarks(
  tagId: string,
): Promise<TaggedBookmark[]> {
  const res = await apiFetch(
    `${resolveClientApiPath("/bookmarks")}?tagIds=${encodeURIComponent(tagId)}&pageSize=200`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as PaginatedBookmarks;
  return data.items.map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    slug: item.slug,
  }));
}
