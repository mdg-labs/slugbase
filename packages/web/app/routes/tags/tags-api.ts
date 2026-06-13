const getApiBaseUrl = (): string => {
  if (typeof process !== "undefined" && process.env.API_BASE_URL) {
    return process.env.API_BASE_URL;
  }
  if (typeof import.meta !== "undefined") {
    const viteUrl = import.meta.env.VITE_API_URL as string | undefined;
    if (viteUrl) return viteUrl;
  }
  return "";
};

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

export async function createTag(name: string, color?: string | null): Promise<void> {
  const headers = await getMutationHeaders();
  const body: Record<string, unknown> = { name };
  if (color) body.color = color;
  const res = await fetch(`${getApiBaseUrl()}/tags`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("failed");
}

export async function renameTag(id: string, name: string, color?: string | null): Promise<void> {
  const headers = await getMutationHeaders();
  const body: Record<string, unknown> = { name };
  if (color) body.color = color;
  const res = await fetch(`${getApiBaseUrl()}/tags/${id}`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("failed");
}

export async function deleteTag(id: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/tags/${id}`, {
    method: "DELETE",
    headers,
    credentials: "include",
  });
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
  const apiBase = getApiBaseUrl();
  const res = await fetch(
    `${apiBase}/api/bookmarks?tagIds=${encodeURIComponent(tagId)}&pageSize=200`,
    { credentials: "include" },
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
