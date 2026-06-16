import { resolveClientApiPath } from "../../lib/client-api-path.js";
import { apiFetch } from "../../lib/client-api-fetch.js";
import type { BookmarkListItem } from "../bookmarks/bookmarks-loader.js";
import { PRIVATE_BOOKMARK_SHARING_SUMMARY } from "../bookmarks/bookmarks-loader.js";
import type { BookmarkSharingSummary } from "../../components/sharing/sharing-recipients.utils.js";

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

export type TaggedBookmark = BookmarkListItem;

interface ApiBookmark {
  id: string;
  userId: string;
  title: string;
  url: string;
  slug: string | null;
  forwardingEnabled: boolean;
  pinned: boolean;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string | null;
  sharingSummary?: BookmarkSharingSummary;
  folders: Array<{ id: string; name: string; color: string | null }>;
  tags: Array<{ id: string; name: string; color: string | null }>;
}

interface PaginatedBookmarks {
  items: ApiBookmark[];
  total: number;
}

function mapTaggedBookmark(item: ApiBookmark): TaggedBookmark {
  return {
    id: item.id,
    userId: item.userId,
    title: item.title,
    url: item.url,
    slug: item.slug,
    forwardingEnabled: item.forwardingEnabled,
    pinned: item.pinned,
    accessCount: item.accessCount,
    lastAccessedAt: item.lastAccessedAt,
    createdAt: item.createdAt ?? null,
    sharingSummary: item.sharingSummary ?? PRIVATE_BOOKMARK_SHARING_SUMMARY,
    folders: item.folders,
    tags: item.tags,
  };
}

export async function fetchTaggedBookmarks(
  tagId: string,
): Promise<TaggedBookmark[]> {
  const res = await apiFetch(
    `${resolveClientApiPath("/bookmarks")}?tagIds=${encodeURIComponent(tagId)}&pageSize=200`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as PaginatedBookmarks;
  return data.items.map(mapTaggedBookmark);
}
